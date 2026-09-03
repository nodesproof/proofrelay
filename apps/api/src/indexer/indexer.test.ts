/**
 * Projection tests against a real Postgres.
 *
 * These run against `DATABASE_URL` inside a throwaway schema, because the four
 * properties under test are properties of SQL — upsert semantics, a unique
 * index on `sequence`, `ON CONFLICT DO NOTHING` returning a row count — and a
 * fake would only test the fake. When the database is unreachable the suite
 * skips with a message rather than failing: a missing local Postgres is not a
 * broken indexer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type {
  DisputeOnChain,
  ProofRelayEventName,
  ReportOnChain,
  TaskOnChain,
  VerifierOnChain,
} from "@proofrelay/chain-client";
import { loadEnv, repoRoot } from "@proofrelay/config";
import {
  ProofRelayError,
  SCHEMA_VERSION,
  bytesObjectHash,
  canonicalBytes,
  objectHash,
  taskRef,
  type TaskManifest,
  type VerifierReport,
} from "@proofrelay/schemas";
import type { FetchedObject } from "@proofrelay/storage-adapter";
import { withTransaction } from "../db.js";
import { metrics } from "../observability.js";
import { ArtifactSync, type ArtifactStore } from "./artifact-sync.js";
import {
  applyEvent,
  eventActor,
  eventTaskId,
  type ArtifactSyncPayload,
  type ChainReader,
  type EventArgs,
  enqueueConsensusEvaluation,
} from "./projections.js";

loadEnv();

const CHAIN_ID = 16602;
const SCHEMA = `proofrelay_indexer_test_${process.pid}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const reachable = await probeDatabase(DATABASE_URL);
if (!reachable.ok) {
  // eslint-disable-next-line no-console
  console.warn(
    `[skip] apps/api indexer projections need Postgres. DATABASE_URL=${redact(DATABASE_URL)} — ${reachable.detail}`,
  );
}
const describeDb = reachable.ok ? describe : describe.skip;

async function probeDatabase(url: string): Promise<{ ok: boolean; detail: string }> {
  if (!url) return { ok: false, detail: "DATABASE_URL is not set" };
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true, detail: "reachable" };
  } catch (error) {
    return { ok: false, detail: String((error as Error).message).slice(0, 160) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

const TASK_A = `0x${"a1".repeat(32)}` as Hex;
const TASK_B = `0x${"b2".repeat(32)}` as Hex;
const TASK_C = `0x${"c3".repeat(32)}` as Hex;
const CREATOR = `0x${"11".repeat(20)}` as Address;
const VERIFIER_A = `0x${"22".repeat(20)}` as Address;
const VERIFIER_B = `0x${"33".repeat(20)}` as Address;
const RULE_ID = `0x${"9f".repeat(32)}` as Hex;
const ZERO = `0x${"0".repeat(64)}` as Hex;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function manifestFixture(overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: "proofrelay-api/1.0.0",
    manifestId: "man-1",
    chainId: CHAIN_ID,
    creator: CREATOR,
    title: "Grid capacity claim",
    question: "Did the operator add 1.2 GW of capacity in 2025?",
    answerText: null,
    claims: [
      { claimId: "c1", claimText: "Capacity rose by 1.2 GW.", origin: "creator" },
      { claimId: "c2", claimText: "The addition completed in Q4.", origin: "creator" },
    ],
    sources: [
      {
        sourceId: "s1",
        uri: "https://example.org/report.html",
        status: "OK",
        contentHash: `sha256:${"4d".repeat(32)}`,
        byteLength: 2048,
        snapshotHash: `0x${"5e".repeat(32)}`,
        snapshotPointer: `local://${"5e".repeat(32)}`,
      },
    ],
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      maxEvidencePerClaim: 2,
      ruleId: RULE_ID,
    },
    safety: { publicDataOnly: true, redactions: [], warnings: [] },
    createdAt: iso(1_760_000_000),
    ...overrides,
  };
}

function reportFixture(taskId: Hex, verifier: Address, manifestHash: Hex): VerifierReport {
  return {
    kind: "verifier-report",
    schemaVersion: SCHEMA_VERSION,
    taskId,
    manifestHash,
    manifestPointer: `local://${manifestHash.slice(2)}`,
    verifier: {
      address: verifier,
      verifierId: "verifier-a",
      modelId: "qwen2.5-omni",
      pipelineVersion: "entailment-v1",
    },
    claims: [
      {
        taskId,
        claimId: "c1",
        claimText: "Capacity rose by 1.2 GW.",
        verdict: "SUPPORTED",
        confidence: 0.82,
        sources: [
          {
            uri: "https://example.org/report.html",
            snapshotObjectId: "5e".repeat(32),
            contentHash: `sha256:${"4d".repeat(32)}`,
            quotedSpan: "capacity increased by 1.2 GW",
            spanStart: 100,
            spanEnd: 128,
            score: 0.77,
            retrievedAt: iso(1_760_000_100),
          },
        ],
        verifier: {
          address: verifier,
          verifierId: "verifier-a",
          modelId: "qwen2.5-omni",
          pipelineVersion: "entailment-v1",
        },
        reasoningSummary: "The filing states the figure directly.",
        createdAt: iso(1_760_000_200),
      },
    ],
    graph: {
      nodes: [
        { id: "c1", type: "claim", label: "Capacity rose by 1.2 GW.", confidence: 0.82 },
        { id: "e1", type: "evidence", label: "capacity increased by 1.2 GW" },
      ],
      edges: [{ from: "e1", to: "c1", type: "supports", weight: 0.77 }],
    },
    compute: [
      {
        requestId: "req-1",
        operation: "evidence-scoring",
        provider: "local",
        modelId: "qwen2.5-omni",
        pipelineVersion: "entailment-v1",
        inputHash: `0x${"71".repeat(32)}`,
        outputHash: `0x${"72".repeat(32)}`,
        latencyMs: 182,
        attempts: 1,
        verified: true,
        rawArtifactPointer: null,
      },
    ],
    summary: {
      supported: 1,
      contradicted: 0,
      insufficient: 1,
      meanConfidence: 0.82,
      evidenceCoverage: 0.5,
    },
    createdAt: iso(1_760_000_300),
  };
}

/* ── chain stub ──────────────────────────────────────────────────────────── */

