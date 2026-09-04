import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import pg from "pg";
import { loadConfig, repoRoot, type Config } from "@proofrelay/config";
import { LocalStorageAdapter, type StorageAdapter } from "@proofrelay/storage-adapter";
import {
  computeTaskId,
  type DisputeOnChain,
  type ProtocolParams,
  type ReportOnChain,
  type TaskOnChain,
} from "@proofrelay/chain-client";
import {
  ClaimView,
  DEFAULT_RULE,
  OUTCOME_NAMES,
  PrepareChallengeResponse,
  PrepareTaskResponse,
  ProofRelayError,
  SCHEMA_VERSION,
  TASK_STATUS_NAMES,
  TaskDetail,
  TaskListResponse,
  TaskManifest,
  TaskStatus,
  VerifierReport,
  WorkspaceStats,
  displayStatus,
  objectHash,
} from "@proofrelay/schemas";
import { createPool, type Pool, type PoolClient } from "../db.js";
import {
  agreementLabel,
  agreementPct,
  buildClaims,
  disputeDeadlineFrom,
  getTask,
  listTasks,
  parseStatusFilter,
  sourceLabel,
  syncTask,
  trendPct,
  trendPctWei,
  workspaceStats,
  type AgreementInput,
  type TaskChainReader,
  type TaskServiceContext,
  DISPLAY_STATUS_SQL,
} from "./task-service.js";
import { prepareChallenge, prepareTask, type PrepareServiceContext } from "./prepare-service.js";
import {
  isTaskId,
  refForSequence,
  refForTaskId,
  refsForTaskIds,
  resolveTaskId,
  sequenceForRef,
  taskIdForRef,
} from "./refs.js";

/* ── fixtures ────────────────────────────────────────────────────────────── */

const CONTRACT = "0xc1E353cb44eA09729143f06Af97E51FB952b33D7" as Address;
const CREATOR = "0x33d2b4aa407b450aff307f81fec812ff6cd26266" as Address;
const VERIFIER_A = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Address;
const VERIFIER_B = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Address;
const CHALLENGER = "0xa7d6b126d6dcbc75319f7c1b7b43524cc791e02d" as Address;

/** A task that really settled on this deployment; the struct values are its own. */
const TASK_ID = "0xab17b92ed64a9004e2995d7565809e10947ce046c64e21476aefe16cfef002b3";
const CONSENSUS_AT = 1788176208;
const COMMIT_DEADLINE = 1788176097;
const REVEAL_DEADLINE = 1788176997;
const DISPUTE_WINDOW = 900;

const SNAPSHOT_A = `sha256:${"a".repeat(64)}`;
const SNAPSHOT_B = `sha256:${"b".repeat(64)}`;

/**
 * Pinned to Galileo, not inherited from the machine's .env.
 *
 * Every fixture and expectation below hardcodes chain 16602, and the manifest
 * carries chainId in the bytes it hashes — so `loadConfig()` alone made this
 * suite pass only for a developer whose .env happened to say 16602. Pointing a
 * deployment at mainnet turned it red without a line of production code
 * changing, which is the wrong thing for a unit test to be sensitive to.
 */
const loadedConfig = loadConfig();
const config: Config = { ...loadedConfig, chain: { ...loadedConfig.chain, chainId: 16602 } };

function manifestFixture(): TaskManifest {
  return TaskManifest.parse({
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: "proofrelay-api/1.0.0",
    manifestId: "11111111-2222-3333-4444-555555555555",
    chainId: 16602,
    creator: CREATOR,
    title: "0G Storage release claim audit",
    question: "Are the stated release facts supported by the public documentation?",
    answerText: null,
    claims: [
      {
        claimId: "claim-001",
        claimText: "0G Storage is available as a standalone service.",
        origin: "creator",
      },
      {
        claimId: "claim-002",
        claimText: "The maintainers relocated their head office to Lisbon in 2026.",
        origin: "creator",
      },
    ],
    sources: [
      {
        sourceId: "src-001",
        uri: "https://docs.0g.ai/concepts/storage",
        status: "OK",
        contentHash: SNAPSHOT_A,
        byteLength: 445,
        snapshotHash: `0x${"1".repeat(64)}`,
        snapshotPointer: `local://${"1".repeat(64)}`,
      },
    ],
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      maxEvidencePerClaim: 3,
      ruleId: DEFAULT_RULE.ruleId,
    },
    safety: { publicDataOnly: true, redactions: [], warnings: [] },
    createdAt: "2026-08-31T10:32:35.662Z",
  });
}

const MANIFEST = manifestFixture();
const MANIFEST_HASH = objectHash(MANIFEST);
const MANIFEST_POINTER = `0g://${MANIFEST_HASH}`;

function reportFixture(args: {
  verifier: Address;
  verifierId: string;
  claim2Verdict: "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";
  topScore: number;
}): VerifierReport {
  const span = (contentHash: string, quotedSpan: string, score: number) => ({
    uri: "https://docs.0g.ai/concepts/storage",
    snapshotObjectId: `local://${"1".repeat(64)}`,
    contentHash,
    quotedSpan,
    spanStart: 0,
    spanEnd: quotedSpan.length,
    score,
    retrievedAt: "2026-08-31T10:32:35.916Z",
  });
  const identity = {
    address: args.verifier,
    verifierId: args.verifierId,
    modelId: "local-entailment/2-0.55",
    pipelineVersion: "0.1.0",
  };
  return VerifierReport.parse({
    kind: "verifier-report",
    schemaVersion: SCHEMA_VERSION,
    taskId: TASK_ID,
    manifestHash: MANIFEST_HASH,
    manifestPointer: MANIFEST_POINTER,
    verifier: identity,
    claims: [
      {
        taskId: TASK_ID,
        claimId: "claim-001",
        claimText: "0G Storage is available as a standalone service.",
        verdict: "SUPPORTED",
        confidence: 0.82,
        sources: [
          span(SNAPSHOT_A, "0G Storage can be used as a standalone service.", args.topScore),
          span(SNAPSHOT_B, "The project publishes a release roughly every month.", 0.19),
        ],
        verifier: identity,
        reasoningSummary: "The quoted span states the claim directly.",
        createdAt: "2026-08-31T10:32:35.942Z",
      },
      {
        taskId: TASK_ID,
        claimId: "claim-002",
        claimText: "The maintainers relocated their head office to Lisbon in 2026.",
        verdict: args.claim2Verdict,
        confidence: 0.61,
        sources: [span(SNAPSHOT_A, "No office relocation is mentioned.", 0.31)],
        verifier: identity,
        reasoningSummary: "No span addresses the relocation.",
        createdAt: "2026-08-31T10:32:35.942Z",
      },
    ],
    graph: { nodes: [], edges: [] },
    compute: [
      {
        requestId: "local-ed85e5f92c522516",
        operation: "evidence-scoring",
        provider: "local",
        modelId: "local-entailment/2-0.55",
        pipelineVersion: "0.1.0",
        inputHash: `0x${"c".repeat(64)}`,
        outputHash: `0x${"d".repeat(64)}`,
        latencyMs: 7,
        attempts: 1,
        verified: false,
        rawArtifactPointer: null,
      },
    ],
    summary: {
      supported: 1,
      contradicted: args.claim2Verdict === "CONTRADICTED" ? 1 : 0,
      insufficient: args.claim2Verdict === "INSUFFICIENT_EVIDENCE" ? 1 : 0,
      meanConfidence: 0.715,
      evidenceCoverage: 1,
    },
    createdAt: "2026-08-31T10:32:35.942Z",
  });
}

