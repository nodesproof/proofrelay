import { afterEach, describe, expect, it, vi } from "vitest";
import { ZeroGBrokerAdapter } from "./broker.js";
import type { BrokerSdk, ZeroGBrokerOptions } from "./broker.js";
import type { EvidenceScoringInput } from "./types.js";

const PROVIDER = "0xa48f01287233509FD694a22Bf840225062E67836";
const ENDPOINT = "https://compute-network-6.integratenetwork.work";

const INPUT: EvidenceScoringInput = {
  claims: [{ claimId: "claim-001", claimText: "The release bumps its dependencies." }],
  corpus: [
    {
      sourceId: "src-001",
      uri: "https://example.org/CHANGELOG.md",
      text: "The maintenance release bumps its dependencies and fixes a typo.",
    },
  ],
  evidenceDepth: 2,
  supportThreshold: 0.55,
};

/** Records every SDK call so a test can assert on how often each one ran. */
function fakeSdk(overrides: Partial<BrokerSdk> & { services?: { provider: string; model?: string }[] } = {}) {
  const calls = { list: 0, acknowledge: 0, metadata: 0, headers: 0 };
  const services = overrides.services ?? [{ provider: PROVIDER, model: "qwen/qwen2.5-omni-7b" }];
  const sdk: BrokerSdk = {
    async listService() {
      calls.list += 1;
      return services;
    },
    async acknowledgeProviderSigner() {
      calls.acknowledge += 1;
    },
    async getServiceMetadata() {
      calls.metadata += 1;
      return { endpoint: ENDPOINT, model: "qwen/qwen2.5-omni-7b" };
    },
    async getRequestHeaders() {
      calls.headers += 1;
      // A real header set carries a nonce and a signature; what matters here is
      // that a fresh one is minted per request.
      return { "X-Phala-Signature-Type": "StandaloneApi", Nonce: `n-${calls.headers}` };
    },
    ...overrides,
  };
  return { sdk, calls, services };
}

function options(over: Partial<ZeroGBrokerOptions> = {}): ZeroGBrokerOptions {
  return {
    privateKey: `0x${"11".repeat(32)}`,
    rpcUrl: "https://evmrpc-testnet.0g.invalid",
    model: "qwen2.5-omni",
    evidenceDepth: 2,
    supportThreshold: 0.55,
    timeoutMs: 5_000,
    maxAttempts: 1,
    ...over,
  };
}

/** Answers the provider endpoint, and records the headers it was sent. */
function providerReturning(): { sent: Record<string, string>[]; urls: string[] } {
  const sent: Record<string, string>[] = [];
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(String(url));
    sent.push(init.headers);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [
                    {
                      claimId: "claim-001",
                      verdict: "SUPPORTED",
                      confidence: 0.9,
                      // Required, and previously absent. The driver refuses an
                      // asserting verdict that cites nothing, so without this
                      // the claim fell to the offline scorer — which happened
                      // to return SUPPORTED too, leaving these tests green
                      // while never once exercising the model path they name.
                      spanIndexes: [0],
                      reasoning: "stated directly",
                      sources: [{ sourceId: "src-001", quotedSpan: "bumps its dependencies" }],
                    },
                  ],
                }),
              },
            },
          ],
        };
      },
      async text() {
        return "";
      },
    } as unknown as Response;
  });
  return { sent, urls };
}

afterEach(() => vi.unstubAllGlobals());

