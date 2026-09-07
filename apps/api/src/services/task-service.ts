/**
 * Everything that turns chain + storage state into the task DTOs the UI reads.
 *
 * Three rules shape this file.
 *
 * 1. The chain wins. `getTask` re-reads the struct while it builds the detail
 *    and reports `syncRequired` when the stored row disagrees; `syncTask`
 *    rewrites the row from the structs and is what clears that banner. The read
 *    model is a cache, and it says so rather than pretending otherwise.
 * 2. No invented numbers. Every field here is a measurement or a null. Where a
 *    metric has no sample — no settled task, no prior window — the DTO carries
 *    `null` and its sample size, because a fabricated 93.8% is worse than an
 *    empty card.
 * 3. Storage bodies are untrusted. A manifest or report body is hashed *as
 *    received* and compared against the hash the chain holds before it is
 *    parsed; a mismatch drops the body instead of rendering it.
 */
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { Config } from "@proofrelay/config";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import {
  txUrl,
  type ChainClient,
  type DisputeOnChain,
  type ReportOnChain,
  type TaskOnChain,
} from "@proofrelay/chain-client";
import { claimConfidencePct, displayVerdict, evaluateClaim } from "@proofrelay/consensus";
import {
  Outcome,
  ProofRelayError,
  TaskListQuery,
  TaskManifest,
  TaskStatus,
  VerifierReport,
  displayStatus,
  displayTone,
  formatToken,
  hashesEqual,
  objectHash,
  outcomeName,
  resolveRule,
  shortAddress,
  shortHash,
  statusName,
  type ClaimConsensus,
  type ClaimView,
  type ConsensusOutcome,
  type DisplayStatus,
  type DisputeView,
  type ManifestClaim,
  type ReportView,
  type TaskDetail,
  type TaskListResponse,
  type TaskSummary,
  type TxRef,
  type WorkspaceStats,
} from "@proofrelay/schemas";
import { chainTimeToDate, many, one, type Pool } from "../db.js";
import { cursorTimestamp, rejectCursor } from "../middleware/cursor.js";
import type { Logger } from "../observability.js";
import { normalizeTaskId, refForSequence, resolveTaskId, type Db } from "./refs.js";

/* ── context ─────────────────────────────────────────────────────────────── */

/**
 * The chain reads a task view needs. Structural rather than `ChainClient` so a
 * suite can pin a struct without standing up a JSON-RPC transport.
 */
export interface TaskChainReader {
  readonly chainId: number;
  readonly contract: Address;
  getTask(taskId: Hex): Promise<TaskOnChain>;
  getReport(taskId: Hex, verifier: Address): Promise<ReportOnChain>;
  getTaskVerifiers(taskId: Hex): Promise<readonly Address[]>;
  getDispute(taskId: Hex): Promise<DisputeOnChain>;
  allocationOf(taskId: Hex, account: Address): Promise<bigint>;
}

/**
 * Compile-time proof that the real client satisfies the reader. The structural
 * type exists so a suite can stub the chain, not so the two can drift apart.
 */
type Assert<T extends true> = T;
export type ChainClientIsTaskChainReader = Assert<
  ChainClient extends TaskChainReader ? true : false
>;

export interface TaskServiceContext {
  db: Db;
  chain: TaskChainReader;
  storage: StorageAdapter;
  config: Config;
  logger?: Logger | undefined;
  now?: (() => Date) | undefined;
}

export interface SyncResult {
  taskId: string;
  ref: string;
  status: string;
  syncState: "OK" | "SYNC_REQUIRED";
  /** Row columns the chain read actually changed; empty when the row was already right. */
  changed: string[];
  task: TaskDetail;
}

export type TaskListQueryInput = z.input<typeof TaskListQuery>;

/* ── constants ───────────────────────────────────────────────────────────── */

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const TREND_WINDOW_MS = 7 * 86_400_000;

/** Reached a result. Expired and Cancelled ended without one and are not settled. */
const SETTLED = TaskStatus.Finalized;
const TERMINAL = [TaskStatus.None, TaskStatus.Finalized, TaskStatus.Expired, TaskStatus.Cancelled];

const DISPLAY_STATUSES: DisplayStatus[] = [
  "VERIFIED",
  "IN REVIEW",
  "CONFLICT",
  "NO QUORUM",
  "DISPUTED",
  "EXPIRED",
  "CANCELLED",
];

/** The largest value `TaskStatus` defines; `tasks.status` is a smallint. */
const MAX_STATUS_CODE = Math.max(...Object.values(TaskStatus));

/**
 * `displayStatus()` in SQL. Duplicated deliberately: the alternative is loading
 * every row to group it in TypeScript. `task-service.test.ts` asserts the two
 * agree over every status/outcome pair, so a change to one fails on the other.
 */
export const DISPLAY_STATUS_SQL = `
  CASE
    WHEN t.status = 9 THEN 'CANCELLED'
    WHEN t.status = 8 THEN 'EXPIRED'
    WHEN t.status IN (5, 6) THEN 'DISPUTED'
    WHEN t.status = 7 THEN CASE
      WHEN t.outcome = 1 THEN 'VERIFIED'
      WHEN t.outcome = 2 THEN 'CONFLICT'
      WHEN t.outcome = 3 THEN 'NO QUORUM'
      ELSE 'IN REVIEW'
    END
    ELSE 'IN REVIEW'
  END`;

/* ── row shapes ──────────────────────────────────────────────────────────── */

interface TaskRow {
  task_id: string;
  sequence: number;
  creator: string;
  status: number;
  outcome: number;
  bounty: string;
  verifier_count: number;
  committed_count: number;
  revealed_count: number;
  reward_bps: number;
  manifest_hash: string;
  manifest_pointer: string;
  rule_id: string;
  result_hash: string | null;
  commit_deadline: Date | null;
  reveal_deadline: Date | null;
  dispute_deadline: Date | null;
  consensus_at: Date | null;
  title: string | null;
  question: string | null;
  claim_count: number | null;
  source_count: number | null;
  primary_source: string | null;
  manifest_verified: boolean;
  created_block: number | null;
  tx_hash: string | null;
  created_at: Date;
  updated_at: Date;
  manifest_title: string | null;
  manifest_question: string | null;
  manifest_claim_count: number | null;
  manifest_source_count: number | null;
  consensus_outcome: string | null;
  agreement_bps: number | null;
  consensus_result_pointer: string | null;
  conflicts: unknown;
  rewarded_verifiers: unknown;
  evaluated_at: Date | null;
  has_dispute: boolean;
  committed_seen: number;
  revealed_seen: number;
  finalized_events: number;
  challenge_events: number;
}

const TASK_SELECT = `
  SELECT
    t.task_id, t.sequence, t.creator, t.status, t.outcome, t.bounty,
    t.verifier_count, t.committed_count, t.revealed_count, t.reward_bps,
    t.manifest_hash, t.manifest_pointer, t.rule_id, t.result_hash,
    t.commit_deadline, t.reveal_deadline, t.dispute_deadline, t.consensus_at,
    t.title, t.question, t.claim_count, t.source_count, t.primary_source,
    t.manifest_verified, t.created_block, t.tx_hash, t.created_at, t.updated_at,
    m.title         AS manifest_title,
    m.question      AS manifest_question,
    m.claim_count   AS manifest_claim_count,
    m.source_count  AS manifest_source_count,
    c.outcome       AS consensus_outcome,
    c.agreement_bps AS agreement_bps,
    c.result_pointer AS consensus_result_pointer,
    c.conflicts, c.rewarded_verifiers, c.evaluated_at,
    (d.task_id IS NOT NULL) AS has_dispute,
    (SELECT count(*) FROM reports r WHERE r.task_id = t.task_id AND r.committed_at IS NOT NULL)::int AS committed_seen,
    (SELECT count(*) FROM reports r WHERE r.task_id = t.task_id AND r.revealed_at  IS NOT NULL)::int AS revealed_seen,
    (SELECT count(*) FROM chain_events e WHERE e.task_id = t.task_id AND e.event_name = 'TaskFinalized')::int AS finalized_events,
    (SELECT count(*) FROM chain_events e WHERE e.task_id = t.task_id AND e.event_name = 'ChallengeOpened')::int AS challenge_events
  FROM tasks t
  LEFT JOIN manifests         m ON lower(m.manifest_hash) = lower(t.manifest_hash)
  LEFT JOIN consensus_results c ON c.task_id = t.task_id
  LEFT JOIN disputes          d ON d.task_id = t.task_id`;

