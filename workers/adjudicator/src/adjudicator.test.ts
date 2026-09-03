import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdjudicationReport, SCHEMA_VERSION, contentHash } from "@proofrelay/schemas";
import { LocalStorageAdapter } from "@proofrelay/storage-adapter";
import { LocalComputeAdapter } from "@proofrelay/compute-adapter";
import { Adjudicator } from "./adjudicator.js";

const TASK_ID = `0x${"33".repeat(32)}` as const;
const ADJUDICATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const VERIFIER_A = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as const;
const VERIFIER_B = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as const;
const VERIFIER_C = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as const;

const SOURCE_TEXT = `# Changelog

Release v1.4.0 — August 10, 2026.
Maintenance release with dependency bumps and documentation fixes.`;

let root: string;
let storage: LocalStorageAdapter;
let manifestHash: `0x${string}`;
let manifestPointer: string;
let evidenceHash: `0x${string}`;
let evidencePointer: string;
const reportRecords = new Map<string, { hash: `0x${string}`; pointer: string }>();

/** A verifier report asserting one verdict for claim-001. */
async function putReport(verifier: string, verifierId: string, verdict: string, confidence: number) {
  const report = {
    kind: "verifier-report",
    schemaVersion: SCHEMA_VERSION,
    taskId: TASK_ID,
    manifestHash,
    manifestPointer,
    verifier: { address: verifier, verifierId, modelId: `local-entailment/2-0.55`, pipelineVersion: "0.1.0" },
    claims: [
      {
        taskId: TASK_ID,
        claimId: "claim-001",
        claimText: "The maintenance release bumps dependencies.",
        verdict,
        confidence,
        sources: [],
        verifier: { address: verifier, verifierId, modelId: "local-entailment/2-0.55", pipelineVersion: "0.1.0" },
        reasoningSummary: "test fixture",
        createdAt: "2026-08-31T10:00:00.000Z",
      },
    ],
    graph: { nodes: [], edges: [] },
    compute: [],
    summary: { supported: 0, contradicted: 0, insufficient: 0, meanConfidence: confidence, evidenceCoverage: 0 },
    createdAt: "2026-08-31T10:00:00.000Z",
  };
  const put = await storage.put("verifier-report", report);
  reportRecords.set(verifier.toLowerCase(), { hash: put.hash, pointer: put.pointer });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofrelay-adj-"));
  storage = new LocalStorageAdapter(join(root, "storage"));

  const snapshot = {
    kind: "source-snapshot",
    schemaVersion: SCHEMA_VERSION,
    producer: "test",
    sourceId: "src-001",
    uri: "https://example.org/CHANGELOG.md",
    status: "OK",
    httpStatus: 200,
    contentType: "text/plain",
    headers: {},
    text: SOURCE_TEXT,
    byteLength: Buffer.byteLength(SOURCE_TEXT),
    contentHash: contentHash(SOURCE_TEXT),
    truncated: false,
    error: null,
    retrievedAt: "2026-08-31T10:00:00.000Z",
  };
  const snapPut = await storage.put("source-snapshot", snapshot);

  const manifest = {
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: "test",
    manifestId: "m-1",
    chainId: 16602,
    creator: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    title: "maintenance release claim",
    question: "Does the changelog say the maintenance release bumps dependencies?",
    answerText: null,
    claims: [
      { claimId: "claim-001", claimText: "The maintenance release bumps dependencies.", origin: "creator" },
    ],
    sources: [
      {
        sourceId: "src-001",
        uri: snapshot.uri,
        status: "OK",
        contentHash: snapshot.contentHash,
        byteLength: snapshot.byteLength,
        snapshotHash: snapPut.hash,
        snapshotPointer: snapPut.pointer,
      },
    ],
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      maxEvidencePerClaim: 3,
      ruleId: `0x${"22".repeat(32)}`,
    },
    safety: { publicDataOnly: true, redactions: [], warnings: [] },
    createdAt: "2026-08-31T10:00:00.000Z",
  };
  const manifestPut = await storage.put("task-manifest", manifest);
  manifestHash = manifestPut.hash;
  manifestPointer = manifestPut.pointer;

  const challenge = {
    kind: "challenge-evidence",
    schemaVersion: SCHEMA_VERSION,
    taskId: TASK_ID,
    challenger: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    reason: "Verifier B ignored the changelog sentence that states the dependency bumps.",
    disputedClaims: ["claim-001"],
    disputedReportHashes: [],
    additionalEvidence: [],
    createdAt: "2026-08-31T10:10:00.000Z",
  };
  const challengePut = await storage.put("challenge-evidence", challenge);
  evidenceHash = challengePut.hash;
  evidencePointer = challengePut.pointer;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeChain(sent: unknown[][], verifiers: readonly string[] = [VERIFIER_A, VERIFIER_B]) {
  return {
    account: ADJUDICATOR,
    getTask: vi.fn().mockResolvedValue({
      status: 5,
      manifestHash,
      manifestPointer,
      // The chain always carries this; the fake omitted it, which hid the fact
      // that the settled verdict is derivable here at all.
      ruleId: `0x${"33".repeat(32)}`,
      bounty: 4_000_000_000_000_000n,
    }),
    params: vi.fn().mockResolvedValue({
      conflictRateBps: 5_000,
      challengeBondBps: 1_000,
      challengerRewardBps: 1_000,
      adjudicatorSplitBps: 5_000,
      verifierSlashBps: 0,
      minBounty: 100_000_000_000_000n,
      minVerifierStake: 0n,
      keeperGracePeriod: 259_200,
      adjudicationWindow: 604_800,
      claimGracePeriod: 604_800,
    }),
    getDispute: vi.fn().mockResolvedValue({
      challenger: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      bond: 400_000_000_000_000n,
      evidenceHash,
      evidencePointer,
      resolved: false,
    }),
    getTaskVerifiers: vi.fn().mockResolvedValue([...verifiers]),
    getReport: vi.fn(async (_taskId: string, verifier: string) => {
      const record = reportRecords.get(verifier.toLowerCase());
      return record
        ? { revealed: true, reportHash: record.hash, reportPointer: record.pointer }
        : { revealed: false, reportHash: `0x${"0".repeat(64)}`, reportPointer: "" };
    }),
    send: vi.fn(async (fn: string, args: unknown[]) => {
      sent.push([fn, ...args]);
      return { txHash: "0xfeed", blockNumber: 1n, gasUsed: 1n, status: "success" as const };
    }),
    blockNumber: vi.fn().mockResolvedValue(100n),
    getLogs: vi.fn().mockResolvedValue([]),
    eventNameForTopic: () => null,
  };
}

