import { ProofRelayError } from "@proofrelay/schemas";
import { LlmComputeAdapter } from "./llm.js";
import { PIPELINE_VERSION } from "./local.js";
import type {
  ClaimExtractionInput,
  ClaimScoringResult,
  ComputeAdapter,
  ComputeResult,
  DependencyHealth,
  EvidenceScoringInput,
  ExtractedClaim,
} from "./types.js";

/**
 * 0G Compute over the direct broker path: no API key, no account at pc.0g.ai.
 *
 * The router authenticates with an `sk-` credential issued to a person. This
 * authenticates with a *wallet signature*: the SDK signs billing headers per
 * request, and those headers are themselves the settlement proof the provider
 * later redeems on chain. That matters here beyond convenience — a ProofRelay
 * verifier already is an on-chain identity with a key, so paying for its own
 * inference out of its own ledger makes the compute spend part of that identity
 * rather than a shared secret every operator has to be handed.
 *
 * What it costs: the direct registry lists fewer models than the router does
 * (12 against 32 on mainnet when this was written). `listService()` is the
 * authority on what is reachable — never this comment.
 */

export interface ZeroGBrokerOptions {
  /** Funds the ledger and signs every request. Never leaves this process. */
  privateKey: string;
  rpcUrl: string;
  /** Which model to look for in the on-chain registry. */
  model: string;
  /** Pin one provider instead of taking the first that serves `model`. */
  providerAddress?: string | undefined;
  evidenceDepth: number;
  supportThreshold: number;
  timeoutMs: number;
  maxAttempts: number;
  seed?: number | undefined;
  verifyTee?: boolean | undefined;
  requireParameters?: boolean | undefined;
  /** Injected by the tests; production resolves the real SDK. */
  loadSdk?: (() => Promise<BrokerSdk>) | undefined;
}

/** The slice of `@0gfoundation/0g-compute-ts-sdk` this adapter actually uses. */
export interface BrokerSdk {
  listService(): Promise<{ provider: string; model?: string; url?: string }[]>;
  acknowledgeProviderSigner(provider: string): Promise<void>;
  getServiceMetadata(provider: string): Promise<{ endpoint: string; model: string }>;
  getRequestHeaders(provider: string): Promise<Record<string, string>>;
}

interface Session {
  provider: string;
  inner: LlmComputeAdapter;
}

/**
 * A `ComputeAdapter` that resolves its endpoint from the chain, once.
 *
 * `createComputeAdapter` is synchronous and three call sites depend on that,
 * while every step here — building the broker, reading the registry,
 * acknowledging the provider — is async, and acknowledgement is a transaction
 * that costs gas. So this wraps `LlmComputeAdapter` rather than changing it:
 * the endpoint and model arrive from `getServiceMetadata`, and the inner
 * adapter is built on first use. Nothing touches the chain for a process that
 * never scores a claim.
 */
export class ZeroGBrokerAdapter implements ComputeAdapter {
  readonly driver = "zerog-broker";
  readonly pipelineVersion = PIPELINE_VERSION;
  private readonly options: ZeroGBrokerOptions;
  private sdk: Promise<BrokerSdk> | null = null;
  private session: Promise<Session> | null = null;

  constructor(options: ZeroGBrokerOptions) {
    this.options = options;
  }

  /**
   * The model asked for, not the one the registry answered with.
   *
   * This has to be readable before any network call, and it is what a report
   * trace records as `modelId`. The two agree whenever resolution succeeds,
   * because resolution only accepts a provider that serves this model.
   */
  get modelId(): string {
    return `${this.driver}/${this.options.model}`;
  }

  async runClaimExtraction(input: ClaimExtractionInput): Promise<ComputeResult<ExtractedClaim[]>> {
    return (await this.resolve()).inner.runClaimExtraction(input);
  }

  async scoreEvidence(input: EvidenceScoringInput): Promise<ComputeResult<ClaimScoringResult[]>> {
    return (await this.resolve()).inner.scoreEvidence(input);
  }

