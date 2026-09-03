/**
 * Read-model projections, one per contract event.
 *
 * Two rules shape every function here.
 *
 * 1. The event only says "something changed". After writing what the log
 *    carries, each projector re-reads the authoritative struct with
 *    `getTask` / `getReport` / `getVerifier` / `getDispute` / `allocationOf`
 *    and stores *that*. An event tells you a task moved; only the struct tells
 *    you where it moved to, and the struct is what the chain will still say
 *    tomorrow. It also means a projector applied out of order converges: the
 *    last one to run writes the current chain state regardless of which event
 *    woke it.
 * 2. Every write is idempotent. The indexer already refuses to project a log
 *    it has seen (the `(chain_id, tx_hash, log_index)` key on `chain_events`),
 *    but that guard protects only the counters — the row writes are upserts so
 *    a rebuilt read model converges to the same rows from any arrival order.
 *
 * `sequence` is the exception that needs explaining. The UI's `PR-1048` handle
 * is `taskRef(sequence)`, so the number has to be the task's rank in creation
 * order and nothing else — not an insertion order a rebuild would renumber.
 * It is therefore derived from `chain_events`: a task's rank among all tasks
 * ordered by the `(block_number, log_index)` of the first log that mentions
 * them. That is a pure function of the chain, so a full replay reproduces it.
 */
import type { Address, Hex } from "viem";
import {
  ROLE,
  type DisputeOnChain,
  type ProofRelayEventName,
  type ReportOnChain,
  type TaskOnChain,
  type VerifierOnChain,
} from "@proofrelay/chain-client";
import { ProofRelayError, TaskStatus, outcomeName, type ArtifactKind } from "@proofrelay/schemas";
import { chainTimeToDate, one, type PoolClient } from "../db.js";
import { metrics, type Logger } from "../observability.js";

export const ZERO_HASH = `0x${"0".repeat(64)}` as const;

/** The job type the artifact sync worker drains. */
export const ARTIFACT_SYNC_JOB = "ARTIFACT_SYNC";

/**
 * The slice of ChainClient a projector uses. Narrow on purpose: it keeps the
 * projections testable against a stub without an RPC endpoint, and a real
 * ChainClient satisfies it structurally.
 */
export interface ChainReader {
  getTask(taskId: Hex): Promise<TaskOnChain>;
  getReport(taskId: Hex, verifier: Address): Promise<ReportOnChain>;
  getVerifier(verifier: Address): Promise<VerifierOnChain>;
  getDispute(taskId: Hex): Promise<DisputeOnChain>;
  allocationOf(taskId: Hex, account: Address): Promise<bigint>;
}

export interface EventContext {
  db: PoolClient;
  chain: ChainReader;
  chainId: number;
  blockNumber: number;
  blockTime: Date;
  txHash: string;
  logIndex: number;
  logger?: Logger | undefined;
}

export type EventArgs = Record<string, unknown>;

/* ── argument readers ────────────────────────────────────────────────────── */

function hex(value: unknown): Hex {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]*$/.test(text)) throw new Error(`expected hex, got ${text.slice(0, 32)}`);
  return text.toLowerCase() as Hex;
}

/**
 * Lowercased, like `hex()` above.
 *
 * Preserving viem's checksum casing here while task-service wrote lowercase put
 * two spellings of one address into the same key columns, and Postgres compares
 * TEXT byte-for-byte: `UNIQUE (task_id, verifier)` and `PRIMARY KEY (task_id,
 * beneficiary)` never saw the collision, so one verifier could hold two rows for
 * one task. The `lower(...)` indexes made joins keep working, which is what hid
 * it. Migration 003 collapses the rows that already exist and adds CHECK
 * constraints so this cannot drift again.
 */
function addr(value: unknown): Address {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`expected an address, got ${text.slice(0, 32)}`);
  return text.toLowerCase() as Address;
}

