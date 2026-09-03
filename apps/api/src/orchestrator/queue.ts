/**
 * The job queue, in Postgres.
 *
 * Architecture doc §9.2: every job carries `attempts`, `nextRetryAt`,
 * `lastErrorCode` and an `idempotencyKey`. The key is a unique index, which is
 * what makes `enqueue` safe to call from an event projector that may replay the
 * same log — enqueuing the same work twice is a no-op rather than a second
 * consensus evaluation.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, but the row lock only lasts as long
 * as the claiming transaction and a job's actual work happens outside it (0G
 * Storage, 0G Compute, the chain). So the claim is also *recorded* on the row
 * as `locked_by` / `locked_at`, and `reapStaleLeases` returns jobs whose worker
 * died. Without the recorded lease, a killed worker's jobs would sit in RUNNING
 * forever and the only symptom would be a queue that quietly stops draining.
 *
 * Backoff is deterministic rather than jittered. Jitter exists to break up
 * synchronised retries against a shared dependency, and `SKIP LOCKED` already
 * does that here; a deterministic `next_retry_at` is worth more, because an
 * operator reading the row can tell exactly when it will run again.
 */
import {
  JOB_STATUSES,
  ProofRelayError,
  type JobStatus,
  type JobType,
} from "@proofrelay/schemas";
import { many, one, type Pool, type PoolClient } from "../db.js";
import { metrics } from "../observability.js";

export type Db = Pool | PoolClient;

/** Architecture doc §11: three attempts, then the job stops on its own. */
// 3 attempts on a 2 s base is a ~6 s retry budget, which is shorter than a
// routine RPC hiccup on a public testnet — and a FINALIZATION job that exhausts
// it is gone for good, because `idempotency_key` stops the same job ever being
// enqueued again. 8 attempts on the same backoff spans roughly eight minutes.
export const MAX_ATTEMPTS = 8;
export const BASE_RETRY_MS = 2_000;
export const MAX_RETRY_MS = 5 * 60_000;
/** How long a claim is honoured before the reaper assumes the worker is gone. */
export const LEASE_MS = 5 * 60_000;

export interface Job {
  id: number;
  idempotencyKey: string;
  taskId: string | null;
  jobType: JobType;
  status: JobStatus;
  attempts: number;
  lastErrorCode: string | null;
  lastError: string | null;
  nextRetryAt: Date | null;
  payload: Record<string, unknown>;
  lockedBy: string | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface JobRow {
  id: number;
  idempotency_key: string;
  task_id: string | null;
  job_type: string;
  status: string;
  attempts: number;
  last_error_code: string | null;
  last_error: string | null;
  next_retry_at: Date | null;
  payload: Record<string, unknown>;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, idempotency_key, task_id, job_type, status, attempts, last_error_code,
                 last_error, next_retry_at, payload, locked_by, locked_at, created_at, updated_at`;

function toJob(row: JobRow): Job {
  return {
    id: Number(row.id),
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    jobType: row.job_type as JobType,
    status: row.status as JobStatus,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    nextRetryAt: row.next_retry_at,
    payload: row.payload ?? {},
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The default idempotency key. One job of a type per task — a second
 * `CONSENSUS_EVALUATION` for the same task is the same work, not more work.
 * A discriminator is for the job types that legitimately repeat, such as one
 * `VERIFIER_DISPATCH` per verifier.
 */
export function jobKey(jobType: JobType, taskId: string | null, discriminator?: string): string {
  const parts = [jobType, (taskId ?? "global").toLowerCase()];
  if (discriminator) parts.push(discriminator.toLowerCase());
  return parts.join(":");
}

export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** exponent);
}

export interface EnqueueInput {
  jobType: JobType;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Delay before the first attempt; a job scheduled for a future deadline. */
  runInMs?: number;
}

export async function enqueue(
  db: Db,
  input: EnqueueInput,
  now = new Date(),
): Promise<{ job: Job; created: boolean }> {
  const key = input.idempotencyKey ?? jobKey(input.jobType, input.taskId ?? null);
  const runAt = new Date(now.getTime() + (input.runInMs ?? 0));

  const inserted = await one<JobRow>(
    db,
    `INSERT INTO jobs (idempotency_key, task_id, job_type, status, payload, next_retry_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'PENDING', $4::jsonb, $5, $6, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [key, input.taskId ?? null, input.jobType, JSON.stringify(input.payload ?? {}), runAt, now],
  );
  if (inserted) return { job: toJob(inserted), created: true };

  const existing = await one<JobRow>(db, `SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`, [
    key,
  ]);
  if (!existing) {
    throw new ProofRelayError("INTERNAL", "job vanished between insert and read", {
      detail: { idempotencyKey: key },
    });
  }
  return { job: toJob(existing), created: false };
}

export interface ClaimOptions {
  workerId: string;
  limit?: number;
  jobTypes?: readonly JobType[];
}

/**
 * Take up to `limit` due jobs and mark them RUNNING.
 *
 * `SKIP LOCKED` is what lets several orchestrators share one queue: a row
 * another worker is claiming right now is passed over rather than waited on.
 */
export async function claim(db: Db, options: ClaimOptions, now = new Date()): Promise<Job[]> {
  const rows = await many<JobRow>(
    db,
    `WITH due AS (
        SELECT id FROM jobs
         WHERE status IN ('PENDING', 'FAILED_RETRYABLE')
           AND (next_retry_at IS NULL OR next_retry_at <= $1)
           AND ($3::text[] IS NULL OR job_type = ANY($3::text[]))
         ORDER BY next_retry_at NULLS FIRST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
      )
      UPDATE jobs
         SET status = 'RUNNING', locked_by = $4, locked_at = $1, updated_at = $1
        FROM due
       WHERE jobs.id = due.id
      RETURNING jobs.*`,
    [now, options.limit ?? 1, options.jobTypes ? [...options.jobTypes] : null, options.workerId],
  );
  return rows.map(toJob);
}

/**
 * `workerId` fences the lease. Without it a worker whose lease the reaper had
 * already reclaimed could come back and mark DONE a job another worker was part
 * way through — or overwrite its result — because the only condition was the job
 * id. Passing the id the worker claimed under makes a stale writer update zero
 * rows; the `Job | null` return already models that.
 */
export async function complete(
  db: Db,
  jobId: number,
  now = new Date(),
  workerId?: string,
): Promise<Job | null> {
  const row = await one<JobRow>(
    db,
    `UPDATE jobs
        SET status = 'DONE', next_retry_at = NULL, locked_by = NULL, locked_at = NULL,
            last_error_code = NULL, last_error = NULL, updated_at = $2
      WHERE id = $1 AND ($3::text IS NULL OR locked_by = $3)
      RETURNING ${COLUMNS}`,
    [jobId, now, workerId ?? null],
  );
  return row ? toJob(row) : null;
}

export interface FailOptions {
  maxAttempts?: number;
}

/**
 * Record a failed attempt.
 *
 * A retryable error backs off and comes round again until `maxAttempts`; a
 * non-retryable one (a hash mismatch, a missing handler, a revert) stops
 * immediately, because attempting it twice more only delays the operator
 * finding out. Either way the job's task is untouched — a job dying never
 * advances a task's state.
 */
export async function fail(
  db: Db,
  jobId: number,
  error: unknown,
  options: FailOptions = {},
  now = new Date(),
): Promise<Job | null> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const proofRelay = error instanceof ProofRelayError ? error : null;
  const code = proofRelay?.code ?? "INTERNAL";
  const retryable = proofRelay ? proofRelay.retryable : true;
  const message = String((error as Error)?.message ?? error).slice(0, 500);

