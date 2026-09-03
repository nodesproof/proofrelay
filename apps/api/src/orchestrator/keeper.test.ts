/**
 * The keeper's refusals, and the queue underneath it.
 *
 * The contract already reverts on a non-revealer and on a duplicate — that is
 * `_requireRevealedSet`, and the Solidity suite covers it. What is asserted
 * here is the earlier thing: that the keeper never gets that far. A revert is a
 * broadcast transaction that failed in public against a task people are
 * watching, so every check below is measured by whether `send` was called at
 * all, not by what the chain would have done about it.
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Address, Hex } from "viem";
import type { ReportOnChain, TaskOnChain } from "@proofrelay/chain-client";
import { loadConfig, type Config } from "@proofrelay/config";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import {
  ConsensusResult,
  DEFAULT_RULE,
  Outcome,
  ProofRelayError,
  SCHEMA_VERSION,
  TaskStatus,
  objectHash,
} from "@proofrelay/schemas";
import { Logger } from "../observability.js";
import {
  CONSENSUS_REWARD_BPS,
  Keeper,
  checkFinalizeConsensus,
  submissionFor,
  type KeeperChain,
} from "./keeper.js";
import { Orchestrator } from "./orchestrator.js";
import * as queue from "./queue.js";

const VERIFIER_A = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const VERIFIER_B = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address;
const OUTSIDER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9" as Address;
const CREATOR = "0xa7D6b126d6dCBc75319f7c1B7b43524cC791E02D" as Address;

const TASK_ID = `0x${"ee".repeat(32)}` as Hex;
const MANIFEST_HASH = `0x${"a1".repeat(32)}` as Hex;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

/* ── fixtures ────────────────────────────────────────────────────────────── */

function claimConsensus() {
  return {
    claimId: "claim-001",
    claimText: "The release notes list a dependency bump.",
    majorityVerdict: "SUPPORTED" as const,
    agreed: true,
    criticalConflict: false,
    evidenceCoverage: 1,
    evidenceOverlap: 1,
    agreeingVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()],
    dissentingVerifiers: [],
    verdicts: [
      { verifier: VERIFIER_A.toLowerCase(), verdict: "SUPPORTED" as const, confidence: 0.81 },
      { verifier: VERIFIER_B.toLowerCase(), verdict: "SUPPORTED" as const, confidence: 0.77 },
    ],
    reason: "2 verifiers agree",
  };
}