/* ── small helpers ───────────────────────────────────────────────────────── */

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoOrNow(value: Date | string | null | undefined, fallback: Date): string {
  return iso(value) ?? fallback.toISOString();
}

function txRef(chainId: number, hash: string | null | undefined, block: number | null | undefined): TxRef {
  return {
    txHash: hash ?? null,
    blockNumber: block ?? null,
    explorerUrl: txUrl(chainId, hash ?? null),
  };
}

function nonZeroHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^0x0{64}$/i.test(value) ? null : value;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

/**
 * `disputeWindow` on the task struct is a duration, not a deadline — the live
 * finalized tasks read back 900 next to a `consensusAt` of 1788176208, and the
 * `ConsensusReached` event carries the absolute deadline separately. Treating
 * it as a timestamp would put every dispute deadline in 1970.
 */
export function disputeDeadlineFrom(consensusAt: number, disputeWindow: number): Date | null {
  if (consensusAt <= 0 || disputeWindow <= 0) return null;
  return new Date((consensusAt + disputeWindow) * 1000);
}

/** `docs.0g.ai / understanding-0g`, the label the evidence rows show. */
export function sourceLabel(uri: string): string {
  try {
    const url = new URL(uri);
    if (!url.host) return uri;
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? `${url.host} / ${decodeURIComponent(last)}` : url.host;
  } catch {
    return uri;
  }
}

/* ── agreement ───────────────────────────────────────────────────────────── */

export interface AgreementInput {
  verifierCount: number;
  committedCount: number;
  revealedCount: number;
  statusCode: number;
  outcomeCode: number;
  consensus: { outcome: ConsensusOutcome; agreementBps: number; agreeingVerifiers: number } | null;
}

/**
 * The settled outcome, preferring the evaluated result and falling back to the
 * chain's own `outcome`. A task the keeper finalized before the read model
 * caught the consensus artifact still has an outcome onchain, and rendering it
 * as "awaiting" would contradict the value the explorer shows.
 */
function settledOutcome(input: AgreementInput): ConsensusOutcome | null {
  if (input.consensus) return input.consensus.outcome;
  switch (input.outcomeCode) {
    case Outcome.Consensus:
      return "CONSENSUS";
    case Outcome.Conflict:
      return "CONFLICT";
    case Outcome.NoQuorum:
      return "NO_QUORUM";
    default:
      return null;
  }
}

/** `2/2 agree`, `1/2 agree`, `Conflict` — the string in the task table. */
export function agreementLabel(input: AgreementInput): string {
  const outcome = settledOutcome(input);
  if (outcome === "CONFLICT") return "Conflict";
  if (outcome === "NO_QUORUM") return "No quorum";
  if (outcome === "CONSENSUS") {
    // Only a CONSENSUS result names beneficiaries, so its length is the count of
    // verifiers that actually agreed; a settled task the index has not evaluated
    // falls back to the reveals the chain counted.
    const agreeing = input.consensus?.agreeingVerifiers || input.revealedCount;
    return `${agreeing}/${input.verifierCount} agree`;
  }
  if (input.statusCode === TaskStatus.Cancelled) return "Cancelled";
  if (input.statusCode === TaskStatus.Expired) return "Expired";
  if (input.revealedCount > 0) return `${input.revealedCount}/${input.verifierCount} revealed`;
  return `${input.committedCount}/${input.verifierCount} committed`;
}

/**
 * The progress bar width. Full on agreement, the evaluated agreement once there
 * is one, and otherwise the share of the commit/reveal lifecycle that is done —
 * which is a progress measure, not an agreement measure, and is why the bar is
 * only ever read next to `agreementLabel`.
 */
export function agreementPct(input: AgreementInput): number {
  if (settledOutcome(input) === "CONSENSUS") return 100;
  if (input.consensus) return clampPct(input.consensus.agreementBps / 100);
  if (input.verifierCount <= 0) return 0;
  return clampPct(((input.committedCount + input.revealedCount) / (2 * input.verifierCount)) * 100);
}

function agreementInput(row: TaskRow): AgreementInput {
  const outcome = row.consensus_outcome;
  return {
    verifierCount: row.verifier_count,
    committedCount: row.committed_count,
    revealedCount: row.revealed_count,
    statusCode: row.status,
    outcomeCode: row.outcome,
    consensus:
      outcome === "CONSENSUS" || outcome === "CONFLICT" || outcome === "NO_QUORUM"
        ? {
            outcome,
            agreementBps: row.agreement_bps ?? 0,
            agreeingVerifiers: stringArray(row.rewarded_verifiers).length,
          }
        : null,
  };
}

/* ── drift ───────────────────────────────────────────────────────────────── */

/**
 * Disagreements the read model can find in itself, without a chain read.
 *
 * Every input here already came from the chain — `chain_events` is the raw log
 * stream and `reports` is projected from it — so a row that contradicts them
 * contradicts the chain. This is the signal the task *list* uses, because
 * `getTask` per row would be one RPC round trip per visible task.
 */
export function indexDrift(row: TaskRow): string[] {
  const reasons: string[] = [];
  if (row.committed_seen > row.committed_count) reasons.push("committed_count");
  if (row.revealed_seen > row.revealed_count) reasons.push("revealed_count");
  if (row.finalized_events > 0 && row.status !== TaskStatus.Finalized) reasons.push("status");
  if (row.status === TaskStatus.Finalized && !nonZeroHash(row.result_hash)) reasons.push("result_hash");
  if (row.challenge_events > 0 && !row.has_dispute) reasons.push("dispute");
  if (
    row.consensus_outcome &&
    (row.status === TaskStatus.Open ||
      row.status === TaskStatus.Committing ||
      row.status === TaskStatus.Revealing)
  ) {
    reasons.push("consensus");
  }
  return reasons;
}

/** The authoritative comparison: stored row against a struct read this second. */
export function chainDrift(row: TaskRow, onchain: TaskOnChain): string[] {
  const reasons: string[] = [];
  const same = (a: unknown, b: unknown, field: string) => {
    if (a !== b) reasons.push(field);
  };

  same(row.status, onchain.status, "status");
  same(row.outcome, onchain.outcome, "outcome");
  same(row.verifier_count, onchain.verifierCount, "verifier_count");
  same(row.committed_count, onchain.committedCount, "committed_count");
  same(row.revealed_count, onchain.revealedCount, "revealed_count");
  same(row.reward_bps, onchain.rewardBps, "reward_bps");
  same(BigInt(row.bounty || "0") === onchain.bounty, true, "bounty");
  same(row.creator.toLowerCase(), onchain.creator.toLowerCase(), "creator");
  same(hashesEqual(row.manifest_hash, onchain.manifestHash), true, "manifest_hash");
  same(hashesEqual(row.rule_id, onchain.ruleId), true, "rule_id");
  same(row.manifest_pointer, onchain.manifestPointer, "manifest_pointer");

  const resultHash = nonZeroHash(onchain.resultHash);
  if (nonZeroHash(row.result_hash)?.toLowerCase() !== resultHash?.toLowerCase()) {
    reasons.push("result_hash");
  }

  const deadlines: [string, Date | null, Date | null][] = [
    ["commit_deadline", row.commit_deadline, chainTimeToDate(onchain.commitDeadline)],
    ["reveal_deadline", row.reveal_deadline, chainTimeToDate(onchain.revealDeadline)],
    ["consensus_at", row.consensus_at, chainTimeToDate(onchain.consensusAt)],
    [
      "dispute_deadline",
      row.dispute_deadline,
      disputeDeadlineFrom(onchain.consensusAt, onchain.disputeWindow),
    ],
  ];
  for (const [field, stored, expected] of deadlines) {
    if ((stored?.getTime() ?? null) !== (expected?.getTime() ?? null)) reasons.push(field);
  }
  return reasons;
}