function emptyTask(): TaskOnChain {
  return {
    creator: CREATOR,
    bounty: 0n,
    verifierCount: 0,
    commitDeadline: 0,
    revealDeadline: 0,
    disputeWindow: 0,
    consensusAt: 0,
    committedCount: 0,
    revealedCount: 0,
    rewardBps: 0,
    status: 0,
    outcome: 0,
    manifestHash: ZERO,
    ruleId: ZERO,
    resultHash: ZERO,
    manifestPointer: "",
  };
}

class FakeChain implements ChainReader {
  readonly tasks = new Map<string, TaskOnChain>();
  readonly reports = new Map<string, ReportOnChain>();
  readonly verifiers = new Map<string, VerifierOnChain>();
  readonly disputes = new Map<string, DisputeOnChain>();
  readonly allocations = new Map<string, bigint>();

  setTask(taskId: Hex, task: Partial<TaskOnChain>): void {
    this.tasks.set(taskId.toLowerCase(), { ...emptyTask(), ...task });
  }

  setReport(taskId: Hex, verifier: Address, report: Partial<ReportOnChain>): void {
    this.reports.set(`${taskId.toLowerCase()}:${verifier.toLowerCase()}`, {
      verifier,
      commitment: ZERO,
      revealed: false,
      reportHash: ZERO,
      reportPointer: "",
      committedAt: 0,
      revealedAt: 0,
      ...report,
    });
  }

  async getTask(taskId: Hex): Promise<TaskOnChain> {
    const task = this.tasks.get(taskId.toLowerCase());
    if (!task) throw new Error(`FakeChain has no task ${taskId}`);
    return task;
  }

  async getReport(taskId: Hex, verifier: Address): Promise<ReportOnChain> {
    return (
      this.reports.get(`${taskId.toLowerCase()}:${verifier.toLowerCase()}`) ?? {
        verifier,
        commitment: ZERO,
        revealed: false,
        reportHash: ZERO,
        reportPointer: "",
        committedAt: 0,
        revealedAt: 0,
      }
    );
  }

  async getVerifier(verifier: Address): Promise<VerifierOnChain> {
    return (
      this.verifiers.get(verifier.toLowerCase()) ?? {
        registered: true,
        approved: true,
        active: true,
        stake: 10n ** 18n,
        slashed: 0n,
        metadataHash: ZERO,
        metadataPointer: "",
      }
    );
  }

  async getDispute(taskId: Hex): Promise<DisputeOnChain> {
    return (
      this.disputes.get(taskId.toLowerCase()) ?? {
        challenger: `0x${"0".repeat(40)}` as Address,
        bond: 0n,
        evidenceHash: ZERO,
        evidencePointer: "",
        resolved: false,
        upheld: false,
        outcome: 0,
        openedAt: 0,
        deadline: 0,
        adjudicationHash: ZERO,
        adjudicationPointer: "",
      }
    );
  }

  async allocationOf(taskId: Hex, account: Address): Promise<bigint> {
    return this.allocations.get(`${taskId.toLowerCase()}:${account.toLowerCase()}`) ?? 0n;
  }
}

/* ── storage stub ────────────────────────────────────────────────────────── */

class MemoryStore implements ArtifactStore {
  readonly driver = "memory";
  private readonly objects = new Map<string, Buffer>();

  /** Serves `bytes` at `reference` regardless of what they hash to. */
  serve(reference: string, bytes: Buffer): void {
    this.objects.set(reference, bytes);
  }

  serveObject(reference: string, value: unknown): void {
    this.serve(reference, canonicalBytes(value));
  }

  async get(reference: string): Promise<FetchedObject> {
    const bytes = this.objects.get(reference);
    if (!bytes) {
      throw new ProofRelayError("STORAGE_UNAVAILABLE", `no object at ${reference}`);
    }
    return { bytes, hash: bytesObjectHash(bytes), pointer: reference, source: "storage", kind: null };
  }
}

/* ── log ingestion, mirroring the indexer's own path ─────────────────────── */

