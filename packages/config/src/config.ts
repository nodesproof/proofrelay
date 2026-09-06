import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { networkInfo } from "@proofrelay/chain-client";
import { env, envBigInt, envBool, envInt, envList, loadEnv, repoRoot, requireEnv, resolvedFrom } from "./env.js";

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  contract: Address;
  deployBlock: number;
  confirmations: number;
  explorer: string;
  network: string;
  /** Nominal seconds per block for this chain; see NetworkInfo.blockSeconds. */
  blockSeconds: number;
}

export interface StorageConfig {
  driver: "local" | "zerog";
  root: string;
  indexerRpc: string;
  privateKey: Hex | undefined;
  rpcUrl: string;
  gateways: string[];
  explorer: string;
  /** Refuse a stored object larger than this instead of materialising it. */
  maxObjectBytes: number;
  /** Deadline for a download or health probe against 0G Storage. */
  readTimeoutMs: number;
  /** Deadline for an upload, which waits on storage finality. */
  uploadTimeoutMs: number;
}

export interface ComputeConfig {
  driver: "local" | "zerog-router" | "zerog-broker" | "openai-compatible";
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  privateKey: Hex | undefined;
  /** Chain RPC. The broker driver signs ledger transactions and reads the
   *  provider registry through it; the router driver never touches it. */
  rpcUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  maxTokens: number;
  seed: number;
  verifyTee: boolean;
  trustMode: string | undefined;
  requireParameters: boolean;
  providerAddress: string | undefined;
}

/**
 * The router is per-network and the two catalogs do not overlap. Galileo
 * (16602) is served by a third-party host — `router-api-testnet.0g.ai` does not
 * resolve, so do not "correct" this to look tidier. Mainnet's router carries a
 * different, much larger model list, and a key issued on one network is
 * rejected by the other.
 *
 * The mainnet model is `deepseek-v4-flash` and NOT the larger `glm-5.2`, for a
 * reason that is easy to undo by accident: every provider serving glm-5.2 on
 * mainnet advertises `temperature` but not `seed`. This pipeline sends a seed
 * on every completion and sets `X-0G-Provider-Require-Parameters`, so a model
 * no provider can seed is refused rather than silently served
 * non-reproducibly. `deepseek-v4-flash` is seedable, TEE-attested, and carried
 * by six providers — the widest redundancy in the catalog. Read
 * `GET /v1/providers` (public, no key) before changing it: the field to check
 * is `supported_parameters` containing "seed".
 */
const COMPUTE_ROUTERS: Record<number, { baseUrl: string; model: string; console: string }> = {
  16602: {
    baseUrl: "https://router-api-testnet.integratenetwork.work/v1",
    model: "qwen2.5-omni",
    console: "https://pc.testnet.0g.ai",
  },
  16661: {
    baseUrl: "https://router-api.0g.ai/v1",
    model: "deepseek-v4-flash",
    console: "https://pc.0g.ai",
  },
};

export function computeRouterFor(chainId: number) {
  return COMPUTE_ROUTERS[chainId] ?? COMPUTE_ROUTERS[16602]!;
}

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  logLevel: string;
  sessionTtlSec: number;
  rateLimitMax: number;
  /** Per-IP budget for the routes that spend the operator's funds. */
  spendRateLimitMax: number;
  rateLimitWindowMs: number;
  producerId: string;
  bodyLimitBytes: number;
  domain: string;
  /**
   * How many reverse proxies sit in front of this API. 0 — the safe default —
   * means trust nobody: `request.ip` is the socket peer. Setting it above 0
   * where there is no proxy lets any client forge X-Forwarded-For and walk out
   * of its own rate-limit bucket.
   */
  trustProxyHops: number;
}

export interface FetchConfig {
  maxBytes: number;
  timeoutMs: number;
  allowPrivate: boolean;
  maxRedirects: number;
}

export interface IndexerConfig {
  enabled: boolean;
  pollMs: number;
  confirmations: number;
  startBlock: number;
  batchSize: number;
}

export interface OrchestratorConfig {
  enabled: boolean;
  pollMs: number;
  keeperPrivateKey: Hex | undefined;
  adjudicatorPrivateKey: Hex | undefined;
}

/**
 * The free first task.
 *
 * `createTask` takes no privileged caller — it is `external payable` and sets
 * `t.creator = msg.sender` — so a sponsored task needs no contract change at
 * all, only a funded key that signs one on somebody else's behalf. What it does
 * need is a bound, because that key is spending real 0G with no user paying for
 * it: `maxPerAddress` stops casual repeat use and `maxTotal` is the number that
 * actually caps the programme. A signed-in wallet is not a scarce identity —
 * `app.ts` says so about rate limiting, and it is just as true here — so the
 * global cap is the only limit that holds against someone generating keypairs.
 *
 * Disabled unless SPONSOR_PRIVATE_KEY is set, and the key must be its own: a
 * sponsor that shares an address with the keeper or the deployer breaks the
 * separation `npm run roles` audits, and the nonce prediction below assumes
 * this process is the only sender from it.
 */