/* ── summary projection ──────────────────────────────────────────────────── */

function toSummary(row: TaskRow, chainId: number, syncRequired: boolean): TaskSummary {
  const ref = refForSequence(Number(row.sequence));
  const display = displayStatus(row.status, row.outcome);
  const agreement = agreementInput(row);

  return {
    taskId: row.task_id,
    ref,
    // The manifest is the only place a title exists. Until it has been read the
    // honest label is the handle, not a placeholder sentence.
    title: row.title ?? row.manifest_title ?? ref,
    question: row.question ?? row.manifest_question ?? "",
    primarySource: row.primary_source,
    sourceCount: row.source_count ?? row.manifest_source_count ?? 0,
    status: display,
    rawStatus: statusName(row.status),
    rawStatusCode: row.status,
    outcome: outcomeName(row.outcome),
    tone: displayTone(display),
    creator: row.creator,
    bountyWei: row.bounty,
    bountyFormatted: formatToken(row.bounty),
    verifierCount: row.verifier_count,
    committedCount: row.committed_count,
    revealedCount: row.revealed_count,
    agreementLabel: agreementLabel(agreement),
    agreementPct: agreementPct(agreement),
    claimCount: row.claim_count ?? row.manifest_claim_count ?? 0,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    commitDeadline: iso(row.commit_deadline),
    revealDeadline: iso(row.reveal_deadline),
    disputeDeadline: iso(row.dispute_deadline),
    manifestHash: row.manifest_hash,
    manifestPointer: row.manifest_pointer,
    resultHash: nonZeroHash(row.result_hash),
    hasDispute: row.has_dispute,
    syncRequired,
    tx: txRef(chainId, row.tx_hash, row.created_block),
  };
}

/* ── list ────────────────────────────────────────────────────────────────── */

interface StatusFilter {
  displays: DisplayStatus[] | null;
  codes: number[] | null;
}

/**
 * The four filter tabs are display groups, not contract states, so the filter
 * is applied against the same CASE the counts are grouped by. A raw contract
 * status is accepted too — the runbook's curl examples use them.
 */
export function parseStatusFilter(raw: string | undefined): StatusFilter {
  if (!raw) return { displays: null, codes: null };
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toUpperCase().replace(/_/g, " "))
    .filter(Boolean);
  if (tokens.length === 0 || tokens.includes("ALL")) return { displays: null, codes: null };

  const displays: DisplayStatus[] = [];
  const codes: number[] = [];
  for (const token of tokens) {
    if ((DISPLAY_STATUSES as string[]).includes(token)) {
      displays.push(token as DisplayStatus);
      continue;
    }
    const named = Object.entries(TaskStatus).find(([name]) => name.toUpperCase() === token);
    if (named) {
      codes.push(named[1]);
      continue;
    }
    // Range-checked here rather than left to Postgres: `t.status = ANY($n::int[])`
    // with 2^31 raises 22003, which reaches the client as a 500 INTERNAL with
    // nothing to act on. A status outside the contract's enum is a bad request.
    if (/^\d+$/.test(token)) {
      const code = Number(token);
      if (code > MAX_STATUS_CODE) {
        throw new ProofRelayError("VALIDATION_FAILED", `no task status ${token} exists`, {
          detail: { status: token, accepted: [...DISPLAY_STATUSES, "ALL", ...Object.keys(TaskStatus)] },
        });
      }
      codes.push(code);
      continue;
    }
    throw new ProofRelayError("VALIDATION_FAILED", `unknown status filter ${token}`, {
      detail: { status: token, accepted: [...DISPLAY_STATUSES, "ALL", ...Object.keys(TaskStatus)] },
    });
  }
  return { displays: displays.length ? displays : null, codes: codes.length ? codes : null };
}

interface Cursor {
  createdAt: string;
  taskId: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.taskId}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator < 0) rejectCursor(raw);
  const taskId = decoded.slice(separator + 1);
  if (!taskId) rejectCursor(raw);
  // Validated against `timestamptz`, not against `new Date`: JavaScript accepts
  // `+275760-09-13T00:00:00.000Z` and Postgres does not, and the difference
  // arrives as a 500 rather than as a rejected cursor.
  return { createdAt: cursorTimestamp(decoded.slice(0, separator), raw), taskId };
}

interface FilterSql {
  clauses: string[];
  values: unknown[];
}

function baseFilters(query: z.infer<typeof TaskListQuery>): FilterSql {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.creator) {
    values.push(query.creator.toLowerCase());
    clauses.push(`lower(t.creator) = $${values.length}`);
  }
  if (query.q) {
    values.push(`%${query.q.trim()}%`);
    const placeholder = `$${values.length}`;
    // The manifest body carries the claim texts and every source URI, and it is
    // already denormalised here, so the search reaches them without a storage read.
    clauses.push(
      `(t.task_id ILIKE ${placeholder} OR COALESCE(t.title, m.title, '') ILIKE ${placeholder} ` +
        `OR COALESCE(t.question, m.question, '') ILIKE ${placeholder} ` +
        `OR COALESCE(t.primary_source, '') ILIKE ${placeholder} ` +
        `OR COALESCE(m.body::text, '') ILIKE ${placeholder})`,
    );
  }
  return { clauses, values };
}

export async function listTasks(
  ctx: TaskServiceContext,
  input: TaskListQueryInput = {},
): Promise<TaskListResponse> {
  const query = TaskListQuery.parse(input);
  const status = parseStatusFilter(query.status);
  const cursor = decodeCursor(query.cursor);

  const base = baseFilters(query);
  const counts = await countsByDisplay(ctx.db, base);

  const values = [...base.values];
  const clauses = [...base.clauses];
  if (status.displays) {
    values.push(status.displays);
    clauses.push(`(${DISPLAY_STATUS_SQL}) = ANY($${values.length}::text[])`);
  }
  if (status.codes) {
    values.push(status.codes);
    clauses.push(`t.status = ANY($${values.length}::int[])`);
  }

  const total = await countMatching(ctx.db, clauses, values);

  if (cursor) {
    values.push(cursor.createdAt, cursor.taskId);
    clauses.push(
      `(t.created_at, t.task_id) < ($${values.length - 1}::timestamptz, $${values.length}::text)`,
    );
  }
  values.push(query.limit + 1);

  // Keyed on (created_at, task_id) rather than OFFSET, which is the right shape
  // — but be precise about what it guarantees, because `created_at` is not
  // immutable: `projectTaskCreated` writes it with LEAST(), so a backfill that
  // reaches an earlier log for an already-indexed task moves it EARLIER.
  //
  // The order is `created_at DESC`, so moving earlier only ever pushes a row
  // further down the list, past a reader who has already gone by. That means a
  // page can repeat a task during a backfill; it cannot skip one. Callers that
  // must not double-count should key on `taskId`.
  const rows = await many<TaskRow>(
    ctx.db,
    `${TASK_SELECT}
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY t.created_at DESC, t.task_id DESC
     LIMIT $${values.length}`,
    values,
  );

  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toSummary(row, ctx.chain.chainId, indexDrift(row).length > 0)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), taskId: last.task_id })
        : null,
    total,
    counts,
  };
}

async function countsByDisplay(db: Db, base: FilterSql): Promise<Record<string, number>> {
  const rows = await many<{ display: string; n: number }>(
    db,
    `SELECT (${DISPLAY_STATUS_SQL}) AS display, count(*)::int AS n
     FROM tasks t
     LEFT JOIN manifests m ON lower(m.manifest_hash) = lower(t.manifest_hash)
     ${base.clauses.length ? `WHERE ${base.clauses.join(" AND ")}` : ""}
     GROUP BY 1`,
    base.values,
  );
  const counts: Record<string, number> = { ALL: 0 };
  for (const display of DISPLAY_STATUSES) counts[display] = 0;
  for (const row of rows) {
    counts[row.display] = Number(row.n);
    counts.ALL = (counts.ALL ?? 0) + Number(row.n);
  }
  return counts;
}