interface FakeLog {
  name: ProofRelayEventName;
  args: EventArgs;
  block: number;
  logIndex: number;
  txHash: string;
  timeSec: number;
}

function log(
  name: ProofRelayEventName,
  args: EventArgs,
  block: number,
  logIndex: number,
  timeSec = 1_760_000_000 + block,
): FakeLog {
  return { name, args, block, logIndex, txHash: `0x${block.toString(16).padStart(64, "0")}`, timeSec };
}

let pool: pg.Pool;
let chain: FakeChain;

/**
 * The same two steps the indexer takes: insert the log under its idempotency
 * key, and project only when the insert created a row.
 */
async function ingest(entry: FakeLog): Promise<boolean> {
  return withTransaction(pool, async (db) => {
    const blockTime = new Date(entry.timeSec * 1000);
    const inserted = await db.query(
      `INSERT INTO chain_events (chain_id, tx_hash, log_index, block_number, block_time, event_name, task_id, actor, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
      [
        CHAIN_ID,
        entry.txHash,
        entry.logIndex,
        entry.block,
        blockTime,
        entry.name,
        eventTaskId(entry.name, entry.args),
        eventActor(entry.name, entry.args),
        JSON.stringify(entry.args, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
      ],
    );
    if (inserted.rowCount !== 1) return false;
    await applyEvent(
      {
        db,
        chain,
        chainId: CHAIN_ID,
        blockNumber: entry.block,
        blockTime,
        txHash: entry.txHash,
        logIndex: entry.logIndex,
      },
      entry.name,
      entry.args,
    );
    return true;
  });
}

async function ingestAll(entries: FakeLog[]): Promise<void> {
  for (const entry of entries) await ingest(entry);
}

async function rows<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

async function count(table: string): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT count(*)::bigint AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

function counterValue(name: string, labels = ""): number {
  const line = metrics
    .render()
    .split("\n")
    .find((entry) => entry.startsWith(`${name}${labels} `));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

async function truncateReadModel(): Promise<void> {
  await pool.query(
    "TRUNCATE chain_events, tasks, reports, consensus_results, disputes, allocations, verifiers, artifacts, manifests, jobs RESTART IDENTITY CASCADE",
  );
}

/* ── scenarios ───────────────────────────────────────────────────────────── */

const MANIFEST = manifestFixture();
const MANIFEST_HASH = objectHash(MANIFEST);
const MANIFEST_POINTER = `local://${MANIFEST_HASH.slice(2)}`;
const REPORT = reportFixture(TASK_A, VERIFIER_A, MANIFEST_HASH);
const REPORT_HASH = objectHash(REPORT);
const REPORT_POINTER = `local://${REPORT_HASH.slice(2)}`;

function seedChain(): FakeChain {
  const fake = new FakeChain();
  fake.setTask(TASK_A, {
    creator: CREATOR,
    bounty: 10n ** 17n,
    verifierCount: 2,
    commitDeadline: 1_760_001_000,
    revealDeadline: 1_760_002_000,
    disputeWindow: 900,
    consensusAt: 0,
    committedCount: 1,
    revealedCount: 1,
    status: 3,
    outcome: 0,
    manifestHash: MANIFEST_HASH,
    ruleId: RULE_ID,
    manifestPointer: MANIFEST_POINTER,
  });
  fake.setReport(TASK_A, VERIFIER_A, {
    commitment: `0x${"cc".repeat(32)}`,
    revealed: true,
    reportHash: REPORT_HASH,
    reportPointer: REPORT_POINTER,
    committedAt: 1_760_000_500,
    revealedAt: 1_760_000_900,
  });
  return fake;
}

const TASK_A_LOGS = (): FakeLog[] => [
  log("TaskCreated", { taskId: TASK_A, creator: CREATOR, bounty: 10n ** 17n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 10, 0),
  log("TaskManifest", { taskId: TASK_A, manifestPointer: MANIFEST_POINTER, verifierCount: 2, commitDeadline: 1_760_001_000, revealDeadline: 1_760_002_000 }, 10, 1),
  log("ReportCommitted", { taskId: TASK_A, verifier: VERIFIER_A, commitment: `0x${"cc".repeat(32)}` }, 15, 0),
  log("ReportRevealed", { taskId: TASK_A, verifier: VERIFIER_A, reportHash: REPORT_HASH, reportPointer: REPORT_POINTER }, 20, 0),
];

/* ── suite ───────────────────────────────────────────────────────────────── */

describeDb("indexer projections", () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}`, max: 4 });
    pool.on("error", () => undefined);
    // Every migration, in order — pinning this to 001 let the suite run against a
    // schema production does not have. `locked_by`/`locked_at` arrive in 002, so
    // anything leasing a job passed here and failed for real.
    const migrationsDir = resolve(repoRoot(), "infra/migrations");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    await truncateReadModel();
    chain = seedChain();
  });

  describe("idempotency", () => {
    it("replaying the same log changes nothing", async () => {
      const created = TASK_A_LOGS()[0]!;
      expect(await ingest(created)).toBe(true);

      const before = counterValue("task_created_total");
      const first = await rows("SELECT * FROM tasks");

      expect(await ingest(created)).toBe(false);
      expect(await ingest(created)).toBe(false);

      expect(await count("chain_events")).toBe(1);
      expect(await count("tasks")).toBe(1);
      expect(await rows("SELECT * FROM tasks")).toEqual(first);
      // The counter is what a double count would show up in first.
      expect(counterValue("task_created_total")).toBe(before);
      // One manifest fetch was queued, not three.
      expect(await count("jobs")).toBe(1);
    });

    it("does not double count an allocation on replay", async () => {
      chain.allocations.set(`${TASK_A.toLowerCase()}:${VERIFIER_A.toLowerCase()}`, 5n * 10n ** 16n);
      const allocated = log(
        "RewardAllocated",
        { taskId: TASK_A, beneficiary: VERIFIER_A, amount: 5n * 10n ** 16n },
        30,
        0,
      );
      await ingest(allocated);
      await ingest(allocated);

      const [row] = await rows<{ amount: string }>("SELECT amount FROM allocations");
      expect(row?.amount).toBe("50000000000000000");
      expect(await count("allocations")).toBe(1);
    });

    it("keeps the queued artifact fetch to one job per object hash", async () => {
      await ingestAll(TASK_A_LOGS());
      const jobs = await rows<{ idempotency_key: string; job_type: string }>(
        "SELECT idempotency_key, job_type FROM jobs ORDER BY id",
      );
      // TaskCreated and TaskManifest both point at the same manifest.
      expect(jobs.map((job) => job.idempotency_key)).toEqual([
        `artifact:${MANIFEST_HASH}`,
        `artifact:${REPORT_HASH}`,
      ]);
      expect(new Set(jobs.map((job) => job.job_type))).toEqual(new Set(["ARTIFACT_SYNC"]));
    });
  });

  /**
   * A cancellation never touches `_allocations`, so a read model that only
   * projected `RewardAllocated` showed a cancelled task refunding nobody. These
   * two are the projections that make the money visible.
   */
  describe("cancellation and refund", () => {
    it("records the refund a cancellation credits, which allocationOf never reports", async () => {
      chain.setTask(TASK_A, { ...emptyTask(), creator: CREATOR, bounty: 10n ** 17n, status: 9, outcome: 5 });
      await ingestAll(TASK_A_LOGS());
      await ingest(log("TaskCancelled", { taskId: TASK_A, creator: CREATOR, bounty: 10n ** 17n }, 40, 0));

      const [row] = await rows<{ beneficiary: string; amount: string }>("SELECT beneficiary, amount FROM allocations");
      expect(row?.beneficiary).toBe(CREATOR.toLowerCase());
      expect(row?.amount).toBe("100000000000000000");
      const [task] = await rows<{ status: number; outcome: number }>("SELECT status, outcome FROM tasks");
      expect(task?.status).toBe(9);
      expect(task?.outcome).toBe(5);
    });

    it("does not book a refund payout against the task that triggered it", async () => {
      chain.setTask(TASK_A, { ...emptyTask(), creator: CREATOR, bounty: 10n ** 17n, status: 9, outcome: 5 });
      await ingestAll(TASK_A_LOGS());
      await ingest(log("TaskCancelled", { taskId: TASK_A, creator: CREATOR, bounty: 10n ** 17n }, 40, 0));
      // refundCreator pays the creator's whole pending balance, which here is
      // twice this task's bounty. Adding it to `allocations` would credit this
      // task with money that came from another one.
      await ingest(log("RefundClaimed", { taskId: TASK_A, creator: CREATOR, amount: 2n * 10n ** 17n }, 41, 0));

      const [row] = await rows<{ amount: string }>("SELECT amount FROM allocations");
      expect(row?.amount).toBe("100000000000000000");
      expect(await count("allocations")).toBe(1);
    });

    it("replaying a cancellation changes nothing", async () => {
      chain.setTask(TASK_A, { ...emptyTask(), creator: CREATOR, bounty: 10n ** 17n, status: 9, outcome: 5 });
      await ingestAll(TASK_A_LOGS());
      const cancelled = log("TaskCancelled", { taskId: TASK_A, creator: CREATOR, bounty: 10n ** 17n }, 40, 0);
      expect(await ingest(cancelled)).toBe(true);
      expect(await ingest(cancelled)).toBe(false);
      expect(await count("allocations")).toBe(1);
    });
  });

  describe("convergence", () => {
    it("reaches the same rows whatever order the logs arrive in", async () => {
      const ordered = TASK_A_LOGS();
      await ingestAll(ordered);
      const inOrder = await readModelSnapshot();

      await truncateReadModel();
      chain = seedChain();
      await ingestAll([...ordered].reverse());
      const reversed = await readModelSnapshot();

      expect(reversed).toEqual(inOrder);
    });

    it("keeps the creation columns on the earliest log, not the last one applied", async () => {
      const [created, , , revealed] = TASK_A_LOGS();
      // The reveal is projected first, so the task row is born from it.
      await ingest(revealed!);
      const born = await rows<{ created_block: number; tx_hash: string }>(
        "SELECT created_block, tx_hash FROM tasks",
      );
      expect(born[0]?.created_block).toBe(20);

      await ingest(created!);
      const settled = await rows<{ created_block: number; tx_hash: string; created_at: Date }>(
        "SELECT created_block, tx_hash, created_at FROM tasks",
      );
      expect(settled[0]?.created_block).toBe(10);
      expect(settled[0]?.tx_hash).toBe(created!.txHash);
      expect(settled[0]?.created_at.toISOString()).toBe(new Date(created!.timeSec * 1000).toISOString());
    });

    it("does not push a revealed report back to COMMITTED", async () => {
      const [, , committed, revealed] = TASK_A_LOGS();
      await ingest(revealed!);
      await ingest(committed!);
      const [report] = await rows<{ status: string; report_hash: string; reveal_tx: string; commit_tx: string }>(
        "SELECT status, report_hash, reveal_tx, commit_tx FROM reports",
      );
      expect(report?.status).toBe("REVEALED");
      expect(report?.report_hash).toBe(REPORT_HASH);
      expect(report?.commit_tx).toBe(committed!.txHash);
      expect(report?.reveal_tx).toBe(revealed!.txHash);
    });

    it("writes the chain struct, not the event payload", async () => {
      // The contract emits TaskFinalized with a reason hash after an upheld
      // dispute, which is not the task's result hash. The struct wins.
      chain.setTask(TASK_A, {
        ...(await chain.getTask(TASK_A)),
        status: 7,
        outcome: 2,
        resultHash: `0x${"ee".repeat(32)}`,
        consensusAt: 1_760_003_000,
        disputeWindow: 900,
      });
      await ingest(log("TaskFinalized", { taskId: TASK_A, resultHash: `0x${"ff".repeat(32)}`, outcome: 1 }, 40, 0));

      const [task] = await rows<{ result_hash: string; status: number; outcome: number; dispute_deadline: Date }>(
        "SELECT result_hash, status, outcome, dispute_deadline FROM tasks",
      );
      expect(task?.result_hash).toBe(`0x${"ee".repeat(32)}`);
      expect(task?.status).toBe(7);
      expect(task?.outcome).toBe(2);
      // consensusAt + disputeWindow, because the struct holds a duration.
      expect(task?.dispute_deadline.toISOString()).toBe(new Date(1_760_003_900 * 1000).toISOString());
    });
  });

  describe("address casing", () => {
    /**
     * The indexer preserved viem's checksum casing while task-service wrote
     * lowercase, and both write the same key columns. Postgres compares TEXT
     * byte-for-byte, so `UNIQUE (task_id, verifier)` never saw the collision:
     * one verifier could hold two rows for one task. The `lower(...)` indexes
     * made joins keep working, which is exactly what hid it — the live database
     * had six such rows before migration 003.
     */
    it("refuses a checksum-cased address in a key column", async () => {
      await ingestAll([
        log("TaskCreated", { taskId: TASK_A, creator: CREATOR, bounty: 1n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 10, 0),
      ]);

      await expect(
        pool.query(
          `INSERT INTO reports (task_id, verifier, commitment, status)
           VALUES ($1, $2, $3, 'REVEALED')`,
          [
            TASK_A.toLowerCase(),
            "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
            `0x${"11".repeat(32)}`,
          ],
        ),
      ).rejects.toThrow(/reports_verifier_lowercase/);
    });

    it("stores the lowercase form the projections write", async () => {
      await ingestAll([
        log("TaskCreated", { taskId: TASK_A, creator: CREATOR, bounty: 1n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 10, 0),
      ]);
      const found = await rows<{ creator: string }>("SELECT creator FROM tasks WHERE task_id = $1", [
        TASK_A.toLowerCase(),
      ]);
      expect(found[0]?.creator).toBe(CREATOR.toLowerCase());
    });
  });

  describe("sequence assignment", () => {
    const SYNC_FIRST_TASK = `0x${"5e".repeat(32)}`;
    const threeTasks = (): FakeLog[] => [
      log("TaskCreated", { taskId: TASK_A, creator: CREATOR, bounty: 1n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 10, 0),
      log("TaskCreated", { taskId: TASK_B, creator: CREATOR, bounty: 1n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 10, 3),
      log("TaskCreated", { taskId: TASK_C, creator: CREATOR, bounty: 1n, manifestHash: MANIFEST_HASH, ruleId: RULE_ID }, 25, 0),
    ];

    function seedThree(): void {
      for (const taskId of [TASK_A, TASK_B, TASK_C]) {
        chain.setTask(taskId, { manifestHash: MANIFEST_HASH, ruleId: RULE_ID, manifestPointer: MANIFEST_POINTER });
      }
    }

    it("numbers tasks by creation order and survives a full replay", async () => {
      seedThree();
      await ingestAll(threeTasks());
      const canonical = await rows<{ task_id: string; sequence: number }>(
        "SELECT task_id, sequence FROM tasks ORDER BY sequence",
      );
      expect(canonical).toEqual([
        { task_id: TASK_A.toLowerCase(), sequence: 0 },
        { task_id: TASK_B.toLowerCase(), sequence: 1 },
        { task_id: TASK_C.toLowerCase(), sequence: 2 },
      ]);
      expect(canonical.map((row) => taskRef(row.sequence))).toEqual(["PR-1000", "PR-1001", "PR-1002"]);

      await truncateReadModel();
      chain = seedChain();
      seedThree();
      await ingestAll(threeTasks());
      expect(await rows("SELECT task_id, sequence FROM tasks ORDER BY sequence")).toEqual(canonical);
    });

    it("renumbers when a task arrives out of creation order", async () => {
      seedThree();
      const [first, second, third] = threeTasks();
      // Newest first, which is what a backfill from the head looks like.
      await ingestAll([third!, second!, first!]);
      expect(await rows("SELECT task_id, sequence FROM tasks ORDER BY sequence")).toEqual([
        { task_id: TASK_A.toLowerCase(), sequence: 0 },
        { task_id: TASK_B.toLowerCase(), sequence: 1 },
        { task_id: TASK_C.toLowerCase(), sequence: 2 },
      ]);
    });

    /**
     * `POST /v1/tasks/:id/sync` inserts a task before any of its logs are
     * indexed and takes `MAX(sequence) + 1` without writing a `chain_events`
     * row. Ranking reads `chain_events`, so that row used to be invisible to
     * both park and unpark while sitting on a slot the indexer would later
     * assign — and `tasks_sequence_idx` is UNIQUE, so the next TaskCreated
     * wedged the indexer permanently.
     */
    it("does not wedge when a sync-first row already holds the slot a log needs", async () => {
      seedThree();
      // Two indexed tasks -> slots 0 and 1.
      await ingestAll(threeTasks().slice(0, 2));

      // A sync-first row with no chain_events, taking the next free slot (2) —
      // exactly what writeTaskRow mints. TASK_C's log will want that same slot.
      await pool.query(
        `INSERT INTO tasks (
           task_id, sequence, creator, status, bounty, verifier_count,
           manifest_hash, manifest_pointer, rule_id, created_at, updated_at
         ) VALUES ($1, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM tasks),
                   $2, 1, '1', 2, $3, $4, $5, now(), now())`,
        [SYNC_FIRST_TASK, CREATOR.toLowerCase(), MANIFEST_HASH, MANIFEST_POINTER, RULE_ID],
      );

      await ingestAll([threeTasks()[2]!]);

      const ordered = await rows<{ task_id: string; sequence: number }>(
        "SELECT task_id, sequence FROM tasks ORDER BY sequence",
      );
      // Indexed tasks keep chain order; the un-indexed one is appended after.
      expect(ordered).toEqual([
        { task_id: TASK_A.toLowerCase(), sequence: 0 },
        { task_id: TASK_B.toLowerCase(), sequence: 1 },
        { task_id: TASK_C.toLowerCase(), sequence: 2 },
        { task_id: SYNC_FIRST_TASK, sequence: 3 },
      ]);
      // No row is left parked in the negative range.
      expect(await rows("SELECT task_id FROM tasks WHERE sequence < 0")).toEqual([]);
    });

    it("gives a task discovered without its creation log a number after the known ones", async () => {
      seedThree();
      await ingestAll(threeTasks().slice(0, 2));
      chain.setTask(TASK_C, { manifestHash: MANIFEST_HASH, ruleId: RULE_ID, manifestPointer: MANIFEST_POINTER });
      // Only a reveal for TASK_C: indexing started after it was created.
      await ingest(log("ReportCommitted", { taskId: TASK_C, verifier: VERIFIER_B, commitment: `0x${"dd".repeat(32)}` }, 30, 0));
      const seen = await rows<{ task_id: string; sequence: number }>(
        "SELECT task_id, sequence FROM tasks ORDER BY sequence",
      );
      expect(seen.map((row) => row.task_id)).toEqual([
        TASK_A.toLowerCase(),
        TASK_B.toLowerCase(),
        TASK_C.toLowerCase(),
      ]);
      expect(seen.map((row) => row.sequence)).toEqual([0, 1, 2]);
    });
  });

  describe("artifact sync", () => {
    let storage: MemoryStore;
    let sync: ArtifactSync;

    beforeEach(async () => {
      storage = new MemoryStore();
      sync = new ArtifactSync({ pool, storage, maxAttempts: 2, baseDelayMs: 0 });
      await ingestAll(TASK_A_LOGS());
    });

    it("stores and denormalises a body whose hash matches", async () => {
      storage.serveObject(MANIFEST_POINTER, MANIFEST);
      storage.serveObject(REPORT_POINTER, REPORT);

      const pass = await sync.runOnce();
      expect(pass).toMatchObject({ claimed: 2, verified: 2, mismatched: 0 });

      const [task] = await rows<{
        title: string;
        question: string;
        claim_count: number;
        source_count: number;
        primary_source: string;
        manifest_verified: boolean;
      }>("SELECT title, question, claim_count, source_count, primary_source, manifest_verified FROM tasks");
      expect(task).toEqual({
        title: MANIFEST.title,
        question: MANIFEST.question,
        claim_count: 2,
        source_count: 1,
        primary_source: "https://example.org/report.html",
        manifest_verified: true,
      });

      const [report] = await rows<{
        model_id: string;
        pipeline_version: string;
        supported: number;
        contradicted: number;
        insufficient: number;
        mean_confidence: number;
        evidence_coverage: number;
        compute_provider: string;
        compute_latency_ms: number;
        compute_verified: boolean;
        body_verified: boolean;
      }>(
        `SELECT model_id, pipeline_version, supported, contradicted, insufficient, mean_confidence,
                evidence_coverage, compute_provider, compute_latency_ms, compute_verified, body_verified
           FROM reports`,
      );
      expect(report).toEqual({
        model_id: "qwen2.5-omni",
        pipeline_version: "entailment-v1",
        supported: 1,
        contradicted: 0,
        insufficient: 1,
        mean_confidence: 0.82,
        evidence_coverage: 0.5,
        compute_provider: "local",
        compute_latency_ms: 182,
        compute_verified: true,
        body_verified: true,
      });

      // Cached so /v1/reports/{hash} can answer while storage is down.
      const [cached] = await rows<{ hash_verified: boolean; body: { kind: string } | null; name: string }>(
        "SELECT hash_verified, body, name FROM artifacts WHERE object_hash = $1",
        [REPORT_HASH],
      );
      expect(cached?.hash_verified).toBe(true);
      expect(cached?.body?.kind).toBe("verifier-report");
      expect(cached?.name).toMatch(/^verifier-report_0x/);
      expect(await rows("SELECT status FROM jobs WHERE status <> 'DONE'")).toEqual([]);
    });

    it("never stores a body whose hash does not match", async () => {
      // The right kind of object at the right pointer — but not the object the
      // chain committed to.
      storage.serveObject(MANIFEST_POINTER, MANIFEST);
      storage.serveObject(REPORT_POINTER, reportFixture(TASK_A, VERIFIER_B, MANIFEST_HASH));

      const pass = await sync.runOnce();
      expect(pass.mismatched).toBe(1);
      expect(pass.verified).toBe(1);

      const [artifact] = await rows<{ hash_verified: boolean; body: unknown }>(
        "SELECT hash_verified, body FROM artifacts WHERE object_hash = $1",
        [REPORT_HASH],
      );
      expect(artifact?.hash_verified).toBe(false);
      expect(artifact?.body).toBeNull();

      const [report] = await rows<{ body: unknown; body_verified: boolean; report_hash: string }>(
        "SELECT body, body_verified, report_hash FROM reports",
      );
      expect(report?.body).toBeNull();
      expect(report?.body_verified).toBe(false);
      // The hash stays; it is the only thing we can still prove anything with.
      expect(report?.report_hash).toBe(REPORT_HASH);

      const [job] = await rows<{ status: string; last_error_code: string }>(
        "SELECT status, last_error_code FROM jobs WHERE idempotency_key = $1",
        [`artifact:${REPORT_HASH}`],
      );
      expect(job?.status).toBe("FAILED_FINAL");
      expect(job?.last_error_code).toBe("CONTENT_HASH_MISMATCH");
    });

    it("refuses bytes that are not canonical even when they hash to something", async () => {
      // Same object, re-serialised with unsorted keys and whitespace: a
      // different hash, so it must be rejected exactly like any other mismatch.
      storage.serve(REPORT_POINTER, Buffer.from(JSON.stringify(REPORT, null, 2), "utf8"));
      storage.serveObject(MANIFEST_POINTER, MANIFEST);

      const pass = await sync.runOnce();
      expect(pass.mismatched).toBe(1);
      expect(
        await rows("SELECT body FROM artifacts WHERE object_hash = $1 AND body IS NOT NULL", [REPORT_HASH]),
      ).toEqual([]);
    });

    it("leaves the hash and no body when the pointer never resolves", async () => {
      storage.serveObject(MANIFEST_POINTER, MANIFEST);

      const first = await sync.runOnce();
      expect(first.retried).toBe(1);
      const second = await sync.runOnce();
      expect(second.abandoned).toBe(1);

      const [artifact] = await rows<{ object_hash: string; hash_verified: boolean; body: unknown; pointer: string }>(
        "SELECT object_hash, hash_verified, body, pointer FROM artifacts WHERE object_hash = $1",
        [REPORT_HASH],
      );
      expect(artifact).toMatchObject({
        object_hash: REPORT_HASH,
        hash_verified: false,
        body: null,
        pointer: REPORT_POINTER,
      });

      const [job] = await rows<{ status: string; attempts: number; last_error_code: string }>(
        "SELECT status, attempts, last_error_code FROM jobs WHERE idempotency_key = $1",
        [`artifact:${REPORT_HASH}`],
      );
      expect(job).toMatchObject({ status: "FAILED_FINAL", attempts: 2, last_error_code: "STORAGE_UNAVAILABLE" });
    });

    it("recovers once the pointer resolves", async () => {
      storage.serveObject(MANIFEST_POINTER, MANIFEST);
      await sync.runOnce();
      storage.serveObject(REPORT_POINTER, REPORT);

      const payload: ArtifactSyncPayload = {
        kind: "verifier-report",
        hash: REPORT_HASH,
        pointer: REPORT_POINTER,
        taskId: TASK_A.toLowerCase(),
        verifier: VERIFIER_A,
        block: 20,
      };
      const result = await sync.syncOne(payload);
      expect(result.outcome).toBe("verified");

      const [artifact] = await rows<{ hash_verified: boolean; body: { kind: string } }>(
        "SELECT hash_verified, body FROM artifacts WHERE object_hash = $1",
        [REPORT_HASH],
      );
      expect(artifact?.hash_verified).toBe(true);
      expect(artifact?.body.kind).toBe("verifier-report");
    });
  });

  /**
   * The settlement trigger.
   *
   * Nothing else in the system enqueues CONSENSUS_EVALUATION, and that job is
   * the only producer of FINALIZATION. Without this the keeper's consensus path
   * is unreachable and every task — including one every verifier agreed on —
   * can only settle later through expireTask, which pays the *conflict* rate.
   * Agreement would silently never be rewarded as agreement.
   */
  describe("settlement trigger", () => {
    beforeEach(async () => {
      await truncateReadModel();
    });

    it("queues an evaluation once the last verifier has revealed", async () => {
      chain = seedChain();
      chain.setTask(TASK_A, { ...chain.tasks.get(TASK_A.toLowerCase())!, revealedCount: 2, committedCount: 2 });
      chain.setReport(TASK_A, VERIFIER_B, {
        commitment: `0x${"dd".repeat(32)}`,
        revealed: true,
        reportHash: `0x${"ee".repeat(32)}`,
        reportPointer: "local://ee",
        committedAt: 1_760_000_600,
        revealedAt: 1_760_000_950,
      });

      await ingestAll(TASK_A_LOGS());
      await ingest(
        log("ReportRevealed", { taskId: TASK_A, verifier: VERIFIER_B, reportHash: `0x${"ee".repeat(32)}`, reportPointer: "local://ee" }, 21, 0),
      );

      const jobs = await rows<{ idempotency_key: string; job_type: string; task_id: string }>(
        "SELECT idempotency_key, job_type, task_id FROM jobs WHERE job_type = 'CONSENSUS_EVALUATION'",
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotency_key).toBe(`consensus:${TASK_A.toLowerCase()}`);
      expect(jobs[0]!.task_id).toBe(TASK_A.toLowerCase());
    });

    it("does not queue one while a verifier has still to reveal", async () => {
      chain = seedChain();
      await ingestAll(TASK_A_LOGS());
      expect(await count("jobs WHERE job_type = 'CONSENSUS_EVALUATION'")).toBe(0);
    });

    it("queues exactly one however many times the reveal is replayed", async () => {
      chain = seedChain();
      chain.setTask(TASK_A, { ...chain.tasks.get(TASK_A.toLowerCase())!, revealedCount: 2, committedCount: 2 });
      chain.setReport(TASK_A, VERIFIER_B, {
        commitment: `0x${"dd".repeat(32)}`,
        revealed: true,
        reportHash: `0x${"ee".repeat(32)}`,
        reportPointer: "local://ee",
        committedAt: 1_760_000_600,
        revealedAt: 1_760_000_950,
      });
      const reveal = log(
        "ReportRevealed",
        { taskId: TASK_A, verifier: VERIFIER_B, reportHash: `0x${"ee".repeat(32)}`, reportPointer: "local://ee" },
        21,
        0,
      );

      await ingestAll(TASK_A_LOGS());
      await ingest(reveal);
      // A replay: the chain_events insert is a no-op, so the projector never
      // runs a second time — but even if it did, the job key is the task.
      await ingest(reveal);
      await enqueueConsensusEvaluation(
        { db: pool as never, chain, chainId: CHAIN_ID, blockNumber: 22, blockTime: new Date(), txHash: "0x", logIndex: 0 },
        TASK_A,
      );

      expect(await count("jobs WHERE job_type = 'CONSENSUS_EVALUATION'")).toBe(1);
    });
  });

});

/**
 * Everything the read model derives from the chain, minus the columns that are
 * clocks (`created_at` defaults, `updated_at`) rather than data.
 */
async function readModelSnapshot(): Promise<Record<string, unknown[]>> {
  return {
    tasks: await rows(
      `SELECT task_id, sequence, creator, status, outcome, bounty, verifier_count, committed_count,
              revealed_count, reward_bps, manifest_hash, manifest_pointer, rule_id, result_hash,
              commit_deadline, reveal_deadline, dispute_deadline, consensus_at, created_block, tx_hash, created_at
         FROM tasks ORDER BY task_id`,
    ),
    reports: await rows(
      `SELECT task_id, verifier, commitment, report_hash, report_pointer, status, committed_at,
              revealed_at, commit_tx, reveal_tx, body_verified
         FROM reports ORDER BY task_id, verifier`,
    ),
    allocations: await rows("SELECT task_id, beneficiary, amount, tx_hash FROM allocations ORDER BY task_id, beneficiary"),
    consensus: await rows(
      "SELECT task_id, outcome, agreement_bps, result_hash, result_pointer, evaluated_at, tx_hash FROM consensus_results ORDER BY task_id",
    ),
    disputes: await rows("SELECT * FROM disputes ORDER BY task_id"),
    jobs: await rows("SELECT idempotency_key, task_id, job_type, status, payload FROM jobs ORDER BY idempotency_key"),
  };
}