const REPORT_A = reportFixture({
  verifier: VERIFIER_A,
  verifierId: "verifier-a",
  claim2Verdict: "INSUFFICIENT_EVIDENCE",
  topScore: 0.58,
});
const REPORT_B = reportFixture({
  verifier: VERIFIER_B,
  verifierId: "verifier-b",
  claim2Verdict: "INSUFFICIENT_EVIDENCE",
  topScore: 0.91,
});
const REPORT_A_HASH = objectHash(REPORT_A);
const REPORT_B_HASH = objectHash(REPORT_B);

function taskOnChain(over: Partial<TaskOnChain> = {}): TaskOnChain {
  return {
    creator: CREATOR,
    bounty: 2_000_000_000_000_000n,
    verifierCount: 2,
    commitDeadline: COMMIT_DEADLINE,
    revealDeadline: REVEAL_DEADLINE,
    disputeWindow: DISPUTE_WINDOW,
    consensusAt: CONSENSUS_AT,
    committedCount: 2,
    revealedCount: 2,
    rewardBps: 10_000,
    status: TaskStatus.Finalized,
    outcome: 1,
    manifestHash: MANIFEST_HASH,
    ruleId: DEFAULT_RULE.ruleId,
    resultHash: `0x${"e".repeat(64)}` as Hex,
    manifestPointer: MANIFEST_POINTER,
    ...over,
  };
}

function reportOnChain(verifier: Address, reportHash: string): ReportOnChain {
  return {
    verifier,
    commitment: `0x${"9".repeat(64)}` as Hex,
    revealed: true,
    reportHash: reportHash as Hex,
    reportPointer: `0g://${reportHash}`,
    committedAt: COMMIT_DEADLINE - 60,
    revealedAt: CONSENSUS_AT - 30,
  };
}

const EMPTY_DISPUTE: DisputeOnChain = {
  challenger: `0x${"0".repeat(40)}` as Address,
  bond: 0n,
  evidenceHash: `0x${"0".repeat(64)}` as Hex,
  evidencePointer: "",
  resolved: false,
  upheld: false,
  outcome: 0,
  openedAt: 0,
  deadline: 0,
  adjudicationHash: `0x${"0".repeat(64)}` as Hex,
  adjudicationPointer: "",
};

const PARAMS: ProtocolParams = {
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
};

function chainStub(over: Partial<TaskOnChain> = {}): TaskChainReader {
  return {
    chainId: 16602,
    contract: CONTRACT,
    getTask: async () => taskOnChain(over),
    getReport: async (_taskId, verifier) =>
      reportOnChain(
        verifier,
        verifier.toLowerCase() === VERIFIER_A.toLowerCase() ? REPORT_A_HASH : REPORT_B_HASH,
      ),
    getTaskVerifiers: async () => [VERIFIER_A, VERIFIER_B],
    getDispute: async () => EMPTY_DISPUTE,
    allocationOf: async () => 0n,
  };
}

/** Storage that is never reachable: the read model must answer without it. */
const offlineStorage: StorageAdapter = {
  driver: "offline",
  put: async () => {
    throw new ProofRelayError("STORAGE_UNAVAILABLE", "offline");
  },
  putBytes: async () => {
    throw new ProofRelayError("STORAGE_UNAVAILABLE", "offline");
  },
  get: async () => {
    throw new ProofRelayError("STORAGE_UNAVAILABLE", "offline");
  },
  getJson: async () => {
    throw new ProofRelayError("STORAGE_UNAVAILABLE", "offline");
  },
  has: async () => false,
  health: async () => ({ ok: false, detail: "offline", latencyMs: 0 }),
};

const NOW = new Date("2026-09-02T09:00:00.000Z");

function context(db: PoolClient, chain: TaskChainReader = chainStub()): TaskServiceContext {
  return { db, chain, storage: offlineStorage, config, now: () => NOW };
}

/* ── pure: agreement ─────────────────────────────────────────────────────── */

function agreement(over: Partial<AgreementInput> = {}): AgreementInput {
  return {
    verifierCount: 2,
    committedCount: 0,
    revealedCount: 0,
    statusCode: TaskStatus.Open,
    outcomeCode: 0,
    consensus: null,
    ...over,
  };
}