function big(value: unknown): bigint {
  return typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function isZero(hash: string | null | undefined): boolean {
  return !hash || /^0x0*$/.test(hash);
}

/** The dispute deadline is `consensusAt + disputeWindow`; the struct holds a duration. */
function disputeDeadline(task: TaskOnChain): Date | null {
  if (task.consensusAt <= 0) return null;
  return chainTimeToDate(task.consensusAt + task.disputeWindow);
}

/* ── correlation helpers, shared with the indexer's chain_events writer ──── */

export function eventTaskId(name: ProofRelayEventName, args: EventArgs): string | null {
  const value = args.taskId;
  if (typeof value !== "string") return null;
  return name === "RoleGranted" ? null : value.toLowerCase();
}

export function eventActor(name: ProofRelayEventName, args: EventArgs): string | null {
  const candidate =
    args.creator ?? args.verifier ?? args.challenger ?? args.beneficiary ?? args.account ?? null;
  if (typeof candidate !== "string") return null;
  return name === "RoleGranted" ? String(args.account ?? "") || null : candidate;
}

/* ── sequence assignment ─────────────────────────────────────────────────── */

/**
 * Ranks every task the read model has ever seen a log for, by the position of
 * the earliest such log. Written once and reused by the three statements below
 * so the definition cannot drift between them.
 */
const RANKED_TASKS = `
  WITH firsts AS (
    SELECT DISTINCT ON (task_id) task_id, block_number, log_index
    FROM chain_events
    WHERE chain_id = $1 AND task_id IS NOT NULL
    ORDER BY task_id, block_number, log_index
  ),
  ranked AS (
    SELECT task_id, row_number() OVER (ORDER BY block_number, log_index) - 1 AS rank
    FROM firsts
  )`;

async function canonicalSequence(ctx: EventContext, taskId: string): Promise<number> {
  const row = await one<{ sequence: number }>(
    ctx.db,
    `
    WITH firsts AS (
      SELECT DISTINCT ON (task_id) task_id, block_number, log_index
      FROM chain_events
      WHERE chain_id = $1 AND task_id IS NOT NULL
      ORDER BY task_id, block_number, log_index
    ),
    self AS (SELECT block_number, log_index FROM firsts WHERE task_id = $2)
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM self) THEN (
        SELECT count(*) FROM firsts f, self s
        WHERE (f.block_number, f.log_index) < (s.block_number, s.log_index)
      )
      -- No log for this task in the stream: it can only be ordered after what
      -- we do know about, and a replay that sees the log will re-rank it.
      ELSE (SELECT COALESCE(MAX(sequence), -1) + 1 FROM tasks)
    END AS sequence`,
    [ctx.chainId, taskId],
  );
  return row?.sequence ?? 0;
}

/**
 * Moves every task whose stored number disagrees with its rank out of the way,
 * into a negative mirror that cannot collide with anything. `sequence` carries
 * a unique index, so a task arriving out of creation order — the rank of every
 * later task shifts by one — cannot be renumbered in place.
 */
/**
 * Every task's slot, not just the indexed ones.
 *
 * `POST /v1/tasks/:id/sync` can insert a task before any of its logs are
 * indexed, and it takes `MAX(sequence) + 1` while writing no `chain_events` row.
 * Ranking reads `chain_events`, so such a row used to be unrankable by
 * construction: park and unpark both skipped it while it sat on a positive slot
 * that a later-indexed task would be assigned, and `tasks_sequence_idx` — which
 * is UNIQUE — then wedged the indexer for good.
 *
 * Un-indexed tasks are appended after the indexed block, ordered by creation, so
 * a sync-first task on an empty read model still lands on sequence 0 and keeps
 * the PR-1000 handle it is documented to have.
 */
const SEQUENCE_SLOTS = `${RANKED_TASKS},
  unranked AS (
    SELECT t.task_id,
           (SELECT count(*) FROM ranked)
             + row_number() OVER (ORDER BY t.created_at, t.task_id) - 1 AS rank
    FROM tasks t
    WHERE NOT EXISTS (SELECT 1 FROM ranked r WHERE r.task_id = t.task_id)
  ),
  slots AS (
    SELECT task_id, rank FROM ranked
    UNION ALL
    SELECT task_id, rank FROM unranked
  )`;

async function parkDivergentSequences(ctx: EventContext): Promise<void> {
  await ctx.db.query(
    `${SEQUENCE_SLOTS}
     UPDATE tasks t SET sequence = -1 - s.rank
     FROM slots s WHERE t.task_id = s.task_id AND t.sequence <> s.rank`,
    [ctx.chainId],
  );
}

async function unparkSequences(ctx: EventContext): Promise<void> {
  await ctx.db.query(
    `${SEQUENCE_SLOTS}
     UPDATE tasks t SET sequence = s.rank
     FROM slots s WHERE t.task_id = s.task_id AND t.sequence < 0`,
    [ctx.chainId],
  );
}

/* ── task rows ───────────────────────────────────────────────────────────── */

const UPSERT_TASK = `
INSERT INTO tasks (
  task_id, sequence, creator, status, outcome, bounty, verifier_count,
  committed_count, revealed_count, reward_bps, manifest_hash, manifest_pointer,
  rule_id, result_hash, commit_deadline, reveal_deadline, dispute_deadline,
  consensus_at, created_block, tx_hash, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
ON CONFLICT (task_id) DO UPDATE SET
  creator          = EXCLUDED.creator,
  status           = EXCLUDED.status,
  outcome          = EXCLUDED.outcome,
  bounty           = EXCLUDED.bounty,
  verifier_count   = EXCLUDED.verifier_count,
  committed_count  = EXCLUDED.committed_count,
  revealed_count   = EXCLUDED.revealed_count,
  reward_bps       = EXCLUDED.reward_bps,
  manifest_hash    = EXCLUDED.manifest_hash,
  manifest_pointer = EXCLUDED.manifest_pointer,
  rule_id          = EXCLUDED.rule_id,
  result_hash      = EXCLUDED.result_hash,
  commit_deadline  = EXCLUDED.commit_deadline,
  reveal_deadline  = EXCLUDED.reveal_deadline,
  dispute_deadline = EXCLUDED.dispute_deadline,
  consensus_at     = EXCLUDED.consensus_at,
  -- Earliest log wins for the creation columns and latest for updated_at, so a
  -- backfill that runs newest-first still lands on the same row.
  created_block    = LEAST(tasks.created_block, EXCLUDED.created_block),
  tx_hash          = CASE
                       WHEN EXCLUDED.created_block < COALESCE(tasks.created_block, 9223372036854775807)
                       THEN EXCLUDED.tx_hash ELSE tasks.tx_hash END,
  created_at       = LEAST(tasks.created_at, EXCLUDED.created_at),
  updated_at       = GREATEST(tasks.updated_at, EXCLUDED.updated_at)`;

/**
 * Writes the task row from the chain struct, creating it if this is the first
 * log we have seen for it. Every task-scoped projector goes through here, so a
 * read model that starts indexing mid-history still has a task to attach a
 * report or a dispute to.
 */
export async function refreshTaskFromChain(ctx: EventContext, taskIdRaw: string): Promise<TaskOnChain> {
  const taskId = taskIdRaw.toLowerCase();
  const existing = await one<{ sequence: number }>(ctx.db, "SELECT sequence FROM tasks WHERE task_id = $1", [taskId]);
  const sequence = existing ? existing.sequence : await canonicalSequence(ctx, taskId);
  if (!existing) await parkDivergentSequences(ctx);

  const task = await ctx.chain.getTask(taskId as Hex);
  // A log for this task exists — that is why we are here — so a struct that
  // reads as nothing means the node answering is behind, not that the task is
  // absent. Writing it anyway minted a permanent phantom row: zero creator, zero
  // bounty, status None, and nothing later corrects it because the projection
  // only runs on new logs. Throwing rolls the batch back and the indexer retries
  // the same range against a node that has caught up.
  if (task.status === TaskStatus.None && /^0x0*$/.test(task.creator)) {
    throw new ProofRelayError(
      "CHAIN_UNAVAILABLE",
      "the node returned an empty task for an id its own logs contain",
      { retryable: true, detail: { taskId } },
    );
  }
  await ctx.db.query(UPSERT_TASK, [
    taskId,
    sequence,
    task.creator,
    task.status,
    task.outcome,
    task.bounty.toString(),
    task.verifierCount,
    task.committedCount,
    task.revealedCount,
    task.rewardBps,
    task.manifestHash.toLowerCase(),
    task.manifestPointer,
    task.ruleId.toLowerCase(),
    isZero(task.resultHash) ? null : task.resultHash.toLowerCase(),
    chainTimeToDate(task.commitDeadline),
    chainTimeToDate(task.revealDeadline),
    disputeDeadline(task),
    chainTimeToDate(task.consensusAt),
    ctx.blockNumber,
    ctx.txHash,
    ctx.blockTime,
  ]);

  if (!existing) await unparkSequences(ctx);
  return task;
}

/* ── artifact jobs ───────────────────────────────────────────────────────── */

export interface ArtifactSyncPayload {
  kind: ArtifactKind;
  hash: string;
  pointer: string | null;
  taskId: string | null;
  verifier: string | null;
  /** Block the reference was first seen in, for `artifacts.first_seen_block`. */
  block: number | null;
}

/**
 * Queues a body fetch. The key is the object hash, so the same artifact is
 * fetched once no matter how many events point at it, and a replay of the log
 * that queued it does not queue it twice.
 */
export async function enqueueArtifactSync(
  ctx: EventContext,
  payload: Omit<ArtifactSyncPayload, "block">,
): Promise<boolean> {
  if (isZero(payload.hash)) return false;
  const body: ArtifactSyncPayload = {
    kind: payload.kind,
    hash: payload.hash.toLowerCase(),
    pointer: payload.pointer && payload.pointer.length > 0 ? payload.pointer : null,
    taskId: payload.taskId ? payload.taskId.toLowerCase() : null,
    verifier: payload.verifier ?? null,
    block: ctx.blockNumber,
  };
  const result = await ctx.db.query(
    `INSERT INTO jobs (idempotency_key, task_id, job_type, status, payload, next_retry_at)
     VALUES ($1, $2, $3, 'PENDING', $4::jsonb, now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [`artifact:${body.hash}`, body.taskId, ARTIFACT_SYNC_JOB, JSON.stringify(body)],
  );
  return result.rowCount === 1;
}

/* ── verifier rows ───────────────────────────────────────────────────────── */

const UPSERT_VERIFIER = `
INSERT INTO verifiers (
  address, registered, approved, active, stake, metadata_hash, metadata_pointer,
  registered_block, registered_at, last_seen_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now())
ON CONFLICT (address) DO UPDATE SET
  registered       = EXCLUDED.registered,
  approved         = EXCLUDED.approved,
  active           = EXCLUDED.active,
  stake            = EXCLUDED.stake,
  metadata_hash    = EXCLUDED.metadata_hash,
  metadata_pointer = EXCLUDED.metadata_pointer,
  registered_block = LEAST(verifiers.registered_block, EXCLUDED.registered_block),
  registered_at    = LEAST(verifiers.registered_at, EXCLUDED.registered_at),
  last_seen_at     = GREATEST(verifiers.last_seen_at, EXCLUDED.last_seen_at),
  updated_at       = now()`;

async function refreshVerifierFromChain(ctx: EventContext, verifier: Address): Promise<VerifierOnChain> {
  const record = await ctx.chain.getVerifier(verifier);
  await ctx.db.query(UPSERT_VERIFIER, [
    verifier,
    record.registered,
    record.approved,
    record.active,
    record.stake.toString(),
    isZero(record.metadataHash) ? null : record.metadataHash.toLowerCase(),
    record.metadataPointer || null,
    ctx.blockNumber,
    ctx.blockTime,
  ]);
  return record;
}

/** A verifier that acted on a task is alive; that is all `last_seen_at` claims. */
async function touchVerifier(ctx: EventContext, verifier: Address): Promise<void> {
  await ctx.db.query(
    `INSERT INTO verifiers (address, last_seen_at, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (address) DO UPDATE SET
       last_seen_at = GREATEST(verifiers.last_seen_at, EXCLUDED.last_seen_at),
       updated_at = now()`,
    [verifier, ctx.blockTime],
  );
}

/* ── dispute rows ────────────────────────────────────────────────────────── */

const UPSERT_DISPUTE = `
INSERT INTO disputes (
  task_id, challenger, bond, evidence_hash, evidence_pointer, resolved, upheld,
  adjudication_hash, adjudication_pointer, opened_at, deadline, resolved_at,
  open_tx, resolve_tx
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
ON CONFLICT (task_id) DO UPDATE SET
  challenger           = EXCLUDED.challenger,
  bond                 = EXCLUDED.bond,
  evidence_hash        = EXCLUDED.evidence_hash,
  evidence_pointer     = EXCLUDED.evidence_pointer,
  resolved             = EXCLUDED.resolved,
  upheld               = EXCLUDED.upheld,
  adjudication_hash    = EXCLUDED.adjudication_hash,
  adjudication_pointer = EXCLUDED.adjudication_pointer,
  opened_at            = EXCLUDED.opened_at,
  deadline             = EXCLUDED.deadline,
  resolved_at          = COALESCE(EXCLUDED.resolved_at, disputes.resolved_at),
  open_tx              = COALESCE(disputes.open_tx, EXCLUDED.open_tx),
  resolve_tx           = COALESCE(EXCLUDED.resolve_tx, disputes.resolve_tx)`;

async function refreshDisputeFromChain(
  ctx: EventContext,
  taskId: string,
  tx: { openTx?: string; resolveTx?: string },
): Promise<DisputeOnChain> {
  const dispute = await ctx.chain.getDispute(taskId as Hex);
  await ctx.db.query(UPSERT_DISPUTE, [
    taskId,
    dispute.challenger,
    dispute.bond.toString(),
    dispute.evidenceHash.toLowerCase(),
    dispute.evidencePointer,
    dispute.resolved,
    dispute.upheld,
    isZero(dispute.adjudicationHash) ? null : dispute.adjudicationHash.toLowerCase(),
    dispute.adjudicationPointer || null,
    chainTimeToDate(dispute.openedAt),
    chainTimeToDate(dispute.deadline),
    dispute.resolved ? ctx.blockTime : null,
    tx.openTx ?? null,
    tx.resolveTx ?? null,
  ]);
  return dispute;
}

/* ── projectors ──────────────────────────────────────────────────────────── */

export async function projectTaskCreated(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const task = await refreshTaskFromChain(ctx, taskId);
  await enqueueArtifactSync(ctx, {
    kind: "task-manifest",
    hash: task.manifestHash,
    pointer: task.manifestPointer,
    taskId,
    verifier: null,
  });
  metrics.taskCreated.inc();
}

/**
 * The manifest pointer and the three windows are already on the struct the
 * TaskCreated projector read, so this event adds nothing the chain does not
 * have — except a second chance to notice the manifest when TaskCreated fell
 * outside the indexed range.
 */
export async function projectTaskManifest(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const task = await refreshTaskFromChain(ctx, taskId);
  await enqueueArtifactSync(ctx, {
    kind: "task-manifest",
    hash: task.manifestHash,
    pointer: task.manifestPointer || String(args.manifestPointer ?? ""),
    taskId,
    verifier: null,
  });
}

const UPSERT_REPORT = `
INSERT INTO reports (
  task_id, verifier, commitment, report_hash, report_pointer, status,
  committed_at, revealed_at, commit_tx, reveal_tx
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (task_id, verifier) DO UPDATE SET
  commitment     = EXCLUDED.commitment,
  report_hash    = EXCLUDED.report_hash,
  report_pointer = EXCLUDED.report_pointer,
  -- From the struct, never from which event happened to arrive last: a commit
  -- projected after its own reveal must not push the row back to COMMITTED.
  status         = EXCLUDED.status,
  committed_at   = EXCLUDED.committed_at,
  revealed_at    = EXCLUDED.revealed_at,
  commit_tx      = COALESCE(EXCLUDED.commit_tx, reports.commit_tx),
  reveal_tx      = COALESCE(EXCLUDED.reveal_tx, reports.reveal_tx)`;

async function refreshReportFromChain(
  ctx: EventContext,
  taskId: string,
  verifier: Address,
  tx: { commitTx?: string; revealTx?: string },
): Promise<ReportOnChain> {
  const report = await ctx.chain.getReport(taskId as Hex, verifier);
  await ctx.db.query(UPSERT_REPORT, [
    taskId,
    verifier,
    report.commitment.toLowerCase(),
    isZero(report.reportHash) ? null : report.reportHash.toLowerCase(),
    report.reportPointer || null,
    report.revealed ? "REVEALED" : "COMMITTED",
    chainTimeToDate(report.committedAt),
    chainTimeToDate(report.revealedAt),
    tx.commitTx ?? null,
    tx.revealTx ?? null,
  ]);
  return report;
}

export async function projectReportCommitted(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const verifier = addr(args.verifier);
  await refreshTaskFromChain(ctx, taskId);
  await refreshReportFromChain(ctx, taskId, verifier, { commitTx: ctx.txHash });
  await touchVerifier(ctx, verifier);
  metrics.verifierCommit.inc();
}

export async function projectReportRevealed(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const verifier = addr(args.verifier);
  const task = await refreshTaskFromChain(ctx, taskId);
  const report = await refreshReportFromChain(ctx, taskId, verifier, { revealTx: ctx.txHash });
  await touchVerifier(ctx, verifier);
  await enqueueArtifactSync(ctx, {
    kind: "verifier-report",
    hash: report.reportHash,
    pointer: report.reportPointer || String(args.reportPointer ?? ""),
    taskId,
    verifier,
  });
  metrics.verifierReveal.inc();

  // The last reveal is what makes a task evaluable, so it is what starts the
  // settlement path. Without this nothing ever enqueues CONSENSUS_EVALUATION,
  // and a task that everyone agreed on can only settle later through
  // expireTask — which pays the *conflict* rate. Agreement would silently
  // never be rewarded as agreement.
  // Only while the task is still awaiting settlement. A historical replay
  // re-projects reveals for tasks that finalized months ago; queuing those
  // produces work the keeper correctly refuses ("task status is 7, not
  // Revealing") and a FAILED_FINAL row that reads like a fault.
  if (task.revealedCount >= task.verifierCount && task.status === TaskStatus.Revealing) {
    await enqueueConsensusEvaluation(ctx, taskId);
  }
}

export const CONSENSUS_EVALUATION_JOB = "CONSENSUS_EVALUATION";

/**
 * One evaluation per task, ever. The idempotency key is the task, so a replay
 * of the reveal log — or a second reveal arriving out of order — cannot queue a
 * second evaluation of the same reports.
 */
export async function enqueueConsensusEvaluation(ctx: EventContext, taskId: string): Promise<boolean> {
  const result = await ctx.db.query(
    `INSERT INTO jobs (idempotency_key, task_id, job_type, status, payload, next_retry_at)
     VALUES ($1, $2, $3, 'PENDING', $4::jsonb, now())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      `consensus:${taskId.toLowerCase()}`,
      taskId.toLowerCase(),
      CONSENSUS_EVALUATION_JOB,
      JSON.stringify({ taskId: taskId.toLowerCase(), block: ctx.blockNumber }),
    ],
  );
  if (result.rowCount === 1) {
    ctx.logger?.info("queued consensus evaluation", { taskId, component: "indexer" });
  }
  return result.rowCount === 1;
}

export async function projectChallengeOpened(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  await refreshTaskFromChain(ctx, taskId);
  const dispute = await refreshDisputeFromChain(ctx, taskId, { openTx: ctx.txHash });
  await enqueueArtifactSync(ctx, {
    kind: "challenge-evidence",
    hash: dispute.evidenceHash,
    pointer: dispute.evidencePointer,
    taskId,
    verifier: null,
  });
  metrics.disputeOpened.inc();
}

const UPSERT_CONSENSUS = `
INSERT INTO consensus_results (task_id, outcome, agreement_bps, result_hash, evaluated_at, tx_hash)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (task_id) DO UPDATE SET
  outcome      = EXCLUDED.outcome,
  result_hash  = EXCLUDED.result_hash,
  evaluated_at = EXCLUDED.evaluated_at,
  tx_hash      = COALESCE(consensus_results.tx_hash, EXCLUDED.tx_hash)`;

/**
 * `agreement_bps`, the per-claim breakdown and the rewarded set live in the
 * consensus-result artifact, not in the event — the event carries `rewardBps`,
 * which is a payout share and a different number. They stay at their defaults
 * until the artifact is fetched and hash-checked, and the upsert above leaves
 * them alone so a later event cannot erase them.
 */
export async function projectConsensusReached(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const task = await refreshTaskFromChain(ctx, taskId);
  const resultHash = isZero(task.resultHash) ? hex(args.resultHash) : task.resultHash.toLowerCase();
  await ctx.db.query(UPSERT_CONSENSUS, [
    taskId,
    outcomeName(task.outcome === 0 ? num(args.outcome) : task.outcome),
    0,
    resultHash,
    chainTimeToDate(task.consensusAt) ?? ctx.blockTime,
    ctx.txHash,
  ]);
  // No pointer is emitted with the result hash; the sync worker resolves it
  // from the artifact index or by asking storage for the hash directly.
  await enqueueArtifactSync(ctx, {
    kind: "consensus-result",
    hash: resultHash,
    pointer: null,
    taskId,
    verifier: null,
  });
}

export async function projectTaskFinalized(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const task = await refreshTaskFromChain(ctx, taskId);
  metrics.taskCompleted.inc({ outcome: outcomeName(task.outcome) });
}

export async function projectRewardAllocated(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const beneficiary = addr(args.beneficiary);
  const amount = big(args.amount);
  await refreshTaskFromChain(ctx, taskId);

  // allocationOf accumulates across every allocation on the task and is zeroed
  // by a claim, so the row keeps whichever is larger: the chain's running total
  // while it stands, the sum we watched being allocated once it is claimed.
  const onChain = await ctx.chain.allocationOf(taskId as Hex, beneficiary);
  const observed = onChain > amount ? onChain : amount;
  await ctx.db.query(
    // `created_at` is the block the allocation happened in, not the moment the
    // indexer wrote the row. The default would be `now()`, which makes
    // `bountiesSettledTrendPct` a measure of when someone last replayed the read
    // model — and a rebuild is a documented operation, not an accident.
    `INSERT INTO allocations (task_id, beneficiary, amount, tx_hash, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (task_id, beneficiary) DO UPDATE SET
       amount     = GREATEST(allocations.amount, EXCLUDED.amount),
       tx_hash    = COALESCE(allocations.tx_hash, EXCLUDED.tx_hash),
       created_at = LEAST(allocations.created_at, EXCLUDED.created_at)`,
    [taskId, beneficiary, observed.toString(), ctx.txHash, ctx.blockTime],
  );
  metrics.payout.inc({ kind: "allocated" }, Number(amount));
}

/**
 * A cancellation credits the creator's `pendingWithdrawals` directly rather
 * than going through `_allocations`, so `allocationOf` reads zero for the whole
 * of its life. The row is still written from the event's own amount, because
 * the creator was credited the bounty and a ledger that showed nothing would be
 * lying about where the money went.
 */
export async function projectTaskCancelled(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const creator = addr(args.creator);
  const bounty = big(args.bounty);
  await refreshTaskFromChain(ctx, taskId);
  await ctx.db.query(
    `INSERT INTO allocations (task_id, beneficiary, amount, tx_hash, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (task_id, beneficiary) DO UPDATE SET
       amount     = GREATEST(allocations.amount, EXCLUDED.amount),
       tx_hash    = COALESCE(allocations.tx_hash, EXCLUDED.tx_hash),
       created_at = LEAST(allocations.created_at, EXCLUDED.created_at)`,
    [taskId, creator, bounty.toString(), ctx.txHash, ctx.blockTime],
  );
  metrics.payout.inc({ kind: "refunded" }, Number(bounty));
}

/**
 * `refundCreator` pays out the creator's entire pending balance, so the amount
 * here can exceed this task's bounty and belongs to no single task. It is
 * recorded as an event on the task that triggered it and nothing else — in
 * particular it must not be written to `allocations`, which is per task.
 */
export async function projectRefundClaimed(ctx: EventContext, args: EventArgs): Promise<void> {
  await refreshTaskFromChain(ctx, hex(args.taskId));
  metrics.payout.inc({ kind: "claimed" }, Number(big(args.amount)));
}

export async function projectDisputeResolved(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  await refreshTaskFromChain(ctx, taskId);
  const dispute = await refreshDisputeFromChain(ctx, taskId, { resolveTx: ctx.txHash });
  await enqueueArtifactSync(ctx, {
    kind: "adjudication-report",
    hash: isZero(dispute.adjudicationHash) ? hex(args.adjudicationHash) : dispute.adjudicationHash,
    pointer: dispute.adjudicationPointer || String(args.adjudicationPointer ?? ""),
    taskId,
    verifier: null,
  });
}

/**
 * The inverse of `projectRewardAllocated`. An upheld dispute calls `_reclaimAll`,
 * which zeroes every allocation on the task, and the allocation row has to follow
 * it down — the GREATEST() in the allocation path exists to survive a claim
 * zeroing `allocationOf`, and it would otherwise pin a reclaimed allocation at
 * its old value forever. This writes the chain's own reading rather than
 * subtracting, so a replay converges on the same row.
 */
export async function projectRewardReclaimed(ctx: EventContext, args: EventArgs): Promise<void> {
  const taskId = hex(args.taskId);
  const beneficiary = addr(args.beneficiary);
  const amount = big(args.amount);
  await refreshTaskFromChain(ctx, taskId);

  const onChain = await ctx.chain.allocationOf(taskId as Hex, beneficiary);
  await ctx.db.query(
    `UPDATE allocations SET amount = $3 WHERE task_id = $1 AND beneficiary = $2`,
    [taskId, beneficiary, onChain.toString()],
  );
  metrics.payout.inc({ kind: "reclaimed" }, Number(amount));
}

export async function projectVerifierActiveSet(ctx: EventContext, args: EventArgs): Promise<void> {
  await refreshVerifierFromChain(ctx, addr(args.verifier));
}

export async function projectStakeWithdrawn(ctx: EventContext, args: EventArgs): Promise<void> {
  await refreshVerifierFromChain(ctx, addr(args.verifier));
}

export async function projectVerifierRegistered(ctx: EventContext, args: EventArgs): Promise<void> {
  await refreshVerifierFromChain(ctx, addr(args.verifier));
}

export async function projectVerifierApprovalSet(ctx: EventContext, args: EventArgs): Promise<void> {
  await refreshVerifierFromChain(ctx, addr(args.verifier));
}

const ROLE_NAMES = new Map<string, string>([
  [ROLE.KEEPER.toLowerCase(), "KEEPER"],
  [ROLE.ADJUDICATOR.toLowerCase(), "ADJUDICATOR"],
  [ROLE.PAUSER.toLowerCase(), "PAUSER"],
  [ROLE.ADMIN.toLowerCase(), "ADMIN"],
]);

export function roleName(role: string): string {
  return ROLE_NAMES.get(role.toLowerCase()) ?? role.toLowerCase();
}

/**
 * Roles land on the verifier directory because that is the only operator table
 * the read model has, and the UI's "Adjudicator / Keeper" badge reads from it.
 * An account can hold a role without ever registering as a verifier, which is
 * why the row is created here rather than only updated.
 */
export async function projectRoleGranted(ctx: EventContext, args: EventArgs): Promise<void> {
  const account = addr(args.account);
  await ctx.db.query(
    `INSERT INTO verifiers (address, role, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (address) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [account, roleName(hex(args.role))],
  );
  await refreshVerifierFromChain(ctx, account);
}

/* ── dispatch ────────────────────────────────────────────────────────────── */

const PROJECTORS: Record<ProofRelayEventName, (ctx: EventContext, args: EventArgs) => Promise<void>> = {
  TaskCreated: projectTaskCreated,
  TaskManifest: projectTaskManifest,
  ReportCommitted: projectReportCommitted,
  ReportRevealed: projectReportRevealed,
  ChallengeOpened: projectChallengeOpened,
  ConsensusReached: projectConsensusReached,
  TaskFinalized: projectTaskFinalized,
  RewardAllocated: projectRewardAllocated,
  TaskCancelled: projectTaskCancelled,
  RefundClaimed: projectRefundClaimed,
  DisputeResolved: projectDisputeResolved,
  VerifierRegistered: projectVerifierRegistered,
  VerifierApprovalSet: projectVerifierApprovalSet,
  RoleGranted: projectRoleGranted,
  RewardReclaimed: projectRewardReclaimed,
  VerifierActiveSet: projectVerifierActiveSet,
  StakeWithdrawn: projectStakeWithdrawn,
};

export async function applyEvent(
  ctx: EventContext,
  name: ProofRelayEventName,
  args: EventArgs,
): Promise<void> {
  const projector = PROJECTORS[name];
  if (!projector) return;
  await projector(ctx, args);
}
