/**
 * The job runner.
 *
 * It owns two of the eight job types in `JOB_TYPES` — `CONSENSUS_EVALUATION`
 * and `NOTIFICATION` — and hosts the rest, which the indexer, the keeper and
 * the verifier workers register. A type nobody registered fails as
 * NOT_CONFIGURED rather than sitting PENDING forever: a job that never runs and
 * never complains is the failure mode an operator finds out about from a user.
 *
 * The invariant that matters more than anything else here is negative:
 *
 *     a failed job never advances a task.
 *
 * `CONSENSUS_EVALUATION` reads reports out of 0G Storage, re-hashes each one,
 * evaluates the rule, uploads the result and enqueues `FINALIZATION`. If
 * storage is down, if a body does not rehash to what the chain recorded, if the
 * manifest cannot be verified — the job fails and the task stays exactly where
 * it was. Nothing in this file writes `tasks.status`. A task becomes verified
 * because the chain said so and the indexer observed it, never because a
 * background job decided compute had gone quiet.
 */
import {
  JOB_TYPES,
  ProofRelayError,
  TaskManifest,
  TaskStatus,
  VerifierReport,
  hashesEqual,
  objectHash,
  type ConsensusResult,
  type JobType,
} from "@proofrelay/schemas";
import { evaluateConsensus, type ManifestClaimRef } from "@proofrelay/consensus";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { Config } from "@proofrelay/config";
import { many, one, type Pool } from "../db.js";
import { metrics, type Logger } from "../observability.js";
import * as queue from "./queue.js";
import type { Job } from "./queue.js";

export interface JobContext {
  job: Job;
  pool: Pool;
  logger: Logger;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface OrchestratorDeps {
  pool: Pool;
  config: Config;
  storage: StorageAdapter;
  logger: Logger;
  /** Injected so a test can run the loop without waiting on a real clock. */
  now?: () => Date;
  workerId?: string;
  handlers?: Partial<Record<JobType, JobHandler>>;
}

export interface TickResult {
  claimed: number;
  done: number;
  failed: number;
  reaped: number;
}

export class Orchestrator {
  readonly workerId: string;
  private readonly deps: OrchestratorDeps;
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.workerId = deps.workerId ?? `${process.pid}@${hostLabel()}`;

    this.register("CONSENSUS_EVALUATION", (context) => runConsensusEvaluation(deps, context));
    this.register("NOTIFICATION", (context) => runNotification(deps, context));
    for (const [type, handler] of Object.entries(deps.handlers ?? {})) {
      if (handler) this.register(type as JobType, handler);
    }
  }

  register(jobType: JobType, handler: JobHandler): void {
    if (!(JOB_TYPES as readonly string[]).includes(jobType)) {
      throw new Error(`unknown job type ${jobType}`);
    }
    this.handlers.set(jobType, handler);
  }

  handles(): JobType[] {
    return [...this.handlers.keys()];
  }

  /** One pass: reap dead leases, claim what is due, run it. */
  /**
   * Tasks whose reveal window has closed with at least one reveal, but which
   * were never evaluated.
   *
   * The reveal projector queues an evaluation when the last verifier reveals.
   * A verifier that never reveals means that never happens, and the task would
   * otherwise reach `expireTask` — which pays the conflict rate to whoever did
   * reveal, without the rule ever being applied. Evaluating it first lets the
   * keeper settle it as what it actually is: consensus among those who
   * answered, a conflict, or no quorum at all.
   */
  async sweepUnevaluated(limit = 8): Promise<number> {
    const { rows } = await this.deps.pool.query<{ task_id: string }>(
      `SELECT t.task_id
         FROM tasks t
        WHERE t.status = $1
          AND t.reveal_deadline IS NOT NULL
          AND t.reveal_deadline < $2
          AND t.revealed_count > 0
          AND NOT EXISTS (SELECT 1 FROM consensus_results c WHERE c.task_id = t.task_id)
          AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.idempotency_key = 'consensus:' || t.task_id
              )
        ORDER BY t.reveal_deadline
        LIMIT $3`,
      [TaskStatus.Revealing, this.now(), limit],
    );

    let queued = 0;
    for (const row of rows) {
      const { created } = await queue.enqueue(this.deps.pool, {
        jobType: "CONSENSUS_EVALUATION",
        taskId: row.task_id,
        payload: { taskId: row.task_id, reason: "reveal-window-closed" },
        idempotencyKey: `consensus:${row.task_id}`,
      });
      if (created) {
        queued += 1;
        this.deps.logger.info("queued consensus evaluation after the reveal window closed", {
          taskId: row.task_id,
          component: "orchestrator",
        });
      }
    }
    return queued;
  }