function consensusResult(overrides: Record<string, unknown> = {}): ConsensusResult {
  return ConsensusResult.parse({
    kind: "consensus-result",
    schemaVersion: SCHEMA_VERSION,
    producer: "proofrelay-api/1.0.0",
    taskId: TASK_ID,
    manifestHash: MANIFEST_HASH,
    ruleId: DEFAULT_RULE.ruleId,
    outcome: "CONSENSUS",
    agreementBps: 10_000,
    claims: [claimConsensus()],
    conflicts: [],
    reportHashes: [`0x${"b1".repeat(32)}`, `0x${"b2".repeat(32)}`],
    rewardedVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase()],
    evaluatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
}

function chainTask(overrides: Partial<TaskOnChain> = {}): TaskOnChain {
  return {
    creator: CREATOR,
    bounty: 2_000_000_000_000_000n,
    verifierCount: 2,
    commitDeadline: 1_000,
    revealDeadline: 2_000,
    disputeWindow: 900,
    consensusAt: 0,
    committedCount: 2,
    revealedCount: 2,
    rewardBps: 0,
    status: TaskStatus.Revealing,
    outcome: 0,
    manifestHash: MANIFEST_HASH,
    ruleId: DEFAULT_RULE.ruleId as Hex,
    resultHash: ZERO32,
    manifestPointer: "local://manifest",
    ...overrides,
  };
}

function chainReport(verifier: Address, revealed = true): ReportOnChain {
  return {
    verifier,
    commitment: `0x${"c1".repeat(32)}` as Hex,
    revealed,
    reportHash: revealed ? (`0x${"b1".repeat(32)}` as Hex) : ZERO32,
    reportPointer: revealed ? "local://report" : "",
    committedAt: 900,
    revealedAt: revealed ? 1_500 : 0,
  };
}

function reportMap(entries: Array<[Address, boolean]>): Map<string, ReportOnChain> {
  return new Map(entries.map(([address, revealed]) => [address.toLowerCase(), chainReport(address, revealed)]));
}

function codes(result: { failures: Array<{ code: string }> }): string[] {
  return result.failures.map((failure) => failure.code);
}

/** Job failures are expected below; their error lines would drown the report. */
function quietLogger(): Logger {
  const noop = () => undefined;
  return Object.assign(new Logger("error"), {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => quietLogger(),
  });
}

const unusedStorage = {
  driver: "test",
  put: () => Promise.reject(new Error("storage must not be used here")),
  putBytes: () => Promise.reject(new Error("storage must not be used here")),
  get: () => Promise.reject(new Error("storage must not be used here")),
  getJson: () => Promise.reject(new Error("storage must not be used here")),
  has: () => Promise.resolve(false),
  health: () => Promise.resolve({ ok: true, detail: null, latencyMs: 0 }),
} as unknown as StorageAdapter;

class FakeChain implements KeeperChain {
  readonly chainId = 16_602;
  readonly contract = "0xc1E353cb44eA09729143f06Af97E51FB952b33D7" as Address;
  readonly account = "0x1111111111111111111111111111111111111111" as Address;
  readonly sent: Array<{ functionName: string; args: readonly unknown[] }> = [];

  constructor(
    private readonly task: TaskOnChain,
    private readonly reports: Map<string, ReportOnChain>,
    private readonly nowSec = 3_000,
  ) {}

  getTask = async (): Promise<TaskOnChain> => this.task;
  getReport = async (_taskId: Hex, verifier: Address): Promise<ReportOnChain> =>
    this.reports.get(verifier.toLowerCase()) ?? chainReport(verifier, false);
  getDispute = async () => {
    throw new Error("not used");
  };
  getTaskVerifiers = async (): Promise<readonly Address[]> => [VERIFIER_A, VERIFIER_B];
  params = async () => {
    throw new Error("not used");
  };
  blockNumber = async (): Promise<bigint> => 1n;
  blockTimestamp = async (): Promise<number> => this.nowSec;
  balanceOf = async (): Promise<bigint> => 10n ** 18n;
  totalLiabilities = async (): Promise<bigint> => 0n;
  send = async (functionName: string, args: readonly unknown[]) => {
    this.sent.push({ functionName, args });
    return {
      txHash: `0x${"fe".repeat(32)}` as Hex,
      blockNumber: 2n,
      gasUsed: 100_000n,
      status: "success" as const,
    };
  };
}

/* ── the checks ──────────────────────────────────────────────────────────── */

describe("finalizeConsensus pre-submit checks", () => {
  const result = consensusResult();
  const submission = submissionFor(result);
  const reports = reportMap([
    [VERIFIER_A, true],
    [VERIFIER_B, true],
  ]);

  it("derives the submission the artifact implies", () => {
    expect(submission.outcome).toBe(Outcome.Consensus);
    expect(submission.rewardBps).toBe(CONSENSUS_REWARD_BPS);
    expect(submission.beneficiaries).toEqual([VERIFIER_A, VERIFIER_B]);
    expect(submission.resultHash).toBe(objectHash(result));
  });

  it("names no beneficiary and no reward on a conflict", () => {
    const conflict = submissionFor(
      consensusResult({ outcome: "CONFLICT", agreementBps: 0, rewardedVerifiers: [] }),
    );
    expect(conflict.outcome).toBe(Outcome.Conflict);
    expect(conflict.beneficiaries).toEqual([]);
    expect(conflict.rewardBps).toBe(0);
  });

  it("accepts a settled task once every verifier revealed", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask(),
      result,
      reports,
      nowSec: 1_800,
    });
    expect(check.failures).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("refuses a beneficiary that did not reveal", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask(),
      result,
      reports: reportMap([
        [VERIFIER_A, true],
        [VERIFIER_B, false],
      ]),
      nowSec: 3_000,
    });
    expect(check.ok).toBe(false);
    expect(codes(check)).toContain("BENEFICIARY_NOT_REVEALER");
  });

  it("refuses a beneficiary the chain has no report for at all", () => {
    const check = checkFinalizeConsensus({
      submission: { ...submission, beneficiaries: [VERIFIER_A, OUTSIDER] },
      task: chainTask(),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(check.ok).toBe(false);
    expect(codes(check)).toContain("BENEFICIARY_NOT_REVEALER");
    expect(codes(check)).toContain("BENEFICIARY_NOT_REWARDED");
  });

  it("refuses a duplicate beneficiary", () => {
    const check = checkFinalizeConsensus({
      submission: { ...submission, beneficiaries: [VERIFIER_A, VERIFIER_A] },
      task: chainTask(),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(check.ok).toBe(false);
    expect(codes(check)).toContain("DUPLICATE_BENEFICIARY");
  });

  it("refuses to finalize before the reveal deadline while a verifier is still out", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask({ revealedCount: 1 }),
      result,
      reports,
      nowSec: 1_999,
    });
    expect(check.ok).toBe(false);
    expect(codes(check)).toContain("REVEAL_NOT_CLOSED");
  });

  it("allows it once that deadline has passed", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask({ revealedCount: 1 }),
      result,
      reports,
      nowSec: 2_001,
    });
    expect(codes(check)).not.toContain("REVEAL_NOT_CLOSED");
  });

  it("refuses a resultHash that is not the hash of the artifact", () => {
    const check = checkFinalizeConsensus({
      submission: { ...submission, resultHash: `0x${"99".repeat(32)}` as Hex },
      task: chainTask(),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(check.ok).toBe(false);
    expect(codes(check)).toContain("RESULT_HASH_MISMATCH");
  });

  it("refuses a task that is not in Revealing", () => {
    for (const status of [TaskStatus.Committing, TaskStatus.Consensus, TaskStatus.Finalized]) {
      const check = checkFinalizeConsensus({
        submission,
        task: chainTask({ status }),
        result,
        reports,
        nowSec: 3_000,
      });
      expect(codes(check)).toContain("STATUS_NOT_REVEALING");
    }
  });

  it("refuses a task the chain has never seen", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask({ status: TaskStatus.None }),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(codes(check)).toEqual(["TASK_NOT_FOUND"]);
  });

  it("refuses an artifact evaluated against another manifest, task or rule", () => {
    const check = checkFinalizeConsensus({
      submission,
      task: chainTask({ manifestHash: `0x${"cc".repeat(32)}` as Hex, ruleId: `0x${"dd".repeat(32)}` as Hex }),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(codes(check)).toContain("MANIFEST_HASH_MISMATCH");
    expect(codes(check)).toContain("RULE_ID_MISMATCH");
  });

  it("refuses beneficiaries on a conflict, and an empty list on a consensus", () => {
    const conflict = consensusResult({ outcome: "CONFLICT", agreementBps: 0, rewardedVerifiers: [] });
    const withNames = checkFinalizeConsensus({
      submission: { ...submissionFor(conflict), beneficiaries: [VERIFIER_A] },
      task: chainTask(),
      result: conflict,
      reports,
      nowSec: 3_000,
    });
    expect(codes(withNames)).toContain("BENEFICIARIES_NOT_ALLOWED");

    const empty = checkFinalizeConsensus({
      submission: { ...submission, beneficiaries: [] },
      task: chainTask(),
      result,
      reports,
      nowSec: 3_000,
    });
    expect(codes(empty)).toContain("BENEFICIARIES_EMPTY");
  });

  it("refuses a reward rate above the denominator, or any reward on a conflict", () => {
    expect(
      codes(
        checkFinalizeConsensus({
          submission: { ...submission, rewardBps: 10_001 },
          task: chainTask(),
          result,
          reports,
          nowSec: 3_000,
        }),
      ),
    ).toContain("REWARD_BPS_INVALID");

    const conflict = consensusResult({ outcome: "CONFLICT", agreementBps: 0, rewardedVerifiers: [] });
    expect(
      codes(
        checkFinalizeConsensus({
          submission: { ...submissionFor(conflict), rewardBps: 5_000 },
          task: chainTask(),
          result: conflict,
          reports,
          nowSec: 3_000,
        }),
      ),
    ).toContain("REWARD_BPS_INVALID");
  });

  it("refuses more beneficiaries than the task has verifiers", () => {
    const wide = consensusResult({
      rewardedVerifiers: [VERIFIER_A.toLowerCase(), VERIFIER_B.toLowerCase(), OUTSIDER.toLowerCase()],
    });
    const check = checkFinalizeConsensus({
      submission: { ...submissionFor(wide), beneficiaries: [VERIFIER_A, VERIFIER_B, OUTSIDER] },
      task: chainTask({ verifierCount: 2 }),
      result: wide,
      reports,
      nowSec: 3_000,
    });
    expect(codes(check)).toContain("BENEFICIARY_COUNT");
  });
});

/**
 * The rescue sweep. Its bug was not that it did the wrong thing but that it did
 * the right thing three days late: it subtracted `params.keeperGracePeriod`
 * from the deadline before considering a stuck task, and the deployed contract
 * requires no grace at all — so a bounty nobody verified sat stranded for three
 * days that the chain would have released immediately.
 */
describe("the keeper's rescue sweep", () => {
  const REVEAL_DEADLINE = 2_000;
  /** Matches the `params()` the fake chain below returns. */
  const KEEPER_GRACE = 259_200;

  function sweepKeeper(nowSec: number, sent: string[]) {
    const chain = {
      chainId: 16602,
      contract: `0x${"c1".repeat(20)}` as Address,
      account: CREATOR,
      async blockNumber() { return 1n; },
      async blockTimestamp() { return nowSec; },
      async balanceOf() { return 10n ** 18n; },
      async totalLiabilities() { return 0n; },
      async params() {
        return {
          conflictRateBps: 5_000, challengeBondBps: 1_000, challengerRewardBps: 1_000,
          adjudicatorSplitBps: 5_000, verifierSlashBps: 0, minBounty: 10n ** 14n,
          minVerifierStake: 0n, keeperGracePeriod: 259_200, adjudicationWindow: 604_800,
          claimGracePeriod: 604_800,
        };
      },
      async getTask() {
        return chainTask({ status: TaskStatus.Revealing, revealDeadline: REVEAL_DEADLINE, revealedCount: 0 });
      },
      async getReport() { throw new Error("not needed"); },
      async getDispute() { throw new Error("not needed"); },
      async getTaskVerifiers() { return []; },
      async send(action: string) {
        sent.push(action);
        return { txHash: `0x${"ab".repeat(32)}` as Hex, blockNumber: 1n, gasUsed: 1n, status: "success" as const };
      },
    };
    // Only the expiry query returns a row; the other two sweeps find nothing.
    const pool = {
      query: async (sql: string) => ({
        rows: /reveal_deadline/.test(sql) ? [{ task_id: TASK_ID }] : [],
      }),
    } as unknown as pg.Pool;
    return new Keeper({
      pool,
      config: loadConfig(),
      storage: unusedStorage,
      logger: quietLogger(),
      chain: chain as never,
    });
  }

  /**
   * The contract opens expireTask at `revealDeadline + keeperGracePeriod`, and
   * expiry pays the revealers the conflict rate — half — where a consensus
   * settlement pays them in full and leaves the dispute window open. The keeper
   * must not race its own settlement to the earlier of the two.
   */
  it("waits out the grace period the contract enforces", async () => {
    const sent: string[] = [];
    const counts = await sweepKeeper(REVEAL_DEADLINE + 1, sent).runFallbacks(4);
    expect(sent).toEqual([]);
    expect(counts.expired).toBe(0);
  });

  it("does not expire on the last second of the grace either", async () => {
    const sent: string[] = [];
    await sweepKeeper(REVEAL_DEADLINE + KEEPER_GRACE, sent).runFallbacks(4);
    expect(sent).toEqual([]);
  });

  it("expires once the grace has passed", async () => {
    const sent: string[] = [];
    const counts = await sweepKeeper(REVEAL_DEADLINE + KEEPER_GRACE + 1, sent).runFallbacks(4);
    expect(sent).toEqual(["expireTask"]);
    expect(counts.expired).toBe(1);
  });

  it("still refuses to expire a task whose reveal deadline has not passed", async () => {
    const sent: string[] = [];
    const counts = await sweepKeeper(REVEAL_DEADLINE, sent).runFallbacks(4);
    expect(sent).toEqual([]);
    expect(counts.expired).toBe(0);
  });
});

describe("keeper without a key", () => {
  const config: Config = {
    ...loadConfig(),
    orchestrator: { ...loadConfig().orchestrator, keeperPrivateKey: undefined },
  };

  it("is disabled, says so, and lets the API keep serving", async () => {
    const keeper = new Keeper({
      pool: {} as pg.Pool,
      config,
      storage: unusedStorage,
      logger: quietLogger(),
    });
    expect(keeper.enabled).toBe(false);
    expect(keeper.address).toBeNull();
    expect(await keeper.tick()).toEqual({
      disabled: true,
      finalized: 0,
      expired: 0,
      disputesExpired: 0,
      skipped: 0,
    });
  });

  it("fails a FINALIZATION job with NOT_CONFIGURED rather than pretending to settle", async () => {
    const keeper = new Keeper({
      pool: {} as pg.Pool,
      config,
      storage: unusedStorage,
      logger: quietLogger(),
    });
    const handler = keeper.finalizationHandler();
    await expect(
      handler({
        job: { id: 1, taskId: TASK_ID, payload: {} } as never,
        pool: {} as pg.Pool,
        logger: quietLogger(),
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("rejects a FINALIZATION job whose taskId is not a task id", async () => {
    const keeper = new Keeper({
      pool: {} as pg.Pool,
      config,
      storage: unusedStorage,
      logger: quietLogger(),
    });
    const handler = keeper.finalizationHandler();
    // `consensus_results.task_id` is stored lowercase, so an id in any other
    // shape used to be looked up verbatim, miss, and be reported as "nothing
    // has been evaluated for this task" — a refusal that reads like a missing
    // artifact rather than like the malformed job it is.
    for (const taskId of [undefined, "", "PR-1048", TASK_ID.slice(0, 40)]) {
      await expect(
        handler({
          job: { id: 1, taskId: taskId ?? null, payload: {} } as never,
          pool: {} as pg.Pool,
          logger: quietLogger(),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});

/* ── database-backed ─────────────────────────────────────────────────────── */

async function openPool(): Promise<{ ok: true; pool: pg.Pool } | { ok: false; detail: string }> {
  const pool = new pg.Pool({
    connectionString: loadConfig().api.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 3_000,
  });
  pool.on("error", () => undefined);
  try {
    await pool.query("SELECT 1");
    return { ok: true, pool };
  } catch (error) {
    await pool.end().catch(() => undefined);
    return { ok: false, detail: String((error as Error).message).slice(0, 160) };
  }
}

const probe = await openPool();
if (!probe.ok) {
  console.warn(
    `[keeper.test] DATABASE_URL is unreachable (${probe.detail}) — skipping the queue, ` +
      "orchestrator and keeper-submission suites. Start Postgres and run `npm run migrate` to run them.",
  );
}
const describeDb = probe.ok ? describe : describe.skip;

const QUEUE_TASK = `0x${"11".repeat(32)}`;
const KEEPER_TASK = TASK_ID.toLowerCase();

afterAll(async () => {
  if (!probe.ok) return;
  const { pool } = probe;
  await pool
    .query("DELETE FROM jobs WHERE task_id = ANY($1::text[]) OR idempotency_key LIKE 'keepertest:%'", [
      [QUEUE_TASK, KEEPER_TASK],
    ])
    .catch(() => undefined);
  await pool
    .query("DELETE FROM tasks WHERE task_id = ANY($1::text[])", [[QUEUE_TASK, KEEPER_TASK]])
    .catch(() => undefined);
  await pool.end().catch(() => undefined);
});

async function seedTask(pool: pg.Pool, taskId: string, sequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO tasks (task_id, sequence, creator, status, bounty, verifier_count,
                        manifest_hash, manifest_pointer, rule_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 2, $6, 'local://manifest', $7, now(), now())
     ON CONFLICT (task_id) DO UPDATE SET status = EXCLUDED.status`,
    [
      taskId,
      sequence,
      CREATOR,
      TaskStatus.Revealing,
      "2000000000000000",
      MANIFEST_HASH,
      DEFAULT_RULE.ruleId,
    ],
  );
}

describeDb("job queue", () => {
  const pool = (probe as { pool: pg.Pool }).pool;

  /**
   * Pins `maxAttempts` explicitly rather than leaning on the default: what this
   * asserts is the RETRYABLE -> RETRYABLE -> FINAL transition, not how large the
   * production budget happens to be.
   */
  it("backs off exponentially and stops once its attempts are spent", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    await pool.query("DELETE FROM jobs WHERE task_id = $1", [QUEUE_TASK]);

    const { job, created } = await queue.enqueue(pool, {
      jobType: "VERIFIER_DISPATCH",
      taskId: QUEUE_TASK,
      payload: { verifier: VERIFIER_A },
    });
    expect(created).toBe(true);
    expect(job.status).toBe("PENDING");

    // Re-enqueuing the same work is a no-op, not a second job.
    const again = await queue.enqueue(pool, { jobType: "VERIFIER_DISPATCH", taskId: QUEUE_TASK });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(job.id);

    const error = new ProofRelayError("COMPUTE_UNAVAILABLE", "0G Compute is unreachable");
    const at = new Date();

    const first = await queue.fail(pool, job.id, error, { maxAttempts: 3 }, at);
    expect(first?.status).toBe("FAILED_RETRYABLE");
    expect(first?.attempts).toBe(1);
    expect(first?.lastErrorCode).toBe("COMPUTE_UNAVAILABLE");
    expect(delayMs(first?.nextRetryAt, at)).toBe(queue.retryDelayMs(1));

    const second = await queue.fail(pool, job.id, error, { maxAttempts: 3 }, at);
    expect(second?.status).toBe("FAILED_RETRYABLE");
    expect(second?.attempts).toBe(2);
    expect(delayMs(second?.nextRetryAt, at)).toBe(queue.retryDelayMs(2));

    const third = await queue.fail(pool, job.id, error, { maxAttempts: 3 }, at);
    expect(third?.status).toBe("FAILED_FINAL");
    expect(third?.attempts).toBe(3);
    expect(third?.nextRetryAt).toBeNull();
  });

  it("computes the same backoff in TypeScript as the UPDATE does in SQL", () => {
    expect(queue.retryDelayMs(1)).toBe(queue.BASE_RETRY_MS);
    expect(queue.retryDelayMs(2)).toBe(queue.BASE_RETRY_MS * 2);
    expect(queue.retryDelayMs(3)).toBe(queue.BASE_RETRY_MS * 4);
    expect(queue.retryDelayMs(40)).toBe(queue.MAX_RETRY_MS);
  });

  it("sends a non-retryable failure straight to FAILED_FINAL", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    const key = `keepertest:nonretryable:${Date.now()}`;
    const { job } = await queue.enqueue(pool, {
      jobType: "NOTIFICATION",
      taskId: QUEUE_TASK,
      idempotencyKey: key,
    });
    const outcome = await queue.fail(
      pool,
      job.id,
      new ProofRelayError("CONTENT_HASH_MISMATCH", "report body does not match its hash", {
        retryable: false,
      }),
    );
    expect(outcome?.attempts).toBe(1);
    expect(outcome?.status).toBe("FAILED_FINAL");
    expect(outcome?.nextRetryAt).toBeNull();
  });

  it("claims a due job exactly once and records the lease", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    const key = `keepertest:claim:${Date.now()}`;
    await queue.enqueue(pool, {
      jobType: "SOURCE_SNAPSHOT",
      taskId: QUEUE_TASK,
      idempotencyKey: key,
    });

    const [first, second] = await Promise.all([
      queue.claim(pool, { workerId: "worker-a", limit: 5, jobTypes: ["SOURCE_SNAPSHOT"] }),
      queue.claim(pool, { workerId: "worker-b", limit: 5, jobTypes: ["SOURCE_SNAPSHOT"] }),
    ]);
    const claimed = [...(first ?? []), ...(second ?? [])].filter(
      (job) => job.idempotencyKey === key,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("RUNNING");
    expect(claimed[0]?.lockedBy).toMatch(/^worker-[ab]$/);
    expect(claimed[0]?.lockedAt).toBeInstanceOf(Date);

    const counts = await queue.countsByStatus(pool);
    expect(counts.RUNNING).toBeGreaterThanOrEqual(1);

    await queue.complete(pool, claimed[0]!.id);
    expect((await queue.getJob(pool, claimed[0]!.id))?.status).toBe("DONE");
  });

  it("reaps a job whose worker died holding the lease", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    const key = `keepertest:lease:${Date.now()}`;
    await queue.enqueue(pool, { jobType: "MANIFEST_UPLOAD", taskId: QUEUE_TASK, idempotencyKey: key });
    const [claimed] = await queue.claim(pool, {
      workerId: "doomed",
      limit: 1,
      jobTypes: ["MANIFEST_UPLOAD"],
    });
    expect(claimed?.status).toBe("RUNNING");

    const later = new Date(Date.now() + queue.LEASE_MS + 60_000);
    const reaped = await queue.reapStaleLeases(pool, queue.LEASE_MS, later);
    const mine = reaped.find((job) => job.idempotencyKey === key);
    expect(mine?.status).toBe("FAILED_RETRYABLE");
    expect(mine?.attempts).toBe(1);
    expect(mine?.lockedBy).toBeNull();
  });
});

function delayMs(next: Date | null | undefined, from: Date): number | null {
  if (!next) return null;
  return next.getTime() - from.getTime();
}

describeDb("orchestrator never advances a task it failed to evaluate", () => {
  const pool = (probe as { pool: pg.Pool }).pool;

  it("exhausts its attempts on a compute failure and leaves the task where it was", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    await pool.query("DELETE FROM jobs WHERE task_id = $1", [QUEUE_TASK]);

    let clock = new Date();
    const orchestrator = new Orchestrator({
      pool,
      config: loadConfig(),
      storage: unusedStorage,
      logger: quietLogger(),
      workerId: "test-worker",
      now: () => clock,
      handlers: {
        CONSENSUS_EVALUATION: async () => {
          throw new ProofRelayError("COMPUTE_UNAVAILABLE", "0G Compute is unreachable");
        },
      },
    });

    const key = `keepertest:invariant:${Date.now()}`;
    await queue.enqueue(
      pool,
      { jobType: "CONSENSUS_EVALUATION", taskId: QUEUE_TASK, idempotencyKey: key },
      clock,
    );

    // Driven off the constant, so raising the production retry budget does not
    // silently turn this into an assertion about a number nobody chose.
    const statuses: string[] = [];
    for (let attempt = 0; attempt < queue.MAX_ATTEMPTS; attempt += 1) {
      const tick = await orchestrator.runOnce(8);
      expect(tick.failed).toBeGreaterThanOrEqual(1);
      const job = await queue.findJob(pool, key);
      statuses.push(job?.status ?? "MISSING");
      // Jump past the backoff so the next pass finds the job due again.
      clock = new Date(clock.getTime() + queue.retryDelayMs(attempt + 1) + 1_000);
    }

    expect(statuses.slice(0, -1)).toEqual(
      Array.from({ length: queue.MAX_ATTEMPTS - 1 }, () => "FAILED_RETRYABLE"),
    );
    expect(statuses.at(-1)).toBe("FAILED_FINAL");
    const job = await queue.findJob(pool, key);
    expect(job?.attempts).toBe(queue.MAX_ATTEMPTS);
    expect(job?.lastErrorCode).toBe("COMPUTE_UNAVAILABLE");

    const task = await pool.query<{ status: number }>(
      "SELECT status FROM tasks WHERE task_id = $1",
      [QUEUE_TASK],
    );
    expect(task.rows[0]?.status).toBe(TaskStatus.Revealing);
  });

  it("fails a job type nobody registered instead of leaving it pending forever", async () => {
    await seedTask(pool, QUEUE_TASK, 990_001);
    const orchestrator = new Orchestrator({
      pool,
      config: loadConfig(),
      storage: unusedStorage,
      logger: quietLogger(),
      workerId: "test-worker",
    });
    expect(orchestrator.handles()).toContain("CONSENSUS_EVALUATION");
    expect(orchestrator.handles()).not.toContain("FINALIZATION");

    const key = `keepertest:unhandled:${Date.now()}`;
    await queue.enqueue(pool, {
      jobType: "FINALIZATION",
      taskId: QUEUE_TASK,
      idempotencyKey: key,
    });
    await orchestrator.runOnce(8);

    const job = await queue.findJob(pool, key);
    expect(job?.status).toBe("FAILED_FINAL");
    expect(job?.lastErrorCode).toBe("NOT_CONFIGURED");
  });
});

describeDb("keeper submission", () => {
  const pool = (probe as { pool: pg.Pool }).pool;
  const result = consensusResult();
  const resultHash = objectHash(result);

  async function seedConsensus(): Promise<void> {
    await seedTask(pool, KEEPER_TASK, 990_002);
    await pool.query(
      `INSERT INTO consensus_results
         (task_id, outcome, agreement_bps, result_hash, result_pointer, conflicts,
          rewarded_verifiers, claims, body, evaluated_at)
       VALUES ($1, $2, $3, $4, 'local://result', '[]'::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (task_id) DO UPDATE SET body = EXCLUDED.body, result_hash = EXCLUDED.result_hash`,
      [
        KEEPER_TASK,
        result.outcome,
        result.agreementBps,
        resultHash,
        JSON.stringify(result.rewardedVerifiers),
        JSON.stringify(result.claims),
        JSON.stringify(result),
        result.evaluatedAt,
      ],
    );
  }

  function keeperWith(chain: FakeChain): Keeper {
    return new Keeper({
      pool,
      config: loadConfig(),
      storage: unusedStorage,
      logger: quietLogger(),
      chain,
    });
  }

  it("submits when the chain agrees with the artifact", async () => {
    await seedConsensus();
    const chain = new FakeChain(
      chainTask(),
      reportMap([
        [VERIFIER_A, true],
        [VERIFIER_B, true],
      ]),
    );
    const outcome = await keeperWith(chain).finalizeConsensusFor(KEEPER_TASK as Hex);
    expect(outcome.submitted).toBe(true);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]?.functionName).toBe("finalizeConsensus");
    expect(chain.sent[0]?.args[1]).toBe(resultHash);
    expect(chain.sent[0]?.args[2]).toBe(Outcome.Consensus);
    expect(chain.sent[0]?.args[4]).toBe(CONSENSUS_REWARD_BPS);
  });

  it("never broadcasts when a named beneficiary did not reveal", async () => {
    await seedConsensus();
    const chain = new FakeChain(
      chainTask(),
      reportMap([
        [VERIFIER_A, true],
        [VERIFIER_B, false],
      ]),
    );
    const outcome = await keeperWith(chain).finalizeConsensusFor(KEEPER_TASK as Hex);
    expect(outcome.submitted).toBe(false);
    expect(chain.sent).toHaveLength(0);
    expect(outcome.submitted === false && codes(outcome)).toContain("BENEFICIARY_NOT_REVEALER");
  });

  it("never broadcasts before the reveal window closes", async () => {
    await seedConsensus();
    const chain = new FakeChain(
      chainTask({ revealedCount: 1 }),
      reportMap([
        [VERIFIER_A, true],
        [VERIFIER_B, true],
      ]),
      1_500,
    );
    const outcome = await keeperWith(chain).finalizeConsensusFor(KEEPER_TASK as Hex);
    expect(outcome.submitted).toBe(false);
    expect(chain.sent).toHaveLength(0);
    expect(outcome.submitted === false && codes(outcome)).toContain("REVEAL_NOT_CLOSED");
  });

  it("retries a job blocked only on the reveal window, and gives up on a real disagreement", async () => {
    await seedConsensus();
    const waiting = keeperWith(
      new FakeChain(
        chainTask({ revealedCount: 1 }),
        reportMap([
          [VERIFIER_A, true],
          [VERIFIER_B, true],
        ]),
        1_500,
      ),
    );
    const job = { id: 1, taskId: KEEPER_TASK, payload: {} } as never;
    const context = { job, pool, logger: quietLogger() };
    await expect(waiting.finalizationHandler()(context)).rejects.toMatchObject({
      retryable: true,
    });

    const wrong = keeperWith(
      new FakeChain(
        chainTask({ status: TaskStatus.Finalized }),
        reportMap([
          [VERIFIER_A, true],
          [VERIFIER_B, true],
        ]),
      ),
    );
    await expect(wrong.finalizationHandler()(context)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("refuses when no consensus artifact has been evaluated", async () => {
    await pool.query("DELETE FROM consensus_results WHERE task_id = $1", [KEEPER_TASK]);
    await seedTask(pool, KEEPER_TASK, 990_002);
    const chain = new FakeChain(chainTask(), reportMap([[VERIFIER_A, true]]));
    const outcome = await keeperWith(chain).finalizeConsensusFor(KEEPER_TASK as Hex);
    expect(outcome.submitted).toBe(false);
    expect(chain.sent).toHaveLength(0);
    expect(outcome.submitted === false && codes(outcome)).toContain("RESULT_MISSING");
  });
});