describe("agreementLabel / agreementPct", () => {
  it("reads 2/2 agree when both reveals agreed", () => {
    const input = agreement({
      statusCode: TaskStatus.Finalized,
      outcomeCode: 1,
      committedCount: 2,
      revealedCount: 2,
      consensus: { outcome: "CONSENSUS", agreementBps: 10_000, agreeingVerifiers: 2 },
    });
    expect(agreementLabel(input)).toBe("2/2 agree");
    expect(agreementPct(input)).toBe(100);
  });

  it("reads 1/2 agree when only one verifier carried the majority", () => {
    const input = agreement({
      statusCode: TaskStatus.Finalized,
      outcomeCode: 1,
      committedCount: 2,
      revealedCount: 2,
      consensus: { outcome: "CONSENSUS", agreementBps: 5_000, agreeingVerifiers: 1 },
    });
    expect(agreementLabel(input)).toBe("1/2 agree");
    expect(agreementPct(input)).toBe(100);
  });

  it("reads Conflict for a conflicted result", () => {
    const input = agreement({
      statusCode: TaskStatus.Finalized,
      outcomeCode: 2,
      committedCount: 2,
      revealedCount: 2,
      consensus: { outcome: "CONFLICT", agreementBps: 0, agreeingVerifiers: 0 },
    });
    expect(agreementLabel(input)).toBe("Conflict");
    expect(agreementPct(input)).toBe(0);
  });

  it("falls back to the chain outcome when the consensus row is not indexed yet", () => {
    expect(
      agreementLabel(
        agreement({ statusCode: TaskStatus.Finalized, outcomeCode: 2, revealedCount: 2 }),
      ),
    ).toBe("Conflict");
    expect(
      agreementLabel(
        agreement({ statusCode: TaskStatus.Finalized, outcomeCode: 3, revealedCount: 1 }),
      ),
    ).toBe("No quorum");
    expect(
      agreementLabel(
        agreement({ statusCode: TaskStatus.Finalized, outcomeCode: 1, revealedCount: 2 }),
      ),
    ).toBe("2/2 agree");
  });

  it("uses agreementBps/100 for an evaluated task that did not reach consensus", () => {
    expect(
      agreementPct(
        agreement({
          statusCode: TaskStatus.Consensus,
          outcomeCode: 0,
          consensus: { outcome: "CONFLICT", agreementBps: 5_000, agreeingVerifiers: 0 },
        }),
      ),
    ).toBe(50);
  });

  it("reports lifecycle progress before anything has been evaluated", () => {
    expect(agreementPct(agreement({ committedCount: 0, revealedCount: 0 }))).toBe(0);
    expect(agreementPct(agreement({ committedCount: 1, revealedCount: 0 }))).toBe(25);
    expect(agreementPct(agreement({ committedCount: 2, revealedCount: 0 }))).toBe(50);
    expect(agreementPct(agreement({ committedCount: 2, revealedCount: 1 }))).toBe(75);
    expect(agreementPct(agreement({ committedCount: 2, revealedCount: 2 }))).toBe(100);
    expect(agreementLabel(agreement({ committedCount: 1 }))).toBe("1/2 committed");
    expect(agreementLabel(agreement({ committedCount: 2, revealedCount: 1 }))).toBe("1/2 revealed");
  });

  it("stays a renderable label and an in-range integer for every status and outcome", () => {
    for (let status = 0; status < TASK_STATUS_NAMES.length; status += 1) {
      for (let outcome = 0; outcome < OUTCOME_NAMES.length; outcome += 1) {
        for (const consensus of [
          null,
          { outcome: "CONSENSUS" as const, agreementBps: 10_000, agreeingVerifiers: 2 },
          { outcome: "CONFLICT" as const, agreementBps: 0, agreeingVerifiers: 0 },
          { outcome: "NO_QUORUM" as const, agreementBps: 0, agreeingVerifiers: 0 },
        ]) {
          const input = agreement({
            statusCode: status,
            outcomeCode: outcome,
            committedCount: 2,
            revealedCount: 2,
            consensus,
          });
          const label = agreementLabel(input);
          const pct = agreementPct(input);

          expect(label.length).toBeGreaterThan(0);
          expect(label).not.toContain("undefined");
          expect(label).not.toContain("NaN");
          expect(Number.isInteger(pct)).toBe(true);
          expect(pct).toBeGreaterThanOrEqual(0);
          expect(pct).toBeLessThanOrEqual(100);

          const settled = consensus?.outcome ?? ["NONE", "CONSENSUS", "CONFLICT", "NO_QUORUM"][outcome];
          if (settled === "CONFLICT") expect(label).toBe("Conflict");
          if (settled === "NO_QUORUM") expect(label).toBe("No quorum");
          if (settled === "CONSENSUS") {
            expect(label).toMatch(/^\d+\/\d+ agree$/);
            expect(pct).toBe(100);
          }
          if (settled === "NONE") {
            if (status === TaskStatus.Cancelled) expect(label).toBe("Cancelled");
            if (status === TaskStatus.Expired) expect(label).toBe("Expired");
          }
        }
      }
    }
  });
});

/* ── pure: derivations ───────────────────────────────────────────────────── */

describe("derivations", () => {
  it("treats disputeWindow as a duration, the way the live struct uses it", () => {
    // getTask on 0xab17b92e… returns consensusAt 1788176208 and disputeWindow 900.
    const deadline = disputeDeadlineFrom(CONSENSUS_AT, DISPUTE_WINDOW);
    expect(deadline?.toISOString()).toBe(new Date((CONSENSUS_AT + 900) * 1000).toISOString());
    expect(disputeDeadlineFrom(0, 900)).toBeNull();
  });

  it("labels a source by host and last path segment", () => {
    expect(sourceLabel("https://docs.0g.ai/concepts/storage")).toBe("docs.0g.ai / storage");
    expect(sourceLabel("https://docs.0g.ai")).toBe("docs.0g.ai");
    expect(sourceLabel("inline:src-001")).toBe("inline:src-001");
  });

  it("returns null rather than a number when there is no prior window", () => {
    expect(trendPct(5, 0)).toBeNull();
    expect(trendPct(5, null)).toBeNull();
    expect(trendPct(6, 4)).toBe(50);
    expect(trendPct(2, 4)).toBe(-50);
  });

  it("compares wei without rounding it through a double", () => {
    expect(trendPctWei(0n, 0n)).toBeNull();
    expect(trendPctWei(3_000_000_000_000_000n, 1_000_000_000_000_000n)).toBe(200);
    // Beyond Number.MAX_SAFE_INTEGER, where a double comparison drifts.
    expect(trendPctWei(2n * 10n ** 30n, 10n ** 30n)).toBe(100);
  });

  it("accepts display groups, contract statuses and rejects anything else", () => {
    expect(parseStatusFilter(undefined)).toEqual({ displays: null, codes: null });
    expect(parseStatusFilter("ALL")).toEqual({ displays: null, codes: null });
    expect(parseStatusFilter("in_review")).toEqual({ displays: ["IN REVIEW"], codes: null });
    expect(parseStatusFilter("VERIFIED,DISPUTED").displays).toEqual(["VERIFIED", "DISPUTED"]);
    expect(parseStatusFilter("Finalized")).toEqual({ displays: null, codes: [TaskStatus.Finalized] });
    expect(parseStatusFilter("7")).toEqual({ displays: null, codes: [TaskStatus.Finalized] });
    expect(() => parseStatusFilter("PENDING")).toThrow(ProofRelayError);
    // `tasks.status` is a smallint compared through `ANY($1::int[])`; a code past
    // the enum reaches Postgres as 22003 and leaves the client a 500 with
    // nothing to act on, so it is rejected here as the bad request it is.
    expect(() => parseStatusFilter("2147483648")).toThrow(ProofRelayError);
    expect(() => parseStatusFilter("99999999999999999999")).toThrow(ProofRelayError);
  });
});

/* ── pure: refs ──────────────────────────────────────────────────────────── */