function build(sent: unknown[][], verifiers?: readonly string[], overrides: Record<string, unknown> = {}) {
  return new Adjudicator({
    // The test drives resolve() directly; only the calls it makes are asserted.
    chain: fakeChain(sent, verifiers) as never,
    storage,
    compute: new LocalComputeAdapter({ evidenceDepth: 4, supportThreshold: 0.5 }),
    evidenceDepth: 4,
    supportThreshold: 0.5,
    pollMs: 1_000,
    log: () => undefined,
    now: () => new Date("2026-08-31T10:20:00.000Z"),
    ...overrides,
  });
}

describe("adjudicator", () => {
  it("upholds a challenge when its independent pass disagrees with a verifier", async () => {
    // Verifier B abstained on a claim the changelog does state.
    await putReport(VERIFIER_A, "verifier-a", "SUPPORTED", 0.74);
    await putReport(VERIFIER_B, "verifier-b", "INSUFFICIENT_EVIDENCE", 0.44);

    const sent: unknown[][] = [];
    await build(sent).resolve(TASK_ID);

    expect(sent).toHaveLength(1);
    const [fn, taskId, upheld, hash, pointer, beneficiaries] = sent[0]! as [
      string, string, boolean, string, string, string[],
    ];
    expect(fn).toBe("resolveDispute");
    expect(taskId).toBe(TASK_ID);
    expect(upheld).toBe(true);
    // The disagreed-with verifier is dropped from the revised reward set.
    expect(beneficiaries.map((a) => a.toLowerCase())).toEqual([VERIFIER_A.toLowerCase()]);

    const stored = await storage.getJson(pointer);
    expect(() => AdjudicationReport.parse(stored)).not.toThrow();
    const report = stored as { decision: string; upheld: boolean };
    expect(report.upheld).toBe(true);
    expect(report.decision).toContain("claim-001");
  });

  /**
   * `upheld` measures the second pass against the verdict the task SETTLED on,
   * not against each individual report. Comparing per-report made a dissenting
   * verifier's own report enough to uphold: A and B agree, consensus settles on
   * their verdict, a second pass reproduces it — and C, who held the minority
   * view, could challenge its own task, be upheld against itself, and collect
   * the challenger reward. A guaranteed profit for being wrong.
   */
  it("rejects a challenge when only the dissenting verifier disagrees", async () => {
    await putReport(VERIFIER_A, "verifier-a", "SUPPORTED", 0.74);
    await putReport(VERIFIER_B, "verifier-b", "SUPPORTED", 0.71);
    await putReport(VERIFIER_C, "verifier-c", "INSUFFICIENT_EVIDENCE", 0.44);

    const sent: unknown[][] = [];
    await build(sent, [VERIFIER_A, VERIFIER_B, VERIFIER_C]).resolve(TASK_ID);

    const [, , upheld, , , beneficiaries] = sent[0]! as [string, string, boolean, string, string, string[]];
    expect(upheld).toBe(false);
    // The dissenter is still dropped from the reward set — who is paid and
    // whether the challenge stands are separate questions.
    expect(beneficiaries.map((a) => a.toLowerCase())).toEqual([
      VERIFIER_A.toLowerCase(),
      VERIFIER_B.toLowerCase(),
    ]);
  });

  it("rejects a challenge when its independent pass reproduces every verdict", async () => {
    await putReport(VERIFIER_A, "verifier-a", "SUPPORTED", 0.74);
    await putReport(VERIFIER_B, "verifier-b", "SUPPORTED", 0.71);

    const sent: unknown[][] = [];
    await build(sent).resolve(TASK_ID);

    const [, , upheld, , , beneficiaries] = sent[0]! as [string, string, boolean, string, string, string[]];
    expect(upheld).toBe(false);
    expect(beneficiaries).toHaveLength(2);
  });

  it("stores a reason hash distinct from the report pointer", async () => {
    await putReport(VERIFIER_A, "verifier-a", "SUPPORTED", 0.74);
    await putReport(VERIFIER_B, "verifier-b", "SUPPORTED", 0.71);

    const sent: unknown[][] = [];
    await build(sent).resolve(TASK_ID);
    const [, , , adjudicationHash, , , reasonHash] = sent[0]! as [
      string, string, boolean, string, string, string[], string,
    ];
    expect(reasonHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reasonHash).not.toBe(adjudicationHash);
  });

  /**
   * The dispute scan is a duration converted into blocks, so a chain that
   * lands blocks twice as fast needs twice as many of them to cover the same
   * seven days. The cadence used to be pinned at Galileo's 2 s no matter which
   * chain was connected, which on mainnet's ~1 s cadence covered about five of
   * the seven days a dispute has to live in — the rest expired unseen.
   */
  it.each([
    { label: "Galileo", blockSeconds: 2, expectedLookback: 453_600n },
    { label: "mainnet", blockSeconds: 1, expectedLookback: 907_200n },
  ])("scans $label's whole adjudication window at its own cadence", async ({ blockSeconds, expectedLookback }) => {
    const head = 2_000_000n;
    const adjudicator = build([], undefined, { blockSeconds });
    const chain = (adjudicator as unknown as {
      deps: { chain: { blockNumber: ReturnType<typeof vi.fn>; getLogs: ReturnType<typeof vi.fn> } };
    }).deps.chain;
    chain.blockNumber.mockResolvedValue(head);

    await (adjudicator as unknown as { findDisputed(): Promise<unknown[]> }).findDisputed();

    expect(chain.getLogs).toHaveBeenCalledWith(head - expectedLookback, head);
    // 604,800 s of window, covered with the half-again margin the scan applies.
    expect(expectedLookback * BigInt(blockSeconds)).toBe((604_800n * 3n) / 2n);
  });

  it("refuses to act on a challenge whose evidence does not match its onchain hash", async () => {
    const sent: unknown[][] = [];
    const adjudicator = build(sent);
    const chain = (adjudicator as unknown as { deps: { chain: { getDispute: ReturnType<typeof vi.fn> } } }).deps.chain;
    chain.getDispute.mockResolvedValue({
      challenger: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      bond: 0n,
      evidenceHash: `0x${"ff".repeat(32)}`,
      evidencePointer,
      resolved: false,
    });
    await expect(adjudicator.resolve(TASK_ID)).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    expect(sent).toHaveLength(0);
  });
});