async function countMatching(db: Db, clauses: string[], values: unknown[]): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n
     FROM tasks t
     LEFT JOIN manifests m ON lower(m.manifest_hash) = lower(t.manifest_hash)
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`,
    values,
  );
  return Number(row?.n ?? 0);
}

/* ── artifact loading ────────────────────────────────────────────────────── */

/**
 * A body is hashed exactly as it arrived and only then parsed. Parsing first
 * would strip unknown keys and hash a different object than the one the chain
 * committed to, which is the quiet way a mismatch turns into a false match.
 *
 * With no expected hash there is nothing to check against, and an unchecked
 * body is dropped rather than rendered: "we could not verify this" must never
 * take the same path as "we verified it".
 */
function verifiedBody<T>(
  schema: { parse(value: unknown): T },
  body: unknown,
  expectedHash: string | null,
  logger: Logger | undefined,
  fields: Record<string, unknown>,
): T | null {
  if (body === null || body === undefined) return null;
  if (!expectedHash) {
    logger?.warn("artifact body has no onchain hash to check against", {
      ...fields,
      errorCode: "CONTENT_HASH_MISMATCH",
    });
    return null;
  }
  if (!hashesEqual(objectHash(body), expectedHash)) {
    logger?.error("artifact body does not match its onchain hash", {
      ...fields,
      errorCode: "CONTENT_HASH_MISMATCH",
      expectedHash,
      actualHash: objectHash(body),
    });
    return null;
  }
  try {
    return schema.parse(body);
  } catch (error) {
    logger?.warn("artifact body failed schema validation", {
      ...fields,
      errorCode: "COMPUTE_INVALID_OUTPUT",
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    });
    return null;
  }
}

async function loadManifest(ctx: TaskServiceContext, row: TaskRow): Promise<TaskManifest | null> {
  const cached = await one<{ body: unknown }>(
    ctx.db,
    "SELECT body FROM manifests WHERE lower(manifest_hash) = $1",
    [row.manifest_hash.toLowerCase()],
  );
  const fields = { taskId: row.task_id };
  if (cached?.body) {
    return verifiedBody(TaskManifest, cached.body, row.manifest_hash, ctx.logger, fields);
  }
  if (!row.manifest_pointer) return null;
  try {
    const fetched = await ctx.storage.getJson(row.manifest_pointer);
    return verifiedBody(TaskManifest, fetched, row.manifest_hash, ctx.logger, fields);
  } catch (error) {
    ctx.logger?.warn("manifest could not be read from storage", {
      ...fields,
      errorCode: "STORAGE_UNAVAILABLE",
      pointer: row.manifest_pointer,
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    });
    return null;
  }
}

interface ReportRow {
  verifier: string;
  commitment: string;
  report_hash: string | null;
  report_pointer: string | null;
  status: string;
  model_id: string | null;
  pipeline_version: string | null;
  body: unknown;
  supported: number | null;
  contradicted: number | null;
  insufficient: number | null;
  mean_confidence: number | null;
  evidence_coverage: number | null;
  compute_provider: string | null;
  compute_latency_ms: number | null;
  commit_tx: string | null;
  reveal_tx: string | null;
  committed_at: Date | null;
  revealed_at: Date | null;
  artifact_body: unknown;
}

async function loadReportRows(ctx: TaskServiceContext, taskId: string): Promise<ReportRow[]> {
  return many<ReportRow>(
    ctx.db,
    `SELECT r.verifier, r.commitment, r.report_hash, r.report_pointer, r.status,
            r.model_id, r.pipeline_version, r.body, r.supported, r.contradicted,
            r.insufficient, r.mean_confidence, r.evidence_coverage,
            r.compute_provider, r.compute_latency_ms, r.commit_tx, r.reveal_tx,
            r.committed_at, r.revealed_at,
            a.body AS artifact_body
     FROM reports r
     LEFT JOIN artifacts a ON lower(a.object_hash) = lower(r.report_hash)
     WHERE r.task_id = $1
     ORDER BY lower(r.verifier)`,
    [taskId],
  );
}

async function loadReportBody(
  ctx: TaskServiceContext,
  taskId: string,
  row: ReportRow,
): Promise<VerifierReport | null> {
  const fields = { taskId, verifierId: row.verifier };
  const cached = row.body ?? row.artifact_body;
  if (cached) return verifiedBody(VerifierReport, cached, row.report_hash, ctx.logger, fields);

  const reference = row.report_pointer ?? row.report_hash;
  if (!reference) return null;
  try {
    const fetched = await ctx.storage.getJson(reference);
    return verifiedBody(VerifierReport, fetched, row.report_hash, ctx.logger, fields);
  } catch (error) {
    ctx.logger?.warn("verifier report could not be read from storage", {
      ...fields,
      errorCode: "STORAGE_UNAVAILABLE",
      pointer: reference,
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    });
    return null;
  }
}

/* ── claims ──────────────────────────────────────────────────────────────── */

type ClaimVerdictView = ClaimView["verdicts"][number];
type EvidenceSpan = ClaimVerdictView["sources"][number];

function evidenceSpans(sources: VerifierReport["claims"][number]["sources"]): EvidenceSpan[] {
  return sources.map((source) => ({
    uri: source.uri,
    snapshotObjectId: source.snapshotObjectId,
    contentHash: source.contentHash,
    quotedSpan: source.quotedSpan,
    score: source.score,
    retrievedAt: source.retrievedAt,
  }));
}

/**
 * Merges the manifest's claim list with every revealed report's verdict for that
 * claim and with the stored consensus row.
 *
 * The manifest fixes claim identity and order — a report may not rename or
 * reorder a claim — so the ordinals are the manifest's, and a claim nobody
 * reported on stays visible as PENDING instead of vanishing.
 */
export function buildClaims(args: {
  manifestClaims: readonly ManifestClaim[];
  reports: readonly { verifier: string; label: string; report: VerifierReport }[];
  consensus: ClaimConsensus[] | null;
  ruleId: string;
}): ClaimView[] {
  const rule = resolveRule(args.ruleId);
  const stored = new Map((args.consensus ?? []).map((claim) => [claim.claimId, claim]));
  const bodies = args.reports.map((entry) => entry.report);

  return args.manifestClaims.map((claim, index) => {
    const consensus =
      stored.get(claim.claimId) ??
      (bodies.length > 0
        ? evaluateClaim({
            claimId: claim.claimId,
            claimText: claim.claimText,
            reports: bodies,
            rule,
          })
        : null);

    const verdicts: ClaimVerdictView[] = [];
    for (const entry of args.reports) {
      const reported = entry.report.claims.find((item) => item.claimId === claim.claimId);
      if (!reported) continue;
      verdicts.push({
        verifier: entry.verifier,
        verifierLabel: entry.label,
        verdict: reported.verdict,
        confidence: reported.confidence,
        reasoningSummary: reported.reasoningSummary,
        sources: evidenceSpans(reported.sources),
      });
    }

    // The excerpt is the strongest span any verifier quoted for this claim, not
    // the first one filed: the evidence panel shows one quote and it should be
    // the one the verdict actually rests on.
    let best: EvidenceSpan | null = null;
    for (const verdict of verdicts) {
      for (const source of verdict.sources) {
        if (!best || source.score > best.score) best = source;
      }
    }

    return {
      claimId: claim.claimId,
      ordinal: String(index + 1).padStart(2, "0"),
      claimText: claim.claimText,
      majorityVerdict: consensus?.majorityVerdict ?? null,
      displayVerdict: displayVerdict(consensus),
      agreed: consensus?.agreed ?? false,
      criticalConflict: consensus?.criticalConflict ?? false,
      confidencePct: consensus ? claimConfidencePct(consensus) : null,
      evidenceCoverage: consensus?.evidenceCoverage ?? null,
      primarySourceLabel: best ? sourceLabel(best.uri) : null,
      excerpt: best?.quotedSpan ?? null,
      snapshotObjectId: best?.snapshotObjectId ?? null,
      retrievedAt: best?.retrievedAt ?? null,
      verdicts,
    };
  });
}

/** Claim identity when the manifest is unreadable: whatever the reports agree it is. */
function claimsFromReports(reports: readonly VerifierReport[]): ManifestClaim[] {
  const seen = new Map<string, ManifestClaim>();
  for (const report of reports) {
    for (const claim of report.claims) {
      if (seen.has(claim.claimId)) continue;
      seen.set(claim.claimId, {
        claimId: claim.claimId,
        claimText: claim.claimText,
        origin: "extraction",
      });
    }
  }
  return [...seen.values()];
}

/* ── timeline ────────────────────────────────────────────────────────────── */

interface EventRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: Date;
  event_name: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
}

const EVENT_LABELS: Record<string, string> = {
  TaskCreated: "Task created",
  TaskManifest: "Manifest anchored",
  ReportCommitted: "Report committed",
  ReportRevealed: "Report revealed",
  ChallengeOpened: "Challenge opened",
  ConsensusReached: "Consensus reached",
  TaskFinalized: "Task finalized",
  RewardAllocated: "Reward allocated",
  DisputeResolved: "Dispute resolved",
  VerifierRegistered: "Verifier registered",
  VerifierApprovalSet: "Verifier approval changed",
  RoleGranted: "Role granted",
};

function field(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** The one-line detail beside a timeline entry, built from the decoded log. */
function eventDetail(event: EventRow): string {
  const payload = event.payload;
  const actor = event.actor ? shortAddress(event.actor) : null;
  switch (event.event_name) {
    case "TaskCreated": {
      const bounty = field(payload, "bounty");
      return [bounty ? `${formatToken(bounty)} escrowed` : null, actor ? `by ${actor}` : null]
        .filter(Boolean)
        .join(" ");
    }
    case "TaskManifest":
      return field(payload, "manifestPointer") ?? "";
    case "ReportCommitted":
      return `${actor ?? "verifier"} committed ${shortHash(field(payload, "commitment"))}`;
    case "ReportRevealed":
      return `${actor ?? "verifier"} revealed ${shortHash(field(payload, "reportHash"))}`;
    case "ChallengeOpened":
      return `${actor ?? "challenger"} · evidence ${shortHash(field(payload, "evidenceHash"))}`;
    case "ConsensusReached": {
      const outcome = field(payload, "outcome");
      const rewardBps = field(payload, "rewardBps");
      return [
        outcome === null ? null : outcomeName(Number(outcome)),
        rewardBps === null ? null : `reward ${Number(rewardBps) / 100}%`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "TaskFinalized": {
      const outcome = field(payload, "outcome");
      return [
        outcome === null ? null : outcomeName(Number(outcome)),
        `result ${shortHash(field(payload, "resultHash"))}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "RewardAllocated": {
      const amount = field(payload, "amount");
      return `${amount ? formatToken(amount) : "reward"} to ${actor ?? "beneficiary"}`;
    }
    case "DisputeResolved":
      return field(payload, "upheld") === "true" ? "challenge upheld" : "challenge rejected";
    default:
      return actor ?? "";
  }
}