  /**
   * What this orchestrator will take off the queue: its own handler types, plus
   * any lifecycle job type nobody registered — so an orphan is still failed
   * rather than sitting PENDING forever.
   *
   * The list is `JOB_TYPES`, which deliberately does not include
   * `ARTIFACT_SYNC`. That queue is drained by ArtifactSync's own loop over the
   * same table, and an unfiltered claim steals its work and then marks it
   * FAILED_FINAL with "no handler is registered" — permanently killing a job
   * that had a perfectly good consumer.
   */
  claimableTypes(): JobType[] {
    const mine = new Set<JobType>(this.handlers.keys());
    return [...mine, ...JOB_TYPES.filter((type) => !mine.has(type))];
  }

  async runOnce(limit = 4): Promise<TickResult> {
    const now = this.now();
    await this.sweepUnevaluated().catch((error) => {
      this.deps.logger.warn("consensus sweep failed", {
        component: "orchestrator",
        error: String((error as Error).message).slice(0, 200),
      });
    });
    const reaped = await queue.reapStaleLeases(this.deps.pool, queue.LEASE_MS, now);
    for (const job of reaped) {
      this.deps.logger.warn("job lease expired", {
        taskId: job.taskId,
        jobId: job.id,
        jobType: job.jobType,
        errorCode: job.lastErrorCode,
      });
    }

    const claimed = await queue.claim(
      this.deps.pool,
      { workerId: this.workerId, limit, jobTypes: this.claimableTypes() },
      this.now(),
    );

    let done = 0;
    let failed = 0;
    for (const job of claimed) {
      if ((await this.runJob(job)) === "done") done += 1;
      else failed += 1;
    }
    return { claimed: claimed.length, done, failed, reaped: reaped.length };
  }

  private async runJob(job: Job): Promise<"done" | "failed"> {
    const logger = this.deps.logger.child({
      taskId: job.taskId,
      jobId: job.id,
      jobType: job.jobType,
    });
    const handler = this.handlers.get(job.jobType);
    const started = Date.now();

    try {
      if (!handler) {
        throw new ProofRelayError(
          "NOT_CONFIGURED",
          `no handler is registered for ${job.jobType}`,
          { retryable: false, detail: { jobType: job.jobType } },
        );
      }
      await handler({ job, pool: this.deps.pool, logger });
      await queue.complete(this.deps.pool, job.id, this.now(), this.deps.workerId);
      logger.info("job done", { durationMs: Date.now() - started });
      return "done";
    } catch (error) {
      const outcome = await queue.fail(this.deps.pool, job.id, error, {}, this.now());
      const code = outcome?.lastErrorCode ?? "INTERNAL";
      logger.error("job failed", {
        errorCode: code,
        attempts: outcome?.attempts ?? job.attempts + 1,
        status: outcome?.status ?? "FAILED_FINAL",
        nextRetryAt: outcome?.nextRetryAt?.toISOString() ?? null,
        durationMs: Date.now() - started,
        detail: String((error as Error)?.message ?? error).slice(0, 300),
      });
      return "failed";
    }
  }