export interface SponsorConfig {
  enabled: boolean;
  privateKey: Hex | undefined;
  /** What every sponsored task escrows. Fixed, so a caller cannot name it. */
  bountyWei: bigint;
  maxPerAddress: number;
  maxTotal: number;
  /** Refuse a grant that would leave the sponsor unable to pay gas for the next. */
  minBalanceWei: bigint;
  /**
   * How long a reservation with no receipt keeps holding its slot. Long on
   * purpose: a shorter window would hand the slot back while a broadcast that
   * has already been signed is still landing, and the sponsor would pay twice.
   */
  reservationTtlSec: number;
}

export interface VerifierProfile {
  id: string;
  profile: string;
  privateKey: Hex;
  /** How many evidence spans the profile keeps per claim. */
  evidenceDepth: number;
  /** Entailment score above which a span counts as support. */
  supportThreshold: number;
  pollMs: number;
}

export interface Config {
  root: string;
  chain: ChainConfig;
  storage: StorageConfig;
  compute: ComputeConfig;
  api: ApiConfig;
  fetch: FetchConfig;
  indexer: IndexerConfig;
  orchestrator: OrchestratorConfig;
  sponsor: SponsorConfig;
  version: string;
}

function asHex(value: string | undefined): Hex | undefined {
  if (!value) return undefined;
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

export function loadConfig(): Config {
  loadEnv();
  const root = repoRoot();
  const chainId = envInt("CHAIN_ID", 16602);
  const info = networkInfo(chainId);
  const contract = (env("PROOFRELAY_ADDRESS") ?? "0x0000000000000000000000000000000000000000") as Address;
  const deployBlock = envInt("PROOFRELAY_DEPLOY_BLOCK", 0);

  return {
    root,
    version: "1.0.0",
    chain: {
      chainId,
      rpcUrl: env("OG_RPC_URL") ?? info.rpcUrl,
      contract,
      deployBlock,
      confirmations: envInt("INDEXER_CONFIRMATIONS", 2),
      explorer: info.explorer,
      network: info.name,
      blockSeconds: envInt("CHAIN_BLOCK_SECONDS", info.blockSeconds),
    },
    storage: {
      driver: (env("STORAGE_DRIVER") ?? "local") as StorageConfig["driver"],
      root: resolve(root, env("STORAGE_ROOT") ?? ".proofrelay/storage"),
      indexerRpc: env("STORAGE_INDEXER_RPC") ?? info.storageIndexer,
      privateKey: asHex(env("STORAGE_PRIVATE_KEY")),
      rpcUrl: env("OG_RPC_URL") ?? info.rpcUrl,
      gateways: envList("STORAGE_GATEWAYS"),
      explorer: info.storageExplorer,
      maxObjectBytes: envInt("STORAGE_MAX_OBJECT_BYTES", 8 * 1024 * 1024),
      readTimeoutMs: envInt("STORAGE_READ_TIMEOUT_MS", 30_000),
      uploadTimeoutMs: envInt("STORAGE_UPLOAD_TIMEOUT_MS", 180_000),
    },
    compute: {
      driver: (env("COMPUTE_DRIVER") ?? "local") as ComputeConfig["driver"],
      baseUrl: env("COMPUTE_BASE_URL") ?? computeRouterFor(chainId).baseUrl,
      apiKey: env("COMPUTE_API_KEY"),
      model: env("COMPUTE_MODEL") ?? computeRouterFor(chainId).model,
      privateKey: asHex(env("COMPUTE_PRIVATE_KEY")),
      rpcUrl: env("OG_RPC_URL") ?? info.rpcUrl,
      // verify_tee makes the router hold the connection while it checks the
      // provider's attestation, on top of generation time.
      timeoutMs: envInt("COMPUTE_TIMEOUT_MS", 90_000),
      maxAttempts: envInt("COMPUTE_MAX_ATTEMPTS", 3),
      // Bounds reasoning and answer together, so a thinking model needs far
      // more than a direct one. See COMPUTE_MAX_TOKENS in the standalone
      // example for the measurement behind this default.
      maxTokens: envInt("COMPUTE_MAX_TOKENS", 2048),
      seed: envInt("COMPUTE_SEED", 1337),
      verifyTee: envBool("COMPUTE_VERIFY_TEE", true),
      trustMode: env("COMPUTE_TRUST_MODE") ?? "verified",
      requireParameters: envBool("COMPUTE_REQUIRE_PARAMETERS", true),
      providerAddress: env("COMPUTE_PROVIDER_ADDRESS"),
    },
    api: {
      host: env("API_HOST") ?? "0.0.0.0",
      port: envInt("API_PORT", 8080),
      databaseUrl: env("DATABASE_URL") ?? "postgres://proofrelay:proofrelay@localhost:5432/proofrelay",
      corsOrigins: envList("CORS_ORIGINS", ["http://localhost:5173", "http://localhost:3000"]),
      logLevel: env("LOG_LEVEL") ?? "info",
      sessionTtlSec: envInt("SESSION_TTL_SEC", 3600),
      // A single browser session polls health, stats, tasks, artifacts and
      // activity; with the UI, the seed script and curl all arriving from
      // 127.0.0.1 during a demo, 120/min is exhausted in under a minute and
      // the UI sits on skeletons while the API reports itself healthy.
      rateLimitMax: envInt("RATE_LIMIT_MAX", 600),
      // The two routes that spend the operator's own 0G get their own, far
      // tighter budget: `prepare` writes one object to 0G Storage per source
      // plus the manifest — up to 21 uploads — and needs no session.
      spendRateLimitMax: envInt("SPEND_RATE_LIMIT_MAX", 10),
      rateLimitWindowMs: envInt("RATE_LIMIT_WINDOW_MS", 60_000),
      producerId: env("PRODUCER_ID") ?? "proofrelay-api/1.0.0",
      bodyLimitBytes: envInt("API_BODY_LIMIT", 2 * 1024 * 1024),
      domain: env("API_DOMAIN") ?? "proofrelay.local",
      trustProxyHops: envInt("TRUST_PROXY_HOPS", 0),
    },
    fetch: {
      maxBytes: envInt("FETCH_MAX_BYTES", 524_288),
      timeoutMs: envInt("FETCH_TIMEOUT_MS", 15_000),
      // `=== "1"` exactly, not envBool's looser truthiness. The fetcher's own
      // parser has always been the strict one, so the two disagreed: a value
      // like "true" or "yes" relaxed the SSRF guard through the config path
      // while the comment and the test both said only "1" does. One parser,
      // and it is the conservative one.
      allowPrivate: env("FETCH_ALLOW_PRIVATE") === "1",
      maxRedirects: envInt("FETCH_MAX_REDIRECTS", 3),
    },
    indexer: {
      enabled: envBool("INDEXER_ENABLED", true),
      pollMs: envInt("INDEXER_POLL_MS", 2_000),
      confirmations: envInt("INDEXER_CONFIRMATIONS", 2),
      // Never earlier than the deploy block: there are no events before it, and
      // a shipped `INDEXER_START_BLOCK=0` used to win outright and stop the API
      // from starting at all. Max keeps a deliberate later start working.
      startBlock: Math.max(envInt("INDEXER_START_BLOCK", 0), deployBlock),
      batchSize: envInt("INDEXER_BATCH_SIZE", 2_000),
    },
    orchestrator: {
      enabled: envBool("ORCHESTRATOR_ENABLED", true),
      pollMs: envInt("ORCHESTRATOR_POLL_MS", 1_500),
      keeperPrivateKey: asHex(env("KEEPER_PRIVATE_KEY")),
      adjudicatorPrivateKey: asHex(env("ADJUDICATOR_PRIVATE_KEY")),
    },
    sponsor: {
      // Having the key is not the same as wanting to spend it. Both are needed,
      // and the key alone is not enough to start giving 0G away.
      enabled: envBool("SPONSOR_ENABLED", false) && Boolean(env("SPONSOR_PRIVATE_KEY")),
      privateKey: asHex(env("SPONSOR_PRIVATE_KEY")),
      // 0.002 0G — what `npm run seed` posts, and above the deployed contract's
      // minBounty. `assertSponsorBounty` checks that against the live chain at
      // boot rather than trusting this default to still clear it.
      bountyWei: envBigInt("SPONSOR_BOUNTY_WEI", 2_000_000_000_000_000n),
      maxPerAddress: envInt("SPONSOR_MAX_PER_ADDRESS", 1),
      maxTotal: envInt("SPONSOR_MAX_TOTAL", 100),
      // 0.05 0G: enough gas for many more createTask calls at 0.001 each, so
      // the programme stops on a number an operator chose rather than on a
      // failed transaction.
      minBalanceWei: envBigInt("SPONSOR_MIN_BALANCE_WEI", 50_000_000_000_000_000n),
      reservationTtlSec: envInt("SPONSOR_RESERVATION_TTL_SEC", 3_600),
    },
  };
}

/**
 * Refuse to start rather than scan 52 million blocks. On a public chain an
 * unset deploy block means the indexer would begin at genesis, which never
 * finishes — the deployment doc calls this out explicitly.
 */
export function assertIndexerStartBlock(config: Config): void {
  const local = config.chain.chainId === 31337;
  if (!local && config.indexer.startBlock <= 0) {
    // Name both inputs and where each came from. Reporting only one of them
    // sends an operator to edit a variable that is already correct.
    throw new Error(
      `The indexer would start at block 0 on chain ${config.chain.chainId} and scan from genesis. ` +
        `PROOFRELAY_DEPLOY_BLOCK=${env("PROOFRELAY_DEPLOY_BLOCK") ?? "(unset)"} ` +
        `(from ${resolvedFrom("PROOFRELAY_DEPLOY_BLOCK")}), ` +
        `INDEXER_START_BLOCK=${env("INDEXER_START_BLOCK") ?? "(unset)"} ` +
        `(from ${resolvedFrom("INDEXER_START_BLOCK")}). ` +
        "Set PROOFRELAY_DEPLOY_BLOCK to the block the contract was deployed in.",
    );
  }
}

export function assertContractConfigured(config: Config): void {
  if (/^0x0+$/.test(config.chain.contract)) {
    throw new Error(
      `PROOFRELAY_ADDRESS is not set (resolved from ${resolvedFrom("PROOFRELAY_ADDRESS")}). ` +
        "Run `npm run deploy:galileo` or point it at an existing deployment.",
    );
  }
}

/** The one-line banner every service prints, so a wrong chain is visible immediately. */
export function describeConfig(config: Config): string {
  return [
    `chain=${config.chain.chainId} (${config.chain.network}) from ${resolvedFrom("CHAIN_ID")}`,
    `contract=${config.chain.contract} from ${resolvedFrom("PROOFRELAY_ADDRESS")}`,
    `deployBlock=${config.chain.deployBlock}`,
    `storage=${config.storage.driver}`,
    `compute=${config.compute.driver}`,
    `sponsor=${config.sponsor.enabled ? `on (${config.sponsor.maxTotal} max)` : "off"}`,
  ].join("  ");
}

export function verifierProfile(profile = env("VERIFIER_PROFILE") ?? "a"): VerifierProfile {
  const key = profile.toUpperCase();
  const keyVar = `VERIFIER_${key}_PRIVATE_KEY`;
  // Name the coupling in the message. The profile is spliced into this
  // variable's name, so an operator who renames the profile to something
  // meaningful — and the example invites that — gets told a variable they
  // never wrote is missing, with nothing pointing back at the rename.
  if (!env(keyVar)) {
    throw new Error(
      `${keyVar} is not set. VERIFIER_PROFILE=${profile} chose that name: the profile is ` +
        `spliced into it, so renaming the profile renames the key variable, ` +
        `VERIFIER_${key}_EVIDENCE_DEPTH and VERIFIER_${key}_SUPPORT_THRESHOLD with it.`,
    );
  }
  const privateKey = asHex(requireEnv(keyVar));
  if (!privateKey) throw new Error(`${keyVar} is not a hex private key`);

  // Deliberately different pipelines, so agreement means independent
  // configurations reached the same verdict rather than one pipeline run four
  // times. No two profiles share a (depth, threshold) pair, and C and D also
  // run a different model — see COMPUTE_MODEL in their .env.verifier-<x>.
  const presets: Record<string, { evidenceDepth: number; supportThreshold: number }> = {
    A: { evidenceDepth: 2, supportThreshold: 0.55 },
    B: { evidenceDepth: 3, supportThreshold: 0.5 },
    C: { evidenceDepth: 3, supportThreshold: 0.6 },
    D: { evidenceDepth: 2, supportThreshold: 0.48 },
  };
  const preset = presets[key] ?? { evidenceDepth: 2, supportThreshold: 0.55 };

  return {
    id: `verifier-${profile.toLowerCase()}`,
    profile: key,
    privateKey,
    evidenceDepth: envInt(`VERIFIER_${key}_EVIDENCE_DEPTH`, preset.evidenceDepth),
    supportThreshold: Number(env(`VERIFIER_${key}_SUPPORT_THRESHOLD`) ?? preset.supportThreshold),
    pollMs: envInt("VERIFIER_POLL_MS", 3_000),
  };
}

export { env, envBool, envInt, envList, loadEnv, repoRoot, requireEnv, resolvedFrom };