/* ── detail ──────────────────────────────────────────────────────────────── */

type ChainRead<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function tryChain<T>(fn: () => Promise<T>): Promise<ChainRead<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function loadTaskRow(db: Db, taskId: string): Promise<TaskRow | null> {
  return one<TaskRow>(db, `${TASK_SELECT} WHERE lower(t.task_id) = $1`, [normalizeTaskId(taskId)]);
}

async function verifierLabels(db: Db, addresses: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (addresses.length === 0) return labels;
  const rows = await many<{ address: string; label: string | null }>(
    db,
    "SELECT address, label FROM verifiers WHERE lower(address) = ANY($1::text[])",
    [addresses.map((address) => address.toLowerCase())],
  );
  for (const row of rows) {
    if (row.label) labels.set(row.address.toLowerCase(), row.label);
  }
  return labels;
}

export async function getTask(ctx: TaskServiceContext, handle: string): Promise<TaskDetail> {
  const taskId = await resolveTaskId(ctx.db, handle);
  const row = await loadTaskRow(ctx.db, taskId);
  if (!row) {
    throw new ProofRelayError("TASK_NOT_FOUND", `task ${taskId} is not in the read model`, {
      detail: { taskId, hint: `POST /v1/tasks/${taskId}/sync indexes it from the chain` },
    });
  }
  return buildDetail(ctx, row);
}

async function buildDetail(ctx: TaskServiceContext, row: TaskRow): Promise<TaskDetail> {
  const now = ctx.now?.() ?? new Date();
  const chainId = ctx.chain.chainId;
  const taskId = row.task_id;

  const [onchain, verifiersOnChain] = await Promise.all([
    tryChain(() => ctx.chain.getTask(taskId as Hex)),
    tryChain(() => ctx.chain.getTaskVerifiers(taskId as Hex)),
  ]);

  // A detail page must render during an RPC outage; when the fresh read is
  // missing the row's own contradictions are the best drift signal available.
  const syncRequired = onchain.ok ? chainDrift(row, onchain.value).length > 0 : indexDrift(row).length > 0;

  // Issued one at a time rather than fanned out: `ctx.db` may be a pooled client
  // inside a caller's transaction, and a single connection serialises concurrent
  // queries anyway (pg deprecates issuing them). These are indexed lookups on a
  // local database; the chain reads above are what this call actually waits on.
  const manifest = await loadManifest(ctx, row);
  const reportRows = await loadReportRows(ctx, taskId);
  const events = await many<EventRow>(
    ctx.db,
    `SELECT tx_hash, log_index, block_number, block_time, event_name, actor, payload
     FROM chain_events WHERE task_id = $1 ORDER BY block_number ASC, log_index ASC`,
    [taskId],
  );
  const consensusRow = await one<{
    outcome: string;
    agreement_bps: number;
    result_hash: string;
    result_pointer: string | null;
    conflicts: unknown;
    rewarded_verifiers: unknown;
    claims: unknown;
    evaluated_at: Date;
  }>(
    ctx.db,
    `SELECT outcome, agreement_bps, result_hash, result_pointer, conflicts,
            rewarded_verifiers, claims, evaluated_at
     FROM consensus_results WHERE task_id = $1`,
    [taskId],
  );
  const disputeRow = await one<{
    challenger: string;
    bond: string;
    evidence_hash: string;
    evidence_pointer: string;
    reason: string | null;
    resolved: boolean;
    upheld: boolean;
    decision: string | null;
    adjudication_hash: string | null;
    adjudication_pointer: string | null;
    opened_at: Date | null;
    deadline: Date | null;
    open_tx: string | null;
    resolve_tx: string | null;
  }>(
    ctx.db,
    `SELECT challenger, bond, evidence_hash, evidence_pointer, reason, resolved, upheld,
            decision, adjudication_hash, adjudication_pointer, opened_at, deadline,
            open_tx, resolve_tx
     FROM disputes WHERE task_id = $1`,
    [taskId],
  );
  const allocationRows = await many<{ beneficiary: string; amount: string }>(
    ctx.db,
    "SELECT beneficiary, amount FROM allocations WHERE task_id = $1 ORDER BY lower(beneficiary)",
    [taskId],
  );

  const blockByTx = new Map<string, number>();
  for (const event of events) blockByTx.set(event.tx_hash.toLowerCase(), Number(event.block_number));

  const addresses = new Set<string>();
  for (const report of reportRows) addresses.add(report.verifier.toLowerCase());
  if (verifiersOnChain.ok) for (const address of verifiersOnChain.value) addresses.add(address.toLowerCase());
  const labels = await verifierLabels(ctx.db, [...addresses]);

  const bodies = new Map<string, VerifierReport>();
  await Promise.all(
    reportRows
      .filter((report) => nonZeroHash(report.report_hash))
      .map(async (report) => {
        const body = await loadReportBody(ctx, taskId, report);
        if (body) bodies.set(report.verifier.toLowerCase(), body);
      }),
  );

  const reports = await buildReports(ctx, {
    taskId,
    chainId,
    addresses: [...addresses].sort(),
    rows: reportRows,
    bodies,
    labels,
    blockByTx,
    chainAvailable: onchain.ok,
  });

  const consensusClaims = consensusRow ? (asArray(consensusRow.claims) as ClaimConsensus[]) : null;
  const merged = [...bodies.entries()]
    .map(([verifier, report]) => ({
      verifier,
      label: labels.get(verifier) ?? report.verifier.verifierId ?? shortAddress(verifier),
      report,
    }))
    .sort((a, b) => (a.verifier < b.verifier ? -1 : 1));

  const manifestClaims = manifest?.claims ?? claimsFromReports(merged.map((entry) => entry.report));

  const summary = toSummary(row, chainId, syncRequired);

  return {
    ...summary,
    manifest: manifest ?? null,
    sources: (manifest?.sources ?? []).map((source) => ({
      sourceId: source.sourceId,
      uri: source.uri,
      status: source.status,
      contentHash: source.contentHash,
      byteLength: source.byteLength,
      snapshotPointer: source.snapshotPointer,
      snapshotHash: source.snapshotHash,
    })),
    claims: buildClaims({
      manifestClaims,
      reports: merged,
      consensus: consensusClaims,
      ruleId: row.rule_id,
    }),
    reports,
    consensus: consensusRow
      ? {
          outcome: consensusRow.outcome as ConsensusOutcome,
          agreementBps: Number(consensusRow.agreement_bps),
          conflicts: stringArray(consensusRow.conflicts),
          rewardedVerifiers: stringArray(consensusRow.rewarded_verifiers),
          resultHash: consensusRow.result_hash,
          resultPointer: consensusRow.result_pointer,
          evaluatedAt: isoOrNow(consensusRow.evaluated_at, now),
        }
      : null,
    dispute: disputeRow
      ? ({
          challenger: disputeRow.challenger,
          bondWei: disputeRow.bond,
          reason: disputeRow.reason,
          evidenceHash: disputeRow.evidence_hash,
          evidencePointer: disputeRow.evidence_pointer,
          openedAt: iso(disputeRow.opened_at),
          deadline: iso(disputeRow.deadline),
          resolved: disputeRow.resolved,
          upheld: disputeRow.upheld,
          decision: disputeRow.decision,
          adjudicationHash: nonZeroHash(disputeRow.adjudication_hash),
          adjudicationPointer: disputeRow.adjudication_pointer,
          tx: txRef(
            chainId,
            disputeRow.resolve_tx ?? disputeRow.open_tx,
            blockByTx.get((disputeRow.resolve_tx ?? disputeRow.open_tx ?? "").toLowerCase()) ?? null,
          ),
        } satisfies DisputeView)
      : null,
    allocations: allocationRows.map((allocation) => ({
      verifier: allocation.beneficiary,
      amountWei: allocation.amount,
    })),
    timeline: events.map((event) => ({
      at: event.block_time.toISOString(),
      label: EVENT_LABELS[event.event_name] ?? event.event_name,
      detail: eventDetail(event),
      tx: txRef(chainId, event.tx_hash, Number(event.block_number)),
    })),
  };
}