describe("refs", () => {
  it("round-trips a creation index through its handle", () => {
    expect(refForSequence(48)).toBe("PR-1048");
    expect(sequenceForRef("PR-1048")).toBe(48);
    expect(sequenceForRef("pr-1000")).toBe(0);
    expect(sequenceForRef("PR-999")).toBeNull();
    expect(sequenceForRef(TASK_ID)).toBeNull();
    expect(sequenceForRef("nonsense")).toBeNull();
  });

  it("tells a task id from a handle", () => {
    expect(isTaskId(TASK_ID)).toBe(true);
    expect(isTaskId("PR-1048")).toBe(false);
    expect(isTaskId(`${TASK_ID}00`)).toBe(false);
  });
});

/* ── pure: claim merge ───────────────────────────────────────────────────── */

describe("buildClaims", () => {
  const reports = [
    { verifier: VERIFIER_A.toLowerCase(), label: "Verifier A", report: REPORT_A },
    { verifier: VERIFIER_B.toLowerCase(), label: "Verifier B", report: REPORT_B },
  ];

  it("merges manifest order, per-verifier verdicts and the strongest quoted span", () => {
    const claims = buildClaims({
      manifestClaims: MANIFEST.claims,
      reports,
      consensus: null,
      ruleId: DEFAULT_RULE.ruleId,
    });

    expect(claims).toHaveLength(2);
    for (const claim of claims) expect(() => ClaimView.parse(claim)).not.toThrow();

    const first = claims[0]!;
    expect(first.ordinal).toBe("01");
    expect(first.claimId).toBe("claim-001");
    expect(first.displayVerdict).toBe("SUPPORTED");
    expect(first.agreed).toBe(true);
    expect(first.verdicts.map((verdict) => verdict.verifierLabel)).toEqual([
      "Verifier A",
      "Verifier B",
    ]);
    // 0.91 is verifier B's span; the first-filed 0.58 span must not win.
    expect(first.excerpt).toBe("0G Storage can be used as a standalone service.");
    expect(first.snapshotObjectId).toBe(`local://${"1".repeat(64)}`);
    expect(first.retrievedAt).toBe("2026-08-31T10:32:35.916Z");
    expect(first.primarySourceLabel).toBe("docs.0g.ai / storage");
    expect(first.confidencePct).toBe(82);

    expect(claims[1]!.ordinal).toBe("02");
    expect(claims[1]!.displayVerdict).toBe("INSUFFICIENT");
  });

  it("keeps a claim nobody reported on visible as PENDING", () => {
    const claims = buildClaims({
      manifestClaims: MANIFEST.claims,
      reports: [],
      consensus: null,
      ruleId: DEFAULT_RULE.ruleId,
    });
    expect(claims.map((claim) => claim.displayVerdict)).toEqual(["PENDING", "PENDING"]);
    expect(claims.every((claim) => claim.excerpt === null)).toBe(true);
    expect(claims.every((claim) => claim.confidencePct === null)).toBe(true);
  });

  it("surfaces a direction split as a critical conflict", () => {
    const dissenting = reportFixture({
      verifier: VERIFIER_B,
      verifierId: "verifier-b",
      claim2Verdict: "CONTRADICTED",
      topScore: 0.44,
    });
    const claims = buildClaims({
      manifestClaims: MANIFEST.claims,
      reports: [
        { verifier: VERIFIER_A.toLowerCase(), label: "Verifier A", report: REPORT_A },
        { verifier: VERIFIER_B.toLowerCase(), label: "Verifier B", report: dissenting },
      ],
      consensus: null,
      ruleId: DEFAULT_RULE.ruleId,
    });
    expect(claims[1]!.criticalConflict).toBe(false);
    expect(claims[1]!.agreed).toBe(false);
  });

  it("prefers the stored consensus row over a recomputation", () => {
    const claims = buildClaims({
      manifestClaims: MANIFEST.claims,
      reports,
      consensus: [
        {
          claimId: "claim-001",
          claimText: MANIFEST.claims[0]!.claimText,
          majorityVerdict: "CONTRADICTED",
          agreed: false,
          criticalConflict: true,
          evidenceCoverage: 0.5,
          evidenceOverlap: 0.25,
          agreeingVerifiers: [],
          dissentingVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()],
          verdicts: [
            { verifier: VERIFIER_A.toLowerCase(), verdict: "CONTRADICTED", confidence: 0.4 },
          ],
          reason: "recorded onchain",
        },
      ],
      ruleId: DEFAULT_RULE.ruleId,
    });
    expect(claims[0]!.displayVerdict).toBe("CONTRADICTED");
    expect(claims[0]!.criticalConflict).toBe(true);
    expect(claims[0]!.evidenceCoverage).toBe(0.5);
  });
});

/* ── prepare ─────────────────────────────────────────────────────────────── */