describe("ZeroGBrokerAdapter", () => {
  /**
   * The whole point of this driver: no `sk-` credential anywhere. The wallet
   * signature in the headers is the credential.
   */
  it("scores evidence against the provider endpoint with signed headers and no API key", async () => {
    const { sdk } = fakeSdk();
    const { sent, urls } = providerReturning();
    const adapter = new ZeroGBrokerAdapter(options({ loadSdk: async () => sdk }));

    const result = await adapter.scoreEvidence(INPUT);

    expect(result.value[0]?.verdict).toBe("SUPPORTED");
    expect(urls[0]).toBe(`${ENDPOINT}/chat/completions`);
    expect(sent[0]?.["Nonce"]).toBe("n-1");
    expect(Object.keys(sent[0] ?? {}).some((name) => name.toLowerCase() === "authorization")).toBe(false);
  });

  /**
   * Billing headers are a settlement proof the provider redeems, so replaying
   * one is a double-spend it rejects. Caching would break the second request,
   * not the first.
   */
  it("mints fresh headers for every request", async () => {
    const { sdk, calls } = fakeSdk();
    const { sent } = providerReturning();
    const adapter = new ZeroGBrokerAdapter(options({ loadSdk: async () => sdk }));

    await adapter.scoreEvidence(INPUT);
    await adapter.scoreEvidence(INPUT);

    expect(calls.headers).toBe(2);
    expect(sent[0]?.["Nonce"]).not.toBe(sent[1]?.["Nonce"]);
  });

  /** Acknowledgement is a transaction. Paying for it twice is paying for nothing. */
  it("acknowledges the provider once across many requests", async () => {
    const { sdk, calls } = fakeSdk();
    providerReturning();
    const adapter = new ZeroGBrokerAdapter(options({ loadSdk: async () => sdk }));

    await adapter.scoreEvidence(INPUT);
    await adapter.scoreEvidence(INPUT);
    await adapter.scoreEvidence(INPUT);

    expect(calls.acknowledge).toBe(1);
    expect(calls.list).toBe(1);
    expect(calls.metadata).toBe(1);
  });

  /**
   * The registry publishes `qwen/qwen2.5-omni-7b`; an operator types
   * `qwen2.5-omni`. Both have to find the same provider.
   */
  it("matches a registry model by its vendor-prefixed name", async () => {
    const { sdk } = fakeSdk({ services: [{ provider: PROVIDER, model: "qwen/qwen2.5-omni-7b" }] });
    providerReturning();
    const adapter = new ZeroGBrokerAdapter(options({ model: "qwen2.5-omni", loadSdk: async () => sdk }));
    await expect(adapter.scoreEvidence(INPUT)).resolves.toBeDefined();
  });

  /** A pinned provider is used even when another one serves the same model. */
  it("honours a pinned provider address", async () => {
    const other = "0x4b2a941929E39Adbea5316dDF2B9Bd8Ff3134389";
    const { sdk } = fakeSdk({
      services: [
        { provider: other, model: "qwen/qwen2.5-omni-7b" },
        { provider: PROVIDER, model: "qwen/qwen2.5-omni-7b" },
      ],
    });
    providerReturning();
    const adapter = new ZeroGBrokerAdapter(options({ providerAddress: PROVIDER, loadSdk: async () => sdk }));
    const health = await adapter.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain(PROVIDER);
  });

  /**
   * The registry is the only authority on what exists, so a refusal has to name
   * what it does offer — otherwise the operator has nowhere to look.
   */
  it("refuses a model no provider serves, naming the ones that exist", async () => {
    const { sdk } = fakeSdk({ services: [{ provider: PROVIDER, model: "qwen/qwen-image-edit-2511" }] });
    const adapter = new ZeroGBrokerAdapter(options({ model: "claude-opus-5", loadSdk: async () => sdk }));

    const health = await adapter.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("claude-opus-5");
    await expect(adapter.scoreEvidence(INPUT)).rejects.toThrow(/no provider serves claude-opus-5/);
  });

  /**
   * A registry read that failed because the RPC was down must not poison the
   * process: the next request has to be allowed to try again.
   */
  it("retries resolution after a failure instead of caching it", async () => {
    let attempts = 0;
    const { sdk } = fakeSdk();
    const adapter = new ZeroGBrokerAdapter(
      options({
        loadSdk: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("RPC unreachable");
          return sdk;
        },
      }),
    );

    expect((await adapter.health()).ok).toBe(false);
    providerReturning();
    expect((await adapter.health()).ok).toBe(true);
    expect(attempts).toBe(2);
  });

  /**
   * `modelId` lands in every report trace and has to be readable before any
   * network call — the trace is written even when resolution later fails.
   */
  it("reports its model id without touching the chain", () => {
    const adapter = new ZeroGBrokerAdapter(
      options({
        model: "claude-opus-5",
        loadSdk: async () => {
          throw new Error("must not be called");
        },
      }),
    );
    expect(adapter.modelId).toBe("zerog-broker/claude-opus-5");
    expect(adapter.driver).toBe("zerog-broker");
  });
});