  /**
   * Resolving the session IS the health check.
   *
   * The inner adapter probes `GET /models`, which is a router route — a direct
   * provider endpoint does not serve it, so delegating would report every
   * healthy broker as down. Reaching the registry, finding a provider for the
   * configured model and acknowledging it exercises the chain, the SDK and the
   * provider record, which is what this path actually depends on.
   */
  async health(): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      const session = await this.resolve();
      return {
        ok: true,
        detail: `${this.options.model} via ${session.provider}`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      };
    }
  }

  private async broker(): Promise<BrokerSdk> {
    if (!this.sdk) {
      // Cleared on failure rather than kept as a rejected promise: a broker that
      // could not be built because the RPC was down must not poison every later
      // request for the life of the process.
      this.sdk = (this.options.loadSdk ?? defaultLoadSdk(this.options))().catch((error: unknown) => {
        this.sdk = null;
        throw error;
      });
    }
    return this.sdk;
  }

  private async resolve(): Promise<Session> {
    if (!this.session) {
      this.session = this.resolveOnce().catch((error: unknown) => {
        this.session = null;
        throw error;
      });
    }
    return this.session;
  }

  private async resolveOnce(): Promise<Session> {
    const sdk = await this.broker();
    const services = await sdk.listService();
    const pinned = this.options.providerAddress?.toLowerCase();
    const match = pinned
      ? services.find((service) => service.provider.toLowerCase() === pinned)
      : services.find((service) => matchesModel(service.model, this.options.model));

    if (!match) {
      // Naming what IS on offer: the registry is the only authority on that, and
      // a caller who asked for an unavailable model has no other way to find out
      // which ones exist.
      const offered = services.map((service) => service.model ?? "?").join(", ") || "none";
      throw new ProofRelayError(
        "COMPUTE_UNAVAILABLE",
        pinned
          ? `no provider ${this.options.providerAddress} in the 0G Compute registry`
          : `no provider serves ${this.options.model} on this network`,
        { detail: { requested: this.options.model, offered }, retryable: false },
      );
    }

    await sdk.acknowledgeProviderSigner(match.provider);
    const metadata = await sdk.getServiceMetadata(match.provider);

    const inner = new LlmComputeAdapter({
      driver: this.driver,
      baseUrl: metadata.endpoint.replace(/\/+$/, ""),
      model: metadata.model,
      evidenceDepth: this.options.evidenceDepth,
      supportThreshold: this.options.supportThreshold,
      timeoutMs: this.options.timeoutMs,
      maxAttempts: this.options.maxAttempts,
      seed: this.options.seed,
      verifyTee: this.options.verifyTee,
      requireParameters: this.options.requireParameters,
      providerAddress: match.provider,
      // Fresh headers per request. They carry a nonce and a signature and are
      // single-use: the provider redeems them as a settlement proof, so a
      // replayed one is a double-spend it rejects. Caching would break the
      // second request rather than the first — the kind of bug that only shows
      // up under load.
      headers: () => sdk.getRequestHeaders(match.provider),
    });
    return { provider: match.provider, inner };
  }
}

/**
 * Loaded on demand, never at import time.
 *
 * The SDK pulls in ethers and roughly 280 transitive packages. Every process in
 * this repo builds a compute adapter and all but this one has no use for any of
 * it — a static import would put that cost on the API server, which runs the
 * local engine.
 */
function defaultLoadSdk(options: ZeroGBrokerOptions): () => Promise<BrokerSdk> {
  return async () => {
    const [{ ethers }, sdk] = await Promise.all([
      import("ethers"),
      import("@0gfoundation/0g-compute-ts-sdk"),
    ]);
    const wallet = new ethers.Wallet(options.privateKey, new ethers.JsonRpcProvider(options.rpcUrl));
    // One ethers on disk, two type surfaces: the dynamic import resolves to the
    // ESM build while the SDK's declarations name the CommonJS one, so TS sees
    // two `Wallet` classes with private fields it cannot reconcile. There is no
    // runtime mismatch to fix — `npm dedupe` leaves a single copy — so the cast
    // states that rather than restructuring the import around a typing artifact.
    const broker = await sdk.createZGComputeNetworkBroker(wallet as unknown as Parameters<typeof sdk.createZGComputeNetworkBroker>[0]);
    return broker.inference as unknown as BrokerSdk;
  };
}

/**
 * The registry names models the way a provider publishes them
 * (`qwen/qwen2.5-omni-7b`); configuration names them the way a person types
 * them (`qwen2.5-omni`). Accepting either spelling keeps both working without a
 * lookup table that goes stale the moment a provider is added.
 */
function matchesModel(offered: string | undefined, wanted: string): boolean {
  if (!offered) return false;
  const a = offered.toLowerCase();
  const b = wanted.toLowerCase();
  return a === b || a.split("/").pop() === b || a.includes(b);
}