describe("prepare-service", () => {
  let root: string;
  let storage: StorageAdapter;

  const prepareChain = {
    chainId: 16602,
    contract: CONTRACT,
    creatorNonce: async () => 3n,
    params: async () => PARAMS,
    getTask: async () => taskOnChain({ bounty: 4_000_000_000_000_000n, status: TaskStatus.Consensus }),
    getTaskVerifiers: async () => [VERIFIER_A, VERIFIER_B] as readonly Address[],
    getReport: async (_taskId: Hex, verifier: Address) =>
      reportOnChain(
        verifier,
        verifier.toLowerCase() === VERIFIER_A.toLowerCase() ? REPORT_A_HASH : REPORT_B_HASH,
      ),
  };

  /** Nothing resolves, so no test ever leaves the machine. */
  const deadResolver = async (hostname: string): Promise<never> => {
    throw new Error(`ENOTFOUND ${hostname}`);
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "proofrelay-prepare-"));
    storage = new LocalStorageAdapter(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function prepareContext(): PrepareServiceContext {
    return {
      chain: prepareChain,
      storage,
      config,
      now: () => NOW,
      newId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      fetchOptions: { resolver: deadResolver },
    };
  }

  const baseRequest = {
    title: "0G Storage release claim audit",
    question: "Are the stated release facts supported by the public documentation?",
    claims: ["0G Storage is available as a standalone service."],
    sources: [
      { inlineText: "0G Storage can be used as a standalone service.", label: "https://docs.0g.ai/concepts/storage" },
    ],
    bountyWei: "2000000000000000",
  };

  it("rejects an email address hidden in a claim", async () => {
    const error = await prepareTask(prepareContext(), {
      creator: CREATOR,
      request: {
        ...baseRequest,
        claims: ["Release notes were sent to alice.brown@example.com on 10 August 2026."],
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProofRelayError);
    const failure = error as ProofRelayError;
    expect(failure.code).toBe("PERSONAL_DATA_REJECTED");
    expect(failure.statusCode).toBe(400);
    expect(failure.detail?.fields).toEqual(["claims[0]"]);
    // The rejection must not become the second copy of the address.
    expect(JSON.stringify(failure.toJSON())).not.toContain("alice.brown@example.com");
  });

  it("produces a manifest that rehashes to the hash it hands the contract", async () => {
    const response = await prepareTask(prepareContext(), { creator: CREATOR, request: baseRequest });

    expect(() => PrepareTaskResponse.parse(response)).not.toThrow();
    expect(objectHash(response.manifest)).toBe(response.manifestHash);
    expect(response.createTaskArgs).toEqual({
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      manifestHash: response.manifestHash,
      manifestPointer: response.manifestPointer,
      ruleId: DEFAULT_RULE.ruleId,
      valueWei: "2000000000000000",
    });
    expect(response.predictedTaskId).toBe(
      computeTaskId({ chainId: 16602, contract: CONTRACT, creator: CREATOR, nonce: 3n }),
    );

    const manifest = TaskManifest.parse(response.manifest);
    expect(manifest.creator).toBe(CREATOR.toLowerCase());
    expect(manifest.claims[0]!.claimId).toBe("claim-001");
    expect(manifest.claims[0]!.origin).toBe("creator");
    expect(manifest.extraction).toBeNull();
    expect(manifest.policy.ruleId).toBe(DEFAULT_RULE.ruleId);
    expect(manifest.safety.publicDataOnly).toBe(true);

    // The snapshot really is in storage under the hash the manifest quotes.
    const stored = await storage.get(manifest.sources[0]!.snapshotPointer);
    expect(stored.hash).toBe(manifest.sources[0]!.snapshotHash);
  });

  it("survives one dead source instead of failing the whole preparation", async () => {
    const response = await prepareTask(prepareContext(), {
      creator: CREATOR,
      request: {
        ...baseRequest,
        sources: [
          { inlineText: "0G Storage can be used as a standalone service." },
          "https://gone.example.invalid/changelog",
        ],
      },
    });

    expect(() => PrepareTaskResponse.parse(response)).not.toThrow();
    expect(response.sources).toHaveLength(2);
    expect(response.sources[0]!.status).toBe("OK");

    const dead = response.sources[1]!;
    expect(dead.sourceId).toBe("src-002");
    expect(dead.status).toBe("SOURCE_UNAVAILABLE");
    expect(dead.error).toContain("SOURCE_UNAVAILABLE");
    expect(dead.byteLength).toBe(0);
    // Even the failed fetch is anchored, so the manifest's claim about it is checkable.
    expect(dead.snapshotPointer).toMatch(/^local:\/\/[0-9a-f]{64}$/);
    expect(response.warnings.some((warning) => warning.includes("src-002"))).toBe(true);
    expect(objectHash(response.manifest)).toBe(response.manifestHash);
  });

  it("quotes the bond the contract will demand for a challenge", async () => {
    const response = await prepareChallenge(prepareContext(), {
      taskId: TASK_ID,
      challenger: CHALLENGER,
      request: {
        reason: "The second claim was marked insufficient although the changelog settles it.",
        disputedClaims: ["claim-002"],
        additionalEvidence: [],
      },
    });

    expect(() => PrepareChallengeResponse.parse(response)).not.toThrow();
    // bounty 4e15 at challengeBondBps 1000 — the live challenge sent exactly this.
    expect(response.bondWei).toBe("400000000000000");
    expect(objectHash(response.evidence)).toBe(response.evidenceHash);
    const evidence = response.evidence as { disputedReportHashes: string[]; challenger: string };
    expect(evidence.challenger).toBe(CHALLENGER.toLowerCase());
    expect(evidence.disputedReportHashes).toEqual([REPORT_A_HASH, REPORT_B_HASH]);
  });

  it("rejects a bounty below the protocol minimum before a wallet is prompted", async () => {
    const error = await prepareTask(prepareContext(), {
      creator: CREATOR,
      request: { ...baseRequest, bountyWei: "1" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProofRelayError);
    expect((error as ProofRelayError).code).toBe("VALIDATION_FAILED");
    expect((error as ProofRelayError).detail?.minBountyWei).toBe(PARAMS.minBounty.toString());
  });
});

/* ── database-backed ─────────────────────────────────────────────────────── */

/**
 * A throwaway schema, like the indexer suite uses.
 *
 * These ran against `public` — the same schema a running API's indexer writes to
 * — so every assertion about the task list was really an assertion about
 * whatever the operator's read model happened to hold, and rows appeared under
 * the tests mid-run. That is where this suite's intermittent failures came from.
 */
const SCHEMA = `proofrelay_taskservice_test_${process.pid}`;

async function probeDatabase(): Promise<{ ok: boolean; detail: string; pool: Pool | null }> {
  let pool: Pool | null = null;
  try {
    const admin = new pg.Pool({ connectionString: config.api.databaseUrl, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    pool = new pg.Pool({
      connectionString: config.api.databaseUrl,
      options: `-c search_path=${SCHEMA}`,
      max: 10,
    });
    pool.on("error", () => undefined);

    const migrations = resolve(repoRoot(), "infra/migrations");
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(migrations, file), "utf8"));
    }
    await pool.query("SELECT 1 FROM tasks LIMIT 1");
    return { ok: true, detail: "ready", pool };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    return { ok: false, detail: String((error as Error).message).slice(0, 160), pool: null };
  }
}

async function dropSchema(): Promise<void> {
  const admin = new pg.Pool({ connectionString: config.api.databaseUrl, max: 1 });
  admin.on("error", () => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}

const database = await probeDatabase();
const describeDb = database.ok ? describe : describe.skip;

if (!database.ok) {
  console.warn(
    `\n[task-service.test] DATABASE-BACKED TESTS SKIPPED — ${database.detail}\n` +
      "  Point DATABASE_URL at a Postgres with infra/migrations/001_init.sql applied\n" +
      "  (npm run migrate) and re-run to exercise listTasks/getTask/syncTask/workspaceStats.\n",
  );
}

describeDb("read model", () => {
  let db: PoolClient;

  beforeEach(async () => {
    db = await database.pool!.connect();
    await db.query("BEGIN");
  });

  afterEach(async () => {
    await db.query("ROLLBACK").catch(() => undefined);
    db.release();
  });

  afterAll(async () => {
    await database.pool?.end().catch(() => undefined);
    await dropSchema();
  });

  async function seedManifest(): Promise<void> {
    await db.query(
      `INSERT INTO manifests (manifest_hash, manifest_pointer, chain_id, creator, rule_id,
                              title, question, claim_count, source_count, body, verified)
       VALUES ($1, $2, 16602, $3, $4, $5, $6, $7, $8, $9, TRUE)
       ON CONFLICT (manifest_hash) DO NOTHING`,
      [
        MANIFEST_HASH,
        MANIFEST_POINTER,
        CREATOR,
        DEFAULT_RULE.ruleId,
        MANIFEST.title,
        MANIFEST.question,
        MANIFEST.claims.length,
        MANIFEST.sources.length,
        JSON.stringify(MANIFEST),
      ],
    );
  }

  interface SeedOptions {
    taskId?: string;
    sequence?: number;
    status?: number;
    outcome?: number;
    createdAt?: Date;
    consensusAt?: Date | null;
    bounty?: string;
    committed?: number;
    revealed?: number;
    resultHash?: string | null;
  }

  async function seedTask(options: SeedOptions = {}): Promise<string> {
    const taskId = options.taskId ?? TASK_ID;
    const createdAt = options.createdAt ?? new Date("2026-08-31T10:30:00.000Z");
    await seedManifest();
    await db.query(
      `INSERT INTO tasks (
         task_id, sequence, creator, status, outcome, bounty, verifier_count,
         committed_count, revealed_count, reward_bps, manifest_hash, manifest_pointer,
         rule_id, result_hash, commit_deadline, reveal_deadline, dispute_deadline,
         consensus_at, title, question, claim_count, source_count, primary_source,
         manifest_verified, created_block, tx_hash, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 2, $7, $8, 10000, $9, $10, $11, $12,
         to_timestamp($13), to_timestamp($14), $15, $16, $17, $18, $19, $20, $21,
         TRUE, 52352200, $22, $23, $24
       )`,
      [
        taskId,
        options.sequence ?? 1,
        CREATOR,
        options.status ?? TaskStatus.Finalized,
        options.outcome ?? 1,
        options.bounty ?? "2000000000000000",
        options.committed ?? 2,
        options.revealed ?? 2,
        MANIFEST_HASH,
        MANIFEST_POINTER,
        DEFAULT_RULE.ruleId,
        options.resultHash === undefined ? `0x${"e".repeat(64)}` : options.resultHash,
        COMMIT_DEADLINE,
        REVEAL_DEADLINE,
        options.consensusAt === null ? null : disputeDeadlineFrom(CONSENSUS_AT, DISPUTE_WINDOW),
        options.consensusAt === null ? null : (options.consensusAt ?? new Date(CONSENSUS_AT * 1000)),
        MANIFEST.title,
        MANIFEST.question,
        MANIFEST.claims.length,
        MANIFEST.sources.length,
        MANIFEST.sources[0]!.uri,
        `0x${"7".repeat(64)}`,
        createdAt,
        createdAt,
      ],
    );
    return taskId;
  }

  async function seedReports(taskId: string): Promise<void> {
    for (const [verifier, hash, body] of [
      [VERIFIER_A, REPORT_A_HASH, REPORT_A],
      [VERIFIER_B, REPORT_B_HASH, REPORT_B],
    ] as const) {
      await db.query(
        `INSERT INTO reports (task_id, verifier, commitment, report_hash, report_pointer, status,
                              model_id, pipeline_version, body, supported, contradicted, insufficient,
                              mean_confidence, evidence_coverage, compute_provider, compute_latency_ms,
                              body_verified, commit_tx, reveal_tx, committed_at, revealed_at)
         VALUES ($1, $2, $3, $4, $5, 'REVEALED', 'local-entailment/2-0.55', '0.1.0', $6,
                 1, 0, 1, 0.715, 1, 'local', 7, TRUE, $7, $8, to_timestamp($9), to_timestamp($10))`,
        [
          taskId,
          verifier.toLowerCase(),
          `0x${"9".repeat(64)}`,
          hash,
          `0g://${hash}`,
          JSON.stringify(body),
          `0x${"a".repeat(64)}`,
          `0x${"b".repeat(64)}`,
          COMMIT_DEADLINE - 60,
          CONSENSUS_AT - 30,
        ],
      );
    }
  }

  async function seedConsensus(
    taskId: string,
    outcome = "CONSENSUS",
    bps = 10_000,
    evaluatedAt = new Date(CONSENSUS_AT * 1000),
  ): Promise<void> {
    await db.query(
      `INSERT INTO consensus_results (task_id, outcome, agreement_bps, result_hash, result_pointer,
                                      conflicts, rewarded_verifiers, claims, evaluated_at, tx_hash)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8, $9)`,
      [
        taskId,
        outcome,
        bps,
        `0x${"e".repeat(64)}`,
        `0g://0x${"e".repeat(64)}`,
        JSON.stringify([VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()]),
        JSON.stringify([
          {
            claimId: "claim-001",
            claimText: MANIFEST.claims[0]!.claimText,
            majorityVerdict: "SUPPORTED",
            agreed: true,
            criticalConflict: false,
            evidenceCoverage: 1,
            evidenceOverlap: 1,
            agreeingVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()],
            dissentingVerifiers: [],
            verdicts: [
              { verifier: VERIFIER_A.toLowerCase(), verdict: "SUPPORTED", confidence: 0.82 },
              { verifier: VERIFIER_B.toLowerCase(), verdict: "SUPPORTED", confidence: 0.82 },
            ],
            reason: "2 verifiers agree on SUPPORTED with matching evidence",
          },
          {
            claimId: "claim-002",
            claimText: MANIFEST.claims[1]!.claimText,
            majorityVerdict: "INSUFFICIENT_EVIDENCE",
            agreed: true,
            criticalConflict: false,
            evidenceCoverage: 0,
            evidenceOverlap: 0,
            agreeingVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()],
            dissentingVerifiers: [],
            verdicts: [],
            reason: "2 verifiers agree that the sources do not settle this claim",
          },
        ]),
        evaluatedAt,
        `0x${"c".repeat(64)}`,
      ],
    );
  }

  async function seedEvents(taskId: string): Promise<void> {
    const rows: [string, number, string, string | null, Record<string, unknown>][] = [
      ["TaskCreated", 52_352_200, `0x${"7".repeat(64)}`, CREATOR, { bounty: "2000000000000000" }],
      [
        "ReportCommitted",
        52_352_210,
        `0x${"a".repeat(64)}`,
        VERIFIER_A.toLowerCase(),
        { commitment: `0x${"9".repeat(64)}` },
      ],
      [
        "ReportRevealed",
        52_352_220,
        `0x${"b".repeat(64)}`,
        VERIFIER_A.toLowerCase(),
        { reportHash: REPORT_A_HASH },
      ],
      [
        "TaskFinalized",
        52_352_230,
        `0x${"c".repeat(64)}`,
        null,
        { outcome: 1, resultHash: `0x${"e".repeat(64)}` },
      ],
    ];
    let logIndex = 0;
    for (const [name, block, txHash, actor, payload] of rows) {
      await db.query(
        `INSERT INTO chain_events (chain_id, tx_hash, log_index, block_number, block_time,
                                   event_name, task_id, actor, payload)
         VALUES (16602, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          txHash,
          logIndex,
          block,
          new Date((CONSENSUS_AT - 300 + logIndex * 60) * 1000),
          name,
          taskId,
          actor,
          JSON.stringify(payload),
        ],
      );
      logIndex += 1;
    }
  }

  it("computes the same display status in SQL as in TypeScript", async () => {
    const { rows } = await db.query<{ status: number; outcome: number; display: string }>(
      `SELECT t.status, t.outcome,
                (${DISPLAY_STATUS_SQL}) AS display
       FROM (SELECT s AS status, o AS outcome
             FROM generate_series(0, 9) s, generate_series(0, 3) o) t`,
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row.display).toBe(displayStatus(row.status, row.outcome));
    }
  });

  it("resolves a handle in both directions", async () => {
    const taskId = await seedTask({ sequence: 48 });
    expect(await refForTaskId(db, taskId)).toBe("PR-1048");
    expect(await taskIdForRef(db, "PR-1048")).toBe(taskId);
    expect(await resolveTaskId(db, "PR-1048")).toBe(taskId);
    expect(await resolveTaskId(db, taskId.toUpperCase())).toBe(taskId);
    await expect(resolveTaskId(db, "PR-9999")).rejects.toThrow(ProofRelayError);

    const batch = await refsForTaskIds(db, [taskId, `0x${"f".repeat(64)}`]);
    expect(batch.get(taskId)).toBe("PR-1048");
    expect(batch.size).toBe(1);
    expect((await refsForTaskIds(db, [])).size).toBe(0);
  });

  it("filters by creator and rejects a cursor it did not mint", async () => {
    await seedTask({ sequence: 1 });
    expect((await listTasks(context(db), { creator: CREATOR })).total).toBe(1);
    expect((await listTasks(context(db), { creator: VERIFIER_A })).total).toBe(0);
    await expect(listTasks(context(db), { cursor: "not-a-cursor" })).rejects.toThrow(
      ProofRelayError,
    );
  });

  it("returns a TaskListResponse every field of which is real", async () => {
    const taskId = await seedTask({ sequence: 48 });
    await seedReports(taskId);
    await seedConsensus(taskId);

    const response = await listTasks(context(db), {});
    expect(() => TaskListResponse.parse(response)).not.toThrow();
    expect(response.total).toBe(1);
    expect(response.counts.ALL).toBe(1);
    expect(response.counts.VERIFIED).toBe(1);
    expect(response.counts.DISPUTED).toBe(0);

    const item = response.items[0]!;
    expect(item.taskId).toBe(taskId);
    expect(item.ref).toBe("PR-1048");
    expect(item.title).toBe(MANIFEST.title);
    expect(item.status).toBe("VERIFIED");
    expect(item.rawStatus).toBe("FINALIZED");
    expect(item.outcome).toBe("CONSENSUS");
    expect(item.tone).toBe("lime");
    expect(item.agreementLabel).toBe("2/2 agree");
    expect(item.agreementPct).toBe(100);
    expect(item.bountyFormatted).toBe("0.002 0G");
    expect(item.claimCount).toBe(2);
    expect(item.syncRequired).toBe(false);
    expect(item.tx.explorerUrl).toBe(`https://chainscan-galileo.0g.ai/tx/0x${"7".repeat(64)}`);
  });

  it("filters by display group and pages with a stable cursor", async () => {
    await seedTask({ taskId: TASK_ID, sequence: 1, createdAt: new Date("2026-08-31T10:00:00Z") });
    await seedTask({
      taskId: `0x${"2".repeat(64)}`,
      sequence: 2,
      status: TaskStatus.Disputed,
      outcome: 0,
      resultHash: null,
      createdAt: new Date("2026-08-31T11:00:00Z"),
    });
    await seedTask({
      taskId: `0x${"3".repeat(64)}`,
      sequence: 3,
      status: TaskStatus.Revealing,
      outcome: 0,
      resultHash: null,
      consensusAt: null,
      createdAt: new Date("2026-08-31T12:00:00Z"),
    });

    const disputed = await listTasks(context(db), { status: "DISPUTED" });
    expect(disputed.total).toBe(1);
    expect(disputed.items[0]!.taskId).toBe(`0x${"2".repeat(64)}`);
    expect(disputed.counts.ALL).toBe(3);

    const firstPage = await listTasks(context(db), { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listTasks(context(db), { limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const seen = [...firstPage.items, ...secondPage.items].map((item) => item.taskId);
    expect(new Set(seen).size).toBe(3);

    const searched = await listTasks(context(db), { q: "Lisbon" });
    expect(searched.total).toBe(3);
  });

  it("builds a TaskDetail with claims, reports, consensus and a timeline", async () => {
    const taskId = await seedTask({ sequence: 48 });
    await seedReports(taskId);
    await seedConsensus(taskId);
    await seedEvents(taskId);

    const detail = await getTask(context(db), "PR-1048");
    expect(() => TaskDetail.parse(detail)).not.toThrow();

    expect(detail.syncRequired).toBe(false);
    expect(detail.manifest).not.toBeNull();
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]!.snapshotHash).toBe(MANIFEST.sources[0]!.snapshotHash);

    expect(detail.claims).toHaveLength(2);
    expect(detail.claims[0]!.ordinal).toBe("01");
    expect(detail.claims[0]!.displayVerdict).toBe("SUPPORTED");
    expect(detail.claims[0]!.agreed).toBe(true);
    expect(detail.claims[0]!.excerpt).toBe("0G Storage can be used as a standalone service.");
    expect(detail.claims[0]!.verdicts).toHaveLength(2);

    expect(detail.reports).toHaveLength(2);
    const report = detail.reports.find(
      (entry) => entry.verifier.toLowerCase() === VERIFIER_A.toLowerCase(),
    )!;
    expect(report.committed).toBe(true);
    expect(report.revealed).toBe(true);
    expect(report.reportHash).toBe(REPORT_A_HASH);
    expect(report.modelId).toBe("local-entailment/2-0.55");
    expect(report.computeLatencyMs).toBe(7);
    expect(report.commitTx.txHash).toBe(`0x${"a".repeat(64)}`);
    expect(report.commitTx.blockNumber).toBe(52_352_210);

    expect(detail.consensus?.outcome).toBe("CONSENSUS");
    expect(detail.consensus?.agreementBps).toBe(10_000);
    expect(detail.dispute).toBeNull();

    expect(detail.timeline.map((entry) => entry.label)).toEqual([
      "Task created",
      "Report committed",
      "Report revealed",
      "Task finalized",
    ]);
    expect(detail.timeline[0]!.detail).toContain("0.002 0G escrowed");
    expect(detail.timeline[3]!.detail).toContain("CONSENSUS");
    expect(detail.timeline[3]!.tx.explorerUrl).toContain("chainscan-galileo");
  });

  it("raises syncRequired when the row disagrees with a fresh chain read", async () => {
    const taskId = await seedTask({ sequence: 48, status: TaskStatus.Revealing, outcome: 0 });
    await seedReports(taskId);

    const detail = await getTask(context(db), taskId);
    expect(detail.syncRequired).toBe(true);
    expect(detail.rawStatus).toBe("REVEALING");
  });

  it("rewrites the row from the chain and clears the banner", async () => {
    const taskId = await seedTask({
      sequence: 48,
      status: TaskStatus.Revealing,
      outcome: 0,
      resultHash: null,
      consensusAt: null,
    });
    await seedEvents(taskId);

    const result = await syncTask(context(db), taskId);
    expect(result.syncState).toBe("OK");
    expect(result.status).toBe("FINALIZED");
    expect(result.changed).toContain("status");
    expect(result.changed).toContain("outcome");
    expect(result.task.syncRequired).toBe(false);
    expect(result.task.rawStatus).toBe("FINALIZED");
    expect(result.task.ref).toBe("PR-1048");

    const { rows } = await db.query<{ status: number; outcome: number; dispute_deadline: Date }>(
      "SELECT status, outcome, dispute_deadline FROM tasks WHERE task_id = $1",
      [taskId],
    );
    expect(rows[0]!.status).toBe(TaskStatus.Finalized);
    expect(rows[0]!.outcome).toBe(1);
    expect(rows[0]!.dispute_deadline.toISOString()).toBe(
      new Date((CONSENSUS_AT + DISPUTE_WINDOW) * 1000).toISOString(),
    );

    const reports = await db.query<{ verifier: string; revealed_at: Date }>(
      "SELECT verifier, revealed_at FROM reports WHERE task_id = $1 ORDER BY verifier",
      [taskId],
    );
    expect(reports.rows).toHaveLength(2);
  });

  it("indexes a task the read model has never seen", async () => {
    await seedManifest();
    const result = await syncTask(context(db), TASK_ID);
    expect(result.changed).toEqual(["inserted"]);
    expect(result.task.taskId).toBe(TASK_ID);
    expect(result.task.title).toBe(MANIFEST.title);
    expect(result.syncState).toBe("OK");
    // The first task of an empty read model is PR-1000 whichever path created
    // it. Numbering a sync-first task from 1 would have given it PR-1001 and
    // the same task PR-1000 after a replay, and the handle is what people paste.
    expect(result.ref).toBe(refForSequence(0));
  });

  it("refuses to index a task the chain does not have", async () => {
    const chain = chainStub({ status: TaskStatus.None, creator: `0x${"0".repeat(40)}` as Address });
    await expect(syncTask(context(db, chain), TASK_ID)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });

  it("returns null rather than a number when a metric has no sample", async () => {
    const stats = await workspaceStats(context(db));
    expect(() => WorkspaceStats.parse(stats)).not.toThrow();

    expect(stats.totalTasks).toBe(0);
    expect(stats.evidenceCoveragePct).toBeNull();
    expect(stats.evidenceCoverageSampleSize).toBe(0);
    expect(stats.medianVerificationSec).toBeNull();
    expect(stats.medianVerificationSampleSize).toBe(0);
    expect(stats.bountiesSettledWei).toBe("0");
    expect(stats.bountiesEscrowedWei).toBe("0");
    expect(stats.activeTasksTrendPct).toBeNull();
    expect(stats.evidenceCoverageTrendPct).toBeNull();
    expect(stats.bountiesSettledTrendPct).toBeNull();
  });

  it("compares the last seven days with the seven before", async () => {
    const current = new Date(NOW.getTime() - 2 * 86_400_000);
    const prior = new Date(NOW.getTime() - 10 * 86_400_000);

    const settled = await seedTask({ sequence: 1, createdAt: current });
    await seedTask({ taskId: `0x${"5".repeat(64)}`, sequence: 2, createdAt: current });
    const older = await seedTask({ taskId: `0x${"6".repeat(64)}`, sequence: 3, createdAt: prior });
    // Only the prior window has an evaluated task, so coverage has a prior value
    // and no current one.
    await seedConsensus(older, "CONSENSUS", 10_000, prior);

    for (const [taskId, amount, at] of [
      [settled, "3000000000000000", current],
      [older, "1000000000000000", prior],
    ] as const) {
      await db.query(
        "INSERT INTO allocations (task_id, beneficiary, amount, created_at) VALUES ($1, $2, $3, $4)",
        [taskId, VERIFIER_A.toLowerCase(), amount, at],
      );
    }

    const stats = await workspaceStats(context(db));
    expect(() => WorkspaceStats.parse(stats)).not.toThrow();
    expect(stats.activeTasksTrendPct).toBe(100);
    expect(stats.bountiesSettledTrendPct).toBe(200);
    // Nothing settled in the current window: "not measured", not "0% coverage".
    expect(stats.evidenceCoverageTrendPct).toBeNull();
  });

  it("measures coverage and verification time over the settled sample", async () => {
    const settled = await seedTask({
      sequence: 1,
      createdAt: new Date((CONSENSUS_AT - 42) * 1000),
      consensusAt: new Date(CONSENSUS_AT * 1000),
    });
    await seedConsensus(settled);
    await seedTask({
      taskId: `0x${"4".repeat(64)}`,
      sequence: 2,
      status: TaskStatus.Revealing,
      outcome: 0,
      resultHash: null,
      consensusAt: null,
      bounty: "5000000000000000",
    });
    await db.query(
      "INSERT INTO allocations (task_id, beneficiary, amount) VALUES ($1, $2, $3)",
      [settled, VERIFIER_A.toLowerCase(), "1000000000000000"],
    );

    const stats = await workspaceStats(context(db));
    expect(() => WorkspaceStats.parse(stats)).not.toThrow();

    expect(stats.totalTasks).toBe(2);
    expect(stats.activeTasks).toBe(1);
    expect(stats.verifiedTasks).toBe(1);
    expect(stats.inReview).toBe(1);
    expect(stats.openQueue).toBe(0);
    // One of the two settled claims cited evidence.
    expect(stats.evidenceCoveragePct).toBe(50);
    expect(stats.evidenceCoverageSampleSize).toBe(2);
    expect(stats.medianVerificationSec).toBe(42);
    expect(stats.medianVerificationSampleSize).toBe(1);
    expect(stats.bountiesSettledWei).toBe("1000000000000000");
    expect(stats.bountiesEscrowedWei).toBe("5000000000000000");
  });
});