async function buildReports(
  ctx: TaskServiceContext,
  args: {
    taskId: string;
    chainId: number;
    addresses: string[];
    rows: ReportRow[];
    bodies: Map<string, VerifierReport>;
    labels: Map<string, string>;
    blockByTx: Map<string, number>;
    chainAvailable: boolean;
  },
): Promise<ReportView[]> {
  const rowByVerifier = new Map(args.rows.map((row) => [row.verifier.toLowerCase(), row]));

  const onchain = new Map<string, ReportOnChain>();
  if (args.chainAvailable) {
    await Promise.all(
      args.addresses.map(async (address) => {
        const read = await tryChain(() =>
          ctx.chain.getReport(args.taskId as Hex, address as Address),
        );
        if (read.ok) onchain.set(address, read.value);
      }),
    );
  }

  return args.addresses.map((address) => {
    const row = rowByVerifier.get(address);
    const chain = onchain.get(address);
    const body = args.bodies.get(address);

    const commitment = nonZeroHash(chain?.commitment ?? row?.commitment ?? null);
    const reportHash = nonZeroHash(chain?.reportHash ?? row?.report_hash ?? null);
    const reportPointer = (chain?.reportPointer || row?.report_pointer) ?? null;
    const revealed = chain ? chain.revealed : Boolean(row?.revealed_at);

    const committedAt = chain ? iso(chainTimeToDate(chain.committedAt)) : iso(row?.committed_at);
    const revealedAt = chain ? iso(chainTimeToDate(chain.revealedAt)) : iso(row?.revealed_at);

    const commitTx = row?.commit_tx ?? null;
    const revealTx = row?.reveal_tx ?? null;

    return {
      verifier: chain?.verifier ?? row?.verifier ?? address,
      verifierLabel:
        args.labels.get(address) ?? body?.verifier.verifierId ?? shortAddress(address),
      committed: commitment !== null,
      revealed,
      commitment,
      reportHash,
      reportPointer,
      modelId: row?.model_id ?? body?.verifier.modelId ?? null,
      pipelineVersion: row?.pipeline_version ?? body?.verifier.pipelineVersion ?? null,
      committedAt,
      revealedAt,
      supported: row?.supported ?? body?.summary.supported ?? null,
      contradicted: row?.contradicted ?? body?.summary.contradicted ?? null,
      insufficient: row?.insufficient ?? body?.summary.insufficient ?? null,
      meanConfidence: row?.mean_confidence ?? body?.summary.meanConfidence ?? null,
      computeProvider: row?.compute_provider ?? body?.compute[0]?.provider ?? null,
      // Read from the artifact only. There is no indexer column for either, and
      // inventing a default would be asserting something about where a
      // computation ran on the strength of nothing.
      teeVerified: body?.compute[0]?.verified ?? null,
      teeType: body?.compute[0]?.attestation?.teeType ?? null,
      computeLatencyMs: row?.compute_latency_ms ?? body?.compute[0]?.latencyMs ?? null,
      commitTx: txRef(args.chainId, commitTx, args.blockByTx.get((commitTx ?? "").toLowerCase()) ?? null),
      revealTx: txRef(args.chainId, revealTx, args.blockByTx.get((revealTx ?? "").toLowerCase()) ?? null),
    } satisfies ReportView;
  });
}

/* ── sync ────────────────────────────────────────────────────────────────── */

function isPool(db: Db): db is Pool {
  return typeof (db as { release?: unknown }).release !== "function";
}

/**
 * A transaction over either handle. A pooled client is already inside one when
 * a test wraps a case, so it nests a savepoint rather than opening a second
 * transaction the driver would reject.
 */
async function inTransaction<T>(db: Db, fn: (client: Db) => Promise<T>): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  await db.query("SAVEPOINT proofrelay_sync");
  try {
    const result = await fn(db);
    await db.query("RELEASE SAVEPOINT proofrelay_sync");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT proofrelay_sync").catch(() => undefined);
    throw error;
  }
}

/**
 * Re-reads every struct for a task and rewrites the row from them.
 *
 * This is the only write path in this file, and it exists because the read
 * model can be wrong: an event the indexer missed, a replay that stopped short,
 * a database restored from a backup. The chain is re-read rather than replayed
 * from logs so the result does not depend on the indexer being healthy.
 */
