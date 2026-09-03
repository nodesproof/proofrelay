/**
 * The `PR-1048` handle.
 *
 * Nothing onchain carries a short id — `taskRef()` derives one from the
 * indexer's creation sequence, which means the handle only means anything next
 * to the row it came from. Both directions therefore live here, against the
 * tasks table, rather than being recomputed wherever a ref is rendered: a ref
 * resolved from a stale in-memory guess would point at somebody else's task.
 */
import { ProofRelayError, taskRef } from "@proofrelay/schemas";
import { many, one, type Pool, type PoolClient } from "../db.js";

export type Db = Pool | PoolClient;

const REF_PATTERN = /^PR-(\d{1,15})$/i;
/** The prefix is matched case-insensitively: an id pasted from an explorer
 * can arrive as `0X…`, and `normalizeTaskId` lowercases it either way. */
const TASK_ID_PATTERN = /^0[xX][0-9a-fA-F]{64}$/;

/** `taskRef` in reverse; the offset is shared with it and not repeated here. */
const REF_BASE = Number(taskRef(0).slice(3));

/** `PR-1048` for creation index 48. Thin wrapper so callers import one module. */
export function refForSequence(sequence: number): string {
  return taskRef(sequence);
}

/** The creation index a handle names, or null when the string is not a handle. */
export function sequenceForRef(ref: string): number | null {
  const match = REF_PATTERN.exec(ref.trim());
  if (!match?.[1]) return null;
  const sequence = Number(match[1]) - REF_BASE;
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

export function isTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value.trim());
}

/** Lowercased `0x…` form. Task ids are compared as text, so casing must not vary. */
export function normalizeTaskId(value: string): string {
  return value.trim().toLowerCase();
}

export async function refForTaskId(db: Db, taskId: string): Promise<string | null> {
  const row = await one<{ sequence: number }>(
    db,
    "SELECT sequence FROM tasks WHERE lower(task_id) = $1",
    [normalizeTaskId(taskId)],
  );
  return row ? refForSequence(Number(row.sequence)) : null;
}

export async function taskIdForRef(db: Db, ref: string): Promise<string | null> {
  const sequence = sequenceForRef(ref);
  if (sequence === null) return null;
  const row = await one<{ task_id: string }>(
    db,
    "SELECT task_id FROM tasks WHERE sequence = $1",
    [sequence],
  );
  return row?.task_id ?? null;
}

/** One query for a whole page of rows, so a task list never issues N lookups. */
export async function refsForTaskIds(db: Db, taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (taskIds.length === 0) return out;
  const rows = await many<{ task_id: string; sequence: number }>(
    db,
    "SELECT task_id, sequence FROM tasks WHERE lower(task_id) = ANY($1::text[])",
    [taskIds.map(normalizeTaskId)],
  );
  for (const row of rows) out.set(normalizeTaskId(row.task_id), refForSequence(Number(row.sequence)));
  return out;
}

/**
 * Accepts either form the UI can hold — a full task id from the chain or a
 * `PR-…` handle from the table — and returns the task id. A handle that names
 * no row is a 404 rather than a lookup that quietly returns nothing, because
 * the caller is about to render a page for it.
 */
export async function resolveTaskId(db: Db, handle: string): Promise<string> {
  const trimmed = handle.trim();
  if (isTaskId(trimmed)) return normalizeTaskId(trimmed);

  const taskId = await taskIdForRef(db, trimmed);
  if (taskId) return normalizeTaskId(taskId);

  throw new ProofRelayError("TASK_NOT_FOUND", `no task matches ${trimmed}`, {
    detail: { handle: trimmed },
  });
}
