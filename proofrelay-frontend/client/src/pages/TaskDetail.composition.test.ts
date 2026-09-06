import { describe, expect, it } from "vitest";
import type { TaskDetail } from "@/lib/types";
import { composition } from "./TaskDetail";

const report = (over: Record<string, unknown>) =>
  ({
    verifier: `0x${"11".repeat(20)}`,
    verifierLabel: "V",
    committed: true,
    revealed: true,
    commitment: null,
    reportHash: null,
    reportPointer: null,
    modelId: "zerog-router/qwen3-vl-30b",
    pipelineVersion: "0.1.0",
    committedAt: null,
    revealedAt: null,
    supported: null,
    contradicted: null,
    insufficient: null,
    meanConfidence: null,
    computeProvider: "zerog-router:0xabc",
    computeLatencyMs: null,
    commitTx: { txHash: null, blockNumber: null, explorerUrl: null },
    revealTx: { txHash: null, blockNumber: null, explorerUrl: null },
    ...over,
  }) as TaskDetail["reports"][number];

const task = (reports: TaskDetail["reports"], sources = 1) =>
  ({ reports, sources: Array.from({ length: sources }, () => ({})) }) as unknown as TaskDetail;

describe("composition", () => {
  it("counts distinct models, providers and sources", () => {
    const made = composition(
      task([
        report({}),
        report({ modelId: "zerog-router/glm-5.3-flash", computeProvider: "zerog-router:0xdef" }),
      ], 2),
    );
    expect(made).toEqual({ models: 2, providers: 2, sources: 2, offline: 0 });
  });

  it("counts two verifiers running one model as one model", () => {
    const made = composition(task([report({}), report({})]));
    expect(made.models).toBe(1);
  });

  /**
   * The defect this exists for. A degraded report carries
   * `local-entailment/...` as its model and `...(fallback:local)` as its
   * provider, so counting it made a verifier whose compute key had expired read
   * as MORE diversity — while the agreement label beside it said 3/4.
   */
  it("does not let an offline report read as another model or provider", () => {
    const made = composition(
      task([
        report({}),
        report({ modelId: "local-entailment/2-0.55", computeProvider: "zerog-router(fallback:local)" }),
      ]),
    );
    expect(made.models).toBe(1);
    expect(made.providers).toBe(1);
    expect(made.offline).toBe(1);
  });

  it("ignores verifiers that have not revealed", () => {
    expect(composition(task([report({ revealed: false })])).models).toBe(0);
  });

  /**
   * modelId arrives from the indexer after the reveal the chain already
   * counted, so a revealed task can have none yet. The caller falls back to
   * commit/reveal progress on models === 0, which must therefore be reachable.
   */
  it("reports no models while the indexer is still behind", () => {
    const made = composition(task([report({ modelId: null, computeProvider: null })]));
    expect(made.models).toBe(0);
    expect(made.offline).toBe(0);
  });
});