export async function syncTask(ctx: TaskServiceContext, handle: string): Promise<SyncResult> {
  const now = ctx.now?.() ?? new Date();
  const taskId = await resolveTaskId(ctx.db, handle);

  const onchain = await ctx.chain.getTask(taskId as Hex);
  if (onchain.status === TaskStatus.None || onchain.creator.toLowerCase() === ZERO_ADDRESS) {
    throw new ProofRelayError("TASK_NOT_FOUND", `the chain has no task ${taskId}`, {
      detail: { taskId, contract: ctx.chain.contract },
    });
  }

  const before = await loadTaskRow(ctx.db, taskId);
  const changed = before ? chainDrift(before, onchain) : ["inserted"];

  const verifiers = await ctx.chain
    .getTaskVerifiers(taskId as Hex)
    .catch(() => [] as readonly Address[]);
  const [reports, dispute, allocations] = await Promise.all([
    Promise.all(
      verifiers.map(async (verifier) => ({
        verifier,
        report: await ctx.chain.getReport(taskId as Hex, verifier),
      })),
    ),
    tryChain(() => ctx.chain.getDispute(taskId as Hex)),
    Promise.all(
      verifiers.map(async (verifier) => ({
        verifier,
        amount: await ctx.chain.allocationOf(taskId as Hex, verifier).catch(() => 0n),
      })),
    ),
  ]);

  await inTransaction(ctx.db, async (client) => {
    await writeTaskRow(client, taskId, onchain, now);
    for (const entry of reports) await writeReportRow(client, taskId, entry.verifier, entry.report);
    if (dispute.ok) await writeDisputeRow(client, taskId, dispute.value, onchain);
    for (const entry of allocations) {
      // Only ever written when positive: `allocationOf` drops to zero once a
      // verifier claims, and overwriting a recorded payout with 0 would erase
      // the settlement the UI is meant to be able to explain afterwards.
      if (entry.amount > 0n) {
        await client.query(
          `INSERT INTO allocations (task_id, beneficiary, amount)
           VALUES ($1, $2, $3)
           ON CONFLICT (task_id, beneficiary) DO UPDATE SET amount = EXCLUDED.amount`,
          [taskId, entry.verifier.toLowerCase(), entry.amount.toString()],
        );
      }
    }
  });

  const row = await loadTaskRow(ctx.db, taskId);
  if (!row) {
    throw new ProofRelayError("INTERNAL", `task ${taskId} disappeared during sync`, { detail: { taskId } });
  }
  const task = await buildDetail(ctx, row);

  ctx.logger?.info("task synced from chain", {
    taskId,
    changed: changed.join(","),
    status: statusName(onchain.status),
  });

  return {
    taskId,
    ref: task.ref,
    status: statusName(onchain.status),
    syncState: task.syncRequired ? "SYNC_REQUIRED" : "OK",
    changed,
    task,
  };
}

async function writeTaskRow(db: Db, taskId: string, onchain: TaskOnChain, now: Date): Promise<void> {
  const created = await one<{ block_number: number; block_time: Date; tx_hash: string }>(
    db,
    `SELECT block_number, block_time, tx_hash FROM chain_events
     WHERE task_id = $1 AND event_name = 'TaskCreated'
     ORDER BY block_number ASC, log_index ASC LIMIT 1`,
    [taskId],
  );

  await db.query(
    `INSERT INTO tasks (
       task_id, sequence, creator, status, outcome, bounty, verifier_count,
       committed_count, revealed_count, reward_bps, manifest_hash, manifest_pointer,
       rule_id, result_hash, commit_deadline, reveal_deadline, dispute_deadline,
       consensus_at, created_block, tx_hash, created_at, updated_at
     )
     VALUES (
       -- The same expression the indexer falls back to for a task it has no
       -- creation log for. Starting from 0 rather than 1 matters on an empty
       -- read model: a sync-first task would otherwise be PR-1001 and the same
       -- task PR-1000 after a replay, and the handle is what people paste.
       $1, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM tasks), $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
     )
     ON CONFLICT (task_id) DO UPDATE SET
       creator = EXCLUDED.creator,
       status = EXCLUDED.status,
       outcome = EXCLUDED.outcome,
       bounty = EXCLUDED.bounty,
       verifier_count = EXCLUDED.verifier_count,
       committed_count = EXCLUDED.committed_count,
       revealed_count = EXCLUDED.revealed_count,
       reward_bps = EXCLUDED.reward_bps,
       manifest_hash = EXCLUDED.manifest_hash,
       manifest_pointer = EXCLUDED.manifest_pointer,
       rule_id = EXCLUDED.rule_id,
       result_hash = EXCLUDED.result_hash,
       commit_deadline = EXCLUDED.commit_deadline,
       reveal_deadline = EXCLUDED.reveal_deadline,
       dispute_deadline = EXCLUDED.dispute_deadline,
       consensus_at = EXCLUDED.consensus_at,
       created_block = COALESCE(tasks.created_block, EXCLUDED.created_block),
       tx_hash = COALESCE(tasks.tx_hash, EXCLUDED.tx_hash),
       updated_at = EXCLUDED.updated_at`,
    [
      taskId,
      onchain.creator.toLowerCase(),
      onchain.status,
      onchain.outcome,
      onchain.bounty.toString(),
      onchain.verifierCount,
      onchain.committedCount,
      onchain.revealedCount,
      onchain.rewardBps,
      onchain.manifestHash,
      onchain.manifestPointer,
      onchain.ruleId,
      nonZeroHash(onchain.resultHash),
      chainTimeToDate(onchain.commitDeadline),
      chainTimeToDate(onchain.revealDeadline),
      disputeDeadlineFrom(onchain.consensusAt, onchain.disputeWindow),
      chainTimeToDate(onchain.consensusAt),
      created ? Number(created.block_number) : null,
      created?.tx_hash ?? null,
      // The struct has no creation time; the TaskCreated block is the real one,
      // and `now` only fills in for a task synced before its log was indexed.
      created?.block_time ?? now,
      now,
    ],
  );
}

async function writeReportRow(
  db: Db,
  taskId: string,
  verifier: Address,
  report: ReportOnChain,
): Promise<void> {
  if (!nonZeroHash(report.commitment)) return;
  await db.query(
    `INSERT INTO reports (
       task_id, verifier, commitment, report_hash, report_pointer, status,
       commit_tx, reveal_tx, committed_at, revealed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8)
     ON CONFLICT (task_id, verifier) DO UPDATE SET
       commitment = EXCLUDED.commitment,
       report_hash = COALESCE(EXCLUDED.report_hash, reports.report_hash),
       report_pointer = COALESCE(EXCLUDED.report_pointer, reports.report_pointer),
       status = EXCLUDED.status,
       committed_at = COALESCE(EXCLUDED.committed_at, reports.committed_at),
       revealed_at = COALESCE(EXCLUDED.revealed_at, reports.revealed_at)`,
    [
      taskId,
      verifier.toLowerCase(),
      report.commitment,
      nonZeroHash(report.reportHash),
      report.reportPointer || null,
      report.revealed ? "REVEALED" : "COMMITTED",
      chainTimeToDate(report.committedAt),
      chainTimeToDate(report.revealedAt),
    ],
  );
}

async function writeDisputeRow(
  db: Db,
  taskId: string,
  dispute: DisputeOnChain,
  onchain: TaskOnChain,
): Promise<void> {
  if (dispute.challenger.toLowerCase() === ZERO_ADDRESS) return;
  await db.query(
    `INSERT INTO disputes (
       task_id, challenger, bond, evidence_hash, evidence_pointer, resolved, upheld,
       adjudication_hash, adjudication_pointer, opened_at, deadline
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id) DO UPDATE SET
       challenger = EXCLUDED.challenger,
       bond = EXCLUDED.bond,
       evidence_hash = EXCLUDED.evidence_hash,
       evidence_pointer = EXCLUDED.evidence_pointer,
       resolved = EXCLUDED.resolved,
       upheld = EXCLUDED.upheld,
       adjudication_hash = COALESCE(EXCLUDED.adjudication_hash, disputes.adjudication_hash),
       adjudication_pointer = COALESCE(EXCLUDED.adjudication_pointer, disputes.adjudication_pointer),
       opened_at = COALESCE(EXCLUDED.opened_at, disputes.opened_at),
       deadline = EXCLUDED.deadline`,
    [
      taskId,
      dispute.challenger.toLowerCase(),
      dispute.bond.toString(),
      dispute.evidenceHash,
      dispute.evidencePointer,
      dispute.resolved,
      dispute.upheld,
      nonZeroHash(dispute.adjudicationHash),
      dispute.adjudicationPointer || null,
      chainTimeToDate(dispute.openedAt),
      chainTimeToDate(dispute.deadline) ??
        disputeDeadlineFrom(onchain.consensusAt, onchain.disputeWindow),
    ],
  );
}