  const row = await one<JobRow>(
    db,
    `UPDATE jobs
        SET attempts = attempts + 1,
            status = CASE WHEN $3::boolean AND attempts + 1 < $4::int THEN 'FAILED_RETRYABLE' ELSE 'FAILED_FINAL' END,
            next_retry_at = CASE
              WHEN $3::boolean AND attempts + 1 < $4::int
              THEN $5::timestamptz + make_interval(secs => least($6::double precision,
                                                                $7::double precision * power(2, attempts)))
              ELSE NULL END,
            last_error_code = $2,
            last_error = $8,
            locked_by = NULL,
            locked_at = NULL,
            updated_at = $5
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      jobId,
      code,
      retryable,
      maxAttempts,
      now,
      MAX_RETRY_MS / 1_000,
      BASE_RETRY_MS / 1_000,
      message,
    ],
  );
  if (!row) return null;

  const job = toJob(row);
  metrics.jobRetry.inc({ job_type: job.jobType, error_code: code });
  return job;
}

/**
 * Jobs whose worker died holding the lease. Returned to the retry path rather
 * than to PENDING, so the attempt still counts — a job that reliably kills its
 * worker must not loop forever.
 */
export async function reapStaleLeases(
  db: Db,
  leaseMs = LEASE_MS,
  now = new Date(),
): Promise<Job[]> {
  const rows = await many<JobRow>(
    db,
    `UPDATE jobs
        SET status = CASE WHEN attempts + 1 < $3::int THEN 'FAILED_RETRYABLE' ELSE 'FAILED_FINAL' END,
            attempts = attempts + 1,
            next_retry_at = CASE WHEN attempts + 1 < $3::int THEN $1::timestamptz ELSE NULL END,
            last_error_code = 'INTERNAL',
            last_error = 'lease expired; the worker holding this job did not report back',
            locked_by = NULL,
            locked_at = NULL,
            updated_at = $1
      WHERE status = 'RUNNING' AND locked_at IS NOT NULL AND locked_at < $2
      RETURNING ${COLUMNS}`,
    [now, new Date(now.getTime() - leaseMs), MAX_ATTEMPTS],
  );
  return rows.map(toJob);
}

export async function getJob(db: Db, jobId: number): Promise<Job | null> {
  const row = await one<JobRow>(db, `SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [jobId]);
  return row ? toJob(row) : null;
}

export async function findJob(db: Db, idempotencyKey: string): Promise<Job | null> {
  const row = await one<JobRow>(db, `SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`, [
    idempotencyKey,
  ]);
  return row ? toJob(row) : null;
}

export type QueueCounts = Record<JobStatus, number>;

/** `/health`'s queue block, and the "Queue backlog" alert's input. */
export async function countsByStatus(db: Db): Promise<QueueCounts> {
  const rows = await many<{ status: string; count: string }>(
    db,
    "SELECT status, count(*)::text AS count FROM jobs GROUP BY status",
  );
  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as QueueCounts;
  for (const row of rows) {
    if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as JobStatus] = Number(row.count);
    }
  }
  return counts;
}

export interface QueueDepth {
  jobType: string;
  status: JobStatus;
  count: number;
}

export async function depthByType(db: Db): Promise<QueueDepth[]> {
  const rows = await many<{ job_type: string; status: string; count: string }>(
    db,
    "SELECT job_type, status, count(*)::text AS count FROM jobs GROUP BY job_type, status ORDER BY job_type, status",
  );
  return rows.map((row) => ({
    jobType: row.job_type,
    status: row.status as JobStatus,
    count: Number(row.count),
  }));
}