  start(pollMs = this.deps.config.orchestrator.pollMs): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch (error) {
        // A queue-level failure (Postgres down) must not kill the loop; the
        // API keeps serving reads and the next tick retries.
        this.deps.logger.error("orchestrator tick failed", {
          errorCode: "INTERNAL",
          detail: String((error as Error)?.message ?? error).slice(0, 300),
        });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight job finish rather than abandoning its lease.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  health(): Promise<queue.QueueCounts> {
    return queue.countsByStatus(this.deps.pool);
  }
}

function hostLabel(): string {
  return process.env.HOSTNAME ?? "api";
}

/* ── CONSENSUS_EVALUATION ────────────────────────────────────────────────── */

interface TaskRow {
  task_id: string;
  status: number;
  rule_id: string;
  manifest_hash: string;
  manifest_pointer: string;
  verifier_count: number;
  /** The chain's count, written by refreshTaskFromChain — not a row count. */
  revealed_count: number;
}

interface ReportRow {
  verifier: string;
  report_hash: string | null;
  report_pointer: string | null;
  revealed_at: Date | null;
}

export interface ConsensusEvaluation {
  taskId: string;
  result: ConsensusResult;
  resultHash: `0x${string}`;
  resultPointer: string;
  reportCount: number;
}

/**
 * Fetch every revealed report, verify each body against the hash the chain
 * recorded, evaluate, upload, store, and hand the task to the keeper.
 */
export async function runConsensusEvaluation(
  deps: OrchestratorDeps,
  context: JobContext,
): Promise<void> {
  const taskId = requireTaskId(context.job);
  const evaluation = await evaluateTask(deps, taskId, context);

  await queue.enqueue(
    deps.pool,
    {
      jobType: "FINALIZATION",
      taskId,
      payload: {
        taskId,
        resultHash: evaluation.resultHash,
        resultPointer: evaluation.resultPointer,
        outcome: evaluation.result.outcome,
      },
    },
    deps.now?.() ?? new Date(),
  );

  context.logger.info("consensus evaluated", {
    taskId,
    outcome: evaluation.result.outcome,
    agreementBps: evaluation.result.agreementBps,
    reports: evaluation.reportCount,
    resultHash: evaluation.resultHash,
  });
}

export async function evaluateTask(
  deps: OrchestratorDeps,
  taskId: string,
  context: Pick<JobContext, "job" | "logger">,
): Promise<ConsensusEvaluation> {
  const task = await one<TaskRow>(
    deps.pool,
    `SELECT task_id, status, rule_id, manifest_hash, manifest_pointer, verifier_count, revealed_count
       FROM tasks WHERE task_id = $1`,
    [taskId],
  );
  if (!task) {
    throw new ProofRelayError("TASK_NOT_FOUND", "no such task in the read model", {
      retryable: false,
      detail: { taskId },
    });
  }

  const manifest = await loadManifest(deps, task);
  const reportRows = await many<ReportRow>(
    deps.pool,
    `SELECT verifier, report_hash, report_pointer, revealed_at
       FROM reports
      WHERE task_id = $1 AND revealed_at IS NOT NULL AND report_hash IS NOT NULL
      ORDER BY verifier`,
    [taskId],
  );
  if (reportRows.length === 0) {
    throw new ProofRelayError("REPORT_NOT_FOUND", "no revealed report to evaluate", {
      retryable: false,
      detail: { taskId },
    });
  }

  // The report set has to be everything the chain recorded, not everything the
  // read model happens to hold yet.
  //
  // The trigger and the evaluation read different sources: `projectReportRevealed`
  // gates on `revealedCount` read live FROM THE CHAIN, while this reads the
  // `reports` table. When two reveals land in different indexer batches — 17
  // blocks apart on the first live task — projecting the first one sees a chain
  // that already says 2 and queues the evaluation, and the second row is not
  // written yet. The artifact is then built over one report, and the consensus
  // it records is not the one the task actually reached: two agreeing verifiers
  // came out NO_QUORUM, which refunds the creator in full and pays them nothing.
  //
  // Retryable on purpose: the missing rows are moments away, and the next
  // attempt evaluates the complete set.
  if (reportRows.length < task.revealed_count) {
    throw new ProofRelayError(
      "CHAIN_UNAVAILABLE",
      "the read model is behind the chain on this task's reveals",
      {
        retryable: true,
        detail: { taskId, indexed: reportRows.length, onchain: task.revealed_count },
      },
    );
  }

  const reports: VerifierReport[] = [];
  const reportHashes: string[] = [];
  for (const row of reportRows) {
    reports.push(await loadReport(deps, taskId, row));
    reportHashes.push(row.report_hash as string);
  }

  const result = evaluateConsensus({
    taskId,
    manifestHash: task.manifest_hash,
    ruleId: task.rule_id,
    producer: deps.config.api.producerId,
    reports,
    manifestClaims: manifest.claims.map(
      (claim): ManifestClaimRef => ({ claimId: claim.claimId, claimText: claim.claimText }),
    ),
    evaluatedAt: evaluatedAt(reportRows, context.job),
    reportHashes,
  });

  const expected = objectHash(result);
  const started = Date.now();
  const stored = await deps.storage.put("consensus-result", result).catch((error: unknown) => {
    metrics.storageLatency.observe(Date.now() - started, {
      driver: deps.storage.driver,
      kind: "consensus-result",
      outcome: "error",
    });
    throw wrapStorage(error, "uploading the consensus result");
  });
  metrics.storageLatency.observe(stored.latencyMs, {
    driver: deps.storage.driver,
    kind: "consensus-result",
    outcome: "ok",
  });

  // The adapter hashes what it wrote; if that disagrees with what we hashed,
  // the pointer we are about to publish addresses different bytes than the
  // hash the keeper will submit, and every later verification would fail.
  if (!hashesEqual(stored.hash, expected)) {
    throw new ProofRelayError("CONTENT_HASH_MISMATCH", "stored result does not match its hash", {
      retryable: false,
      detail: { expected, stored: stored.hash },
    });
  }

  await persistResult(deps, taskId, result, expected, stored.pointer, stored.byteLength);

  return {
    taskId,
    result,
    resultHash: expected,
    resultPointer: stored.pointer,
    reportCount: reports.length,
  };
}

/**
 * Deterministic on purpose. `evaluatedAt` is inside the hashed artifact, so a
 * wall-clock reading would give every retry a different `resultHash` — and the
 * keeper is about to check that the hash it submits is the hash of the artifact
 * that exists. The last reveal is a real measurement and does not move.
 */
function evaluatedAt(rows: readonly ReportRow[], job: Job): string {
  let latest = 0;
  for (const row of rows) {
    const at = row.revealed_at?.getTime() ?? 0;
    if (at > latest) latest = at;
  }
  return new Date(latest > 0 ? latest : job.createdAt.getTime()).toISOString();
}

async function loadManifest(deps: OrchestratorDeps, task: TaskRow): Promise<TaskManifest> {
  const cached = await one<{ body: unknown; verified: boolean }>(
    deps.pool,
    "SELECT body, verified FROM manifests WHERE manifest_hash = $1",
    [task.manifest_hash],
  );
  const body =
    cached?.verified && cached.body
      ? cached.body
      : await deps.storage
          .getJson(task.manifest_pointer)
          .catch((error: unknown) => {
            throw wrapStorage(error, "fetching the task manifest");
          });

  // Re-hashed even when it came from the cache. The cache is a copy of an
  // artifact whose hash is onchain; trusting the copy is how a bad row becomes
  // a settled task.
  if (!hashesEqual(objectHash(body), task.manifest_hash)) {
    throw new ProofRelayError("CONTENT_HASH_MISMATCH", "manifest does not match its onchain hash", {
      retryable: false,
      detail: { taskId: task.task_id, expected: task.manifest_hash },
    });
  }
  return TaskManifest.parse(body);
}

async function loadReport(
  deps: OrchestratorDeps,
  taskId: string,
  row: ReportRow,
): Promise<VerifierReport> {
  const reference = row.report_pointer ?? row.report_hash;
  if (!reference) {
    throw new ProofRelayError("REPORT_NOT_FOUND", "revealed report has no pointer", {
      retryable: false,
      detail: { taskId, verifier: row.verifier },
    });
  }

  const body = await deps.storage.getJson(reference).catch((error: unknown) => {
    throw wrapStorage(error, `fetching report ${row.verifier}`);
  });

  // The pointer is a retrieval hint and nothing more — a 0G merkle root is not
  // the object hash. This comparison is the only integrity mechanism there is.
  if (!hashesEqual(objectHash(body), row.report_hash)) {
    throw new ProofRelayError("CONTENT_HASH_MISMATCH", "report body does not match its onchain hash", {
      retryable: false,
      detail: { taskId, verifier: row.verifier, expected: row.report_hash, pointer: reference },
    });
  }

  // Verifier output is untrusted input (threat model: "Verifier worker — No").
  const report = VerifierReport.parse(body);
  if (!hashesEqual(report.taskId, taskId)) {
    throw new ProofRelayError("CONTENT_HASH_MISMATCH", "report names a different task", {
      retryable: false,
      detail: { taskId, reportTaskId: report.taskId, verifier: row.verifier },
    });
  }
  return report;
}

async function persistResult(
  deps: OrchestratorDeps,
  taskId: string,
  result: ConsensusResult,
  resultHash: string,
  pointer: string,
  byteLength: number,
): Promise<void> {
  await deps.pool.query(
    `INSERT INTO consensus_results
       (task_id, outcome, agreement_bps, result_hash, result_pointer, conflicts,
        rewarded_verifiers, claims, body, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
     ON CONFLICT (task_id) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       agreement_bps = EXCLUDED.agreement_bps,
       result_hash = EXCLUDED.result_hash,
       result_pointer = EXCLUDED.result_pointer,
       conflicts = EXCLUDED.conflicts,
       rewarded_verifiers = EXCLUDED.rewarded_verifiers,
       claims = EXCLUDED.claims,
       body = EXCLUDED.body,
       evaluated_at = EXCLUDED.evaluated_at`,
    [
      taskId,
      result.outcome,
      result.agreementBps,
      resultHash,
      pointer,
      JSON.stringify(result.conflicts),
      JSON.stringify(result.rewardedVerifiers),
      JSON.stringify(result.claims),
      JSON.stringify(result),
      result.evaluatedAt,
    ],
  );

  await deps.pool.query(
    `INSERT INTO artifacts
       (object_hash, kind, task_id, pointer, byte_length, producer, driver, name, hash_verified, body,
        artifact_created_at)
     VALUES ($1, 'consensus-result', $2, $3, $4, $5, $6, $7, TRUE, $8::jsonb, $9)
     ON CONFLICT (object_hash) DO UPDATE SET
       pointer = EXCLUDED.pointer,
       hash_verified = TRUE,
       body = EXCLUDED.body`,
    [
      resultHash,
      taskId,
      pointer,
      byteLength,
      result.producer,
      deps.storage.driver,
      `consensus-${taskId.slice(0, 10)}`,
      JSON.stringify(result),
      result.evaluatedAt,
    ],
  );
}

function requireTaskId(job: Job): string {
  const taskId = job.taskId ?? (job.payload.taskId as string | undefined);
  if (typeof taskId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(taskId)) {
    throw new ProofRelayError("VALIDATION_FAILED", "job carries no taskId", {
      retryable: false,
      detail: { jobId: job.id, jobType: job.jobType },
    });
  }
  return taskId;
}

/**
 * A storage failure is retryable; a hash failure never is. Keeping the two
 * apart is what stops a corrupted artifact from being retried three times and
 * then quietly forgotten under the same error code as a gateway blip.
 */
function wrapStorage(error: unknown, what: string): ProofRelayError {
  if (error instanceof ProofRelayError) return error;
  return new ProofRelayError("STORAGE_UNAVAILABLE", `0G Storage failed while ${what}`, {
    cause: error,
    detail: { message: String((error as Error)?.message ?? error).slice(0, 300) },
  });
}

/* ── NOTIFICATION ────────────────────────────────────────────────────────── */

/**
 * Fan-out to the operator's webhook. With no webhook configured this is a
 * successful no-op rather than a failure: an unconfigured optional integration
 * must not fill the queue with FAILED_FINAL rows.
 */
export async function runNotification(
  deps: OrchestratorDeps,
  context: JobContext,
): Promise<void> {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) {
    context.logger.debug("notification skipped; NOTIFY_WEBHOOK_URL is unset");
    return;
  }

  const payload = JSON.stringify({
    event: context.job.payload.event ?? "task.updated",
    taskId: context.job.taskId,
    chainId: deps.config.chain.chainId,
    contract: deps.config.chain.contract,
    data: context.job.payload,
    sentAt: new Date().toISOString(),
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (secret) {
    const { createHmac } = await import("node:crypto");
    headers["x-proofrelay-signature"] = createHmac("sha256", secret).update(payload).digest("hex");
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => {
    throw new ProofRelayError("SOURCE_UNAVAILABLE", "notification webhook is unreachable", {
      cause: error,
      detail: { message: String((error as Error)?.message ?? error).slice(0, 200) },
    });
  });

  if (!response.ok) {
    throw new ProofRelayError("SOURCE_UNAVAILABLE", "notification webhook rejected the delivery", {
      detail: { status: response.status },
    });
  }
}