/* ── stats ───────────────────────────────────────────────────────────────── */

/** Relative change, or null when there is nothing to compare against. */
export function trendPct(current: number, prior: number | null): number | null {
  if (prior === null || prior === 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

/** The same comparison in wei, where a double would silently lose the low bits. */
export function trendPctWei(current: bigint, prior: bigint): number | null {
  if (prior === 0n) return null;
  return Number(((current - prior) * 1000n) / prior) / 10;
}

function ratioPct(covered: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((covered / total) * 1000) / 10;
}

export async function workspaceStats(ctx: TaskServiceContext): Promise<WorkspaceStats> {
  const now = ctx.now?.() ?? new Date();
  const currentFrom = new Date(now.getTime() - TREND_WINDOW_MS);
  const priorFrom = new Date(now.getTime() - 2 * TREND_WINDOW_MS);

  // Sequential for the same reason `buildDetail` is: a pooled client serialises
  // concurrent queries anyway, and these are four aggregate scans rather than a
  // fan-out worth paying for.
  const tasks = await one<{
    total: number;
    active: number;
    open_queue: number;
    in_review: number;
    disputed: number;
    conflict: number;
    no_quorum: number;
    verified: number;
    overdue: number;
    created_current: number;
    created_prior: number;
  }>(
    ctx.db,
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE t.status <> ALL($1::int[]))::int AS active,
       count(*) FILTER (WHERE t.status IN (1, 2))::int AS open_queue,
       count(*) FILTER (WHERE t.status IN (3, 4))::int AS in_review,
       count(*) FILTER (WHERE (${DISPLAY_STATUS_SQL}) = 'DISPUTED')::int AS disputed,
       count(*) FILTER (WHERE (${DISPLAY_STATUS_SQL}) = 'CONFLICT')::int AS conflict,
       count(*) FILTER (WHERE (${DISPLAY_STATUS_SQL}) = 'NO QUORUM')::int AS no_quorum,
       count(*) FILTER (WHERE (${DISPLAY_STATUS_SQL}) = 'VERIFIED')::int AS verified,
       count(*) FILTER (
         WHERE t.status <> ALL($1::int[])
           AND COALESCE(t.dispute_deadline, t.reveal_deadline, t.commit_deadline) < $2::timestamptz
       )::int AS overdue,
       count(*) FILTER (WHERE t.created_at >= $3::timestamptz)::int AS created_current,
       count(*) FILTER (
         WHERE t.created_at >= $4::timestamptz AND t.created_at < $3::timestamptz
       )::int AS created_prior
     FROM tasks t`,
    [TERMINAL, now, currentFrom, priorFrom],
  );

  const bounties = await one<{
    settled: string;
    escrowed: string;
    settled_current: string;
    settled_prior: string;
  }>(
    ctx.db,
    `SELECT
       COALESCE((SELECT SUM(amount) FROM allocations), 0)::text AS settled,
       COALESCE((SELECT SUM(bounty) FROM tasks WHERE status <> ALL($1::int[])), 0)::text AS escrowed,
       COALESCE((SELECT SUM(amount) FROM allocations
                 WHERE created_at >= $2::timestamptz), 0)::text AS settled_current,
       COALESCE((SELECT SUM(amount) FROM allocations
                 WHERE created_at >= $3::timestamptz AND created_at < $2::timestamptz), 0)::text AS settled_prior`,
    [TERMINAL, currentFrom, priorFrom],
  );

  // "Share of claims across settled tasks that carry at least one source
  // pointer" — a claim whose agreeing verifiers cited nothing is uncovered.
  const coverage = await one<{
    total: number;
    covered: number;
    total_current: number;
    covered_current: number;
    total_prior: number;
    covered_prior: number;
  }>(
    ctx.db,
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE s.covered)::int AS covered,
       count(*) FILTER (WHERE s.evaluated_at >= $2::timestamptz)::int AS total_current,
       count(*) FILTER (WHERE s.covered AND s.evaluated_at >= $2::timestamptz)::int AS covered_current,
       count(*) FILTER (
         WHERE s.evaluated_at >= $3::timestamptz AND s.evaluated_at < $2::timestamptz
       )::int AS total_prior,
       count(*) FILTER (
         WHERE s.covered AND s.evaluated_at >= $3::timestamptz AND s.evaluated_at < $2::timestamptz
       )::int AS covered_prior
     FROM (
       SELECT c.evaluated_at,
              COALESCE((e ->> 'evidenceCoverage')::float8, 0) > 0 AS covered
       FROM tasks t
       JOIN consensus_results c ON c.task_id = t.task_id
       -- Guarded inside the call, not in the WHERE below: a set-returning
       -- function in the FROM clause runs before the qual that would have
       -- excluded its row, so a non-array claims column would raise 22023 here.
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(c.claims) = 'array' THEN c.claims ELSE '[]'::jsonb END
       ) AS e
       WHERE t.status = $1
     ) s`,
    [SETTLED, currentFrom, priorFrom],
  );

  const timing = await one<{ n: number; median: string | null }>(
    ctx.db,
    `SELECT
       count(*)::int AS n,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (t.consensus_at - t.created_at))::float8
       )::text AS median
     FROM tasks t
     WHERE t.status = $1 AND t.consensus_at IS NOT NULL AND t.consensus_at > t.created_at`,
    [SETTLED],
  );

  const coverageSample = Number(coverage?.total ?? 0);
  const medianSample = Number(timing?.n ?? 0);
  const coverageCurrent = ratioPct(
    Number(coverage?.covered_current ?? 0),
    Number(coverage?.total_current ?? 0),
  );

  return {
    activeTasks: Number(tasks?.active ?? 0),
    // What a person has to look at: a task in dispute, or one whose deadline has
    // passed without the transition it was waiting for.
    tasksNeedingReview: Number(tasks?.disputed ?? 0) + Number(tasks?.overdue ?? 0),
    openQueue: Number(tasks?.open_queue ?? 0),
    inReview: Number(tasks?.in_review ?? 0),
    disputed: Number(tasks?.disputed ?? 0),
    conflict: Number(tasks?.conflict ?? 0),
    noQuorum: Number(tasks?.no_quorum ?? 0),
    verifiedTasks: Number(tasks?.verified ?? 0),
    totalTasks: Number(tasks?.total ?? 0),
    evidenceCoveragePct: ratioPct(Number(coverage?.covered ?? 0), coverageSample),
    evidenceCoverageSampleSize: coverageSample,
    bountiesSettledWei: bounties?.settled ?? "0",
    bountiesEscrowedWei: bounties?.escrowed ?? "0",
    medianVerificationSec:
      medianSample > 0 && timing?.median != null ? Math.round(Number(timing.median)) : null,
    medianVerificationSampleSize: medianSample,
    activeTasksTrendPct: trendPct(
      Number(tasks?.created_current ?? 0),
      Number(tasks?.created_prior ?? 0),
    ),
    // An empty current window is "not measured", not "zero coverage" — reporting
    // -100% because nothing settled this week would be a fabricated collapse.
    evidenceCoverageTrendPct:
      coverageCurrent === null
        ? null
        : trendPct(
            coverageCurrent,
            ratioPct(Number(coverage?.covered_prior ?? 0), Number(coverage?.total_prior ?? 0)),
          ),
    bountiesSettledTrendPct: trendPctWei(
      BigInt(bounties?.settled_current ?? "0"),
      BigInt(bounties?.settled_prior ?? "0"),
    ),
  };
}

/* ── facade ──────────────────────────────────────────────────────────────── */

/** The four entry points a route file needs, bound to one context. */
export function createTaskService(ctx: TaskServiceContext) {
  return {
    listTasks: (query: TaskListQueryInput = {}) => listTasks(ctx, query),
    getTask: (handle: string) => getTask(ctx, handle),
    syncTask: (handle: string) => syncTask(ctx, handle),
    workspaceStats: () => workspaceStats(ctx),
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
