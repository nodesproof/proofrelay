/**
 * Artifact body sync.
 *
 * A chain event gives a hash and, usually, a pointer. The pointer is a
 * retrieval hint — a 0G merkle root or a local object id — and the hash is the
 * only integrity mechanism, so this worker does exactly one thing that matters:
 * it fetches the bytes, recomputes `objectHash` over them, and compares.
 *
 * On a match the body is parsed against its schema, cached, and denormalised
 * onto the task or report so the UI does not need a storage read per row.
 *
 * On a mismatch the body is **not stored**, anywhere, in any form. A mismatch
 * is precisely the condition the hash exists to detect: it means the bytes at
 * that pointer are not the bytes the chain committed to, and a read model that
 * cached them would be laundering unverified content through an interface that
 * says "verified". The row keeps the hash, `hash_verified` stays false, and the
 * error is recorded for a human — the runbook treats a non-zero mismatch count
 * as needing one.
 *
 * A pointer that never resolves is a different failure and gets the retry
 * ladder instead: the row ends up with the hash and no body, which is honest
 * about what we have.
 */
import {
  ProofRelayError,
  bareHex,
  hashesEqual,
  parseArtifact,
  shortHash,
  type Artifact,
  type ArtifactKind,
} from "@proofrelay/schemas";
import type { FetchedObject } from "@proofrelay/storage-adapter";
import { many, one, type Pool } from "../db.js";
import { Logger, metrics } from "../observability.js";
import { ARTIFACT_SYNC_JOB, type ArtifactSyncPayload } from "./projections.js";

/** The slice of StorageAdapter this worker needs; a real adapter satisfies it. */
export interface ArtifactStore {
  readonly driver: string;
  get(reference: string): Promise<FetchedObject>;
}

export interface ArtifactSyncDeps {
  pool: Pool;
  storage: ArtifactStore;
  logger?: Logger | undefined;
  /** Attempts before a pointer is declared permanently unavailable. */
  maxAttempts?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  batchSize?: number | undefined;
  pollMs?: number | undefined;
}

export type ArtifactSyncOutcome =
  /** Bytes fetched, hash matched, schema parsed, body stored. */
  | "verified"
  /** Bytes fetched, hash did not match. Permanent, and never cached. */
  | "mismatch"
  /** Hash matched but the body is not a valid artifact of its kind. Permanent. */
  | "invalid"
  /** Nothing came back. Retryable. */
  | "unavailable";

export interface ArtifactSyncResult {
  outcome: ArtifactSyncOutcome;
  hash: string;
  kind: string;
  pointer: string | null;
  byteLength: number;
  error: string | null;
}

export interface ArtifactSyncPass {
  claimed: number;
  verified: number;
  mismatched: number;
  invalid: number;
  retried: number;
  abandoned: number;
}

interface JobRow {
  id: number;
  payload: ArtifactSyncPayload;
  attempts: number;
}

const DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  batchSize: 8,
  pollMs: 3_000,
};

export class ArtifactSync {
  private readonly pool: Pool;
  private readonly storage: ArtifactStore;
  private readonly log: Logger;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly batchSize: number;
  private readonly pollMs: number;
  /** Identifies this process's lease, so a crashed pass can be reaped. */
  private readonly workerId: string;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;
  private started = false;

  constructor(deps: ArtifactSyncDeps) {
    this.pool = deps.pool;
    this.storage = deps.storage;
    this.log = (deps.logger ?? new Logger()).child({ component: "artifact-sync" });
    this.maxAttempts = deps.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseDelayMs = deps.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = deps.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.batchSize = deps.batchSize ?? DEFAULTS.batchSize;
    this.pollMs = deps.pollMs ?? DEFAULTS.pollMs;
    this.workerId = `artifact-sync/${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runOnce()
        .catch((error) => {
          this.log.error("artifact sync pass failed", { detail: String((error as Error).message).slice(0, 200) });
        })
        .finally(() => {
          this.inFlight = null;
          this.schedule(this.pollMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Drains one batch of due jobs. */
  async runOnce(): Promise<ArtifactSyncPass> {
    const pass: ArtifactSyncPass = {
      claimed: 0,
      verified: 0,
      mismatched: 0,
      invalid: 0,
      retried: 0,
      abandoned: 0,
    };
    const jobs = await this.claim();
    pass.claimed = jobs.length;

    for (const job of jobs) {
      // An unexpected throw used to escape the loop with this job — and every
      // job after it in the batch — still RUNNING and, without a lease, beyond
      // the reaper's reach. Route it through the normal retry path instead.
      let result: ArtifactSyncResult;
      try {
        result = await this.syncOne(job.payload);
      } catch (error) {
        pass.abandoned += 1;
        this.log.error("artifact sync threw", {
          component: "artifact-sync",
          taskId: job.payload.taskId,
          error: String((error as Error).message).slice(0, 300),
        });
        await this.finish(
          job.id,
          job.attempts >= this.maxAttempts ? "FAILED_FINAL" : "FAILED_RETRYABLE",
          "INTERNAL",
          String((error as Error).message),
          this.backoffMs(job.attempts),
        );
        continue;
      }
      switch (result.outcome) {
        case "verified":
          pass.verified += 1;
          await this.finish(job.id, "DONE", null, null);
          break;
        case "mismatch":
          pass.mismatched += 1;
          // Retrying cannot turn wrong bytes into right ones, and a silent
          // retry loop would bury the one signal that always needs a human.
          await this.finish(job.id, "FAILED_FINAL", "CONTENT_HASH_MISMATCH", result.error);
          this.log.error("artifact hash mismatch", {
            errorCode: "CONTENT_HASH_MISMATCH",
            taskId: job.payload.taskId,
            hash: result.hash,
            pointer: result.pointer,
          });
          break;
        case "invalid":
          pass.invalid += 1;
          await this.finish(job.id, "FAILED_FINAL", "VALIDATION_FAILED", result.error);
          break;
        default: {
          const exhausted = job.attempts >= this.maxAttempts;
          if (exhausted) pass.abandoned += 1;
          else pass.retried += 1;
          metrics.jobRetry.inc({ job_type: ARTIFACT_SYNC_JOB, error_code: "STORAGE_UNAVAILABLE" });
          await this.finish(
            job.id,
            exhausted ? "FAILED_FINAL" : "FAILED_RETRYABLE",
            "STORAGE_UNAVAILABLE",
            result.error,
            exhausted ? null : this.backoffMs(job.attempts),
          );
        }
      }
    }
    return pass;
  }

  /**
   * Fetch, verify, store. Public so a route can force one artifact without
   * going through the queue.
   */
  async syncOne(payload: ArtifactSyncPayload): Promise<ArtifactSyncResult> {
    const hash = payload.hash.toLowerCase();
    const pointer = payload.pointer ?? (await this.knownPointer(hash));
    // With no pointer the hash itself is a valid reference: the local driver
    // addresses by object id, and 0G serves a cached object the same way.
    const reference = pointer ?? hash;

    let fetched: FetchedObject;
    try {
      fetched = await this.storage.get(reference);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300);
      await this.recordUnverified(payload, pointer, 0);
      return { outcome: "unavailable", hash, kind: payload.kind, pointer, byteLength: 0, error: message };
    }

    if (!hashesEqual(fetched.hash, hash)) {
      const error = `expected ${hash}, storage returned ${fetched.hash}`;
      await this.recordMismatch(payload, pointer ?? fetched.pointer, fetched.bytes.length);
      return {
        outcome: "mismatch",
        hash,
        kind: payload.kind,
        pointer,
        byteLength: fetched.bytes.length,
        error,
      };
    }

    // The bytes are the committed bytes. `raw` is what gets cached, and
    // `artifact` is only used to read fields off it: zod strips keys the schema
    // does not declare, so caching the parsed value would store an object that
    // no longer hashes to the hash we just verified.
    let raw: unknown;
    let artifact: Artifact;
    try {
      raw = JSON.parse(fetched.bytes.toString("utf8"));
      artifact = parseArtifact(payload.kind, raw);
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300);
      // The hash checked out — this is our schema disagreeing with a producer,
      // not corrupt content, and the two must not be reported as the same thing.
      await this.recordUnverified(payload, pointer ?? fetched.pointer, fetched.bytes.length, true);
      return {
        outcome: "invalid",
        hash,
        kind: payload.kind,
        pointer,
        byteLength: fetched.bytes.length,
        error: message,
      };
    }

    await this.store(payload, artifact, raw, pointer ?? fetched.pointer, fetched.bytes.length);
    return {
      outcome: "verified",
      hash,
      kind: payload.kind,
      pointer: pointer ?? fetched.pointer,
      byteLength: fetched.bytes.length,
      error: null,
    };
  }

  /* ── queue ─────────────────────────────────────────────────────────────── */

  private async claim(): Promise<JobRow[]> {
    return many<JobRow>(
      this.pool,
      // `locked_by` and `locked_at` are what make this row recoverable. The
      // reaper in queue.ts only reclaims RUNNING rows with a lease
      // (`locked_at IS NOT NULL`), and migration 002 exists for exactly this:
      // "a worker killed mid-job leaves a RUNNING row nothing will ever pick up
      // again". Claiming without a lease made every crash a permanent strand,
      // and `jobs.idempotency_key` guarantees the job can never be re-queued.
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1,
              locked_by = $3, locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM jobs
           WHERE job_type = $1
             AND status IN ('PENDING', 'FAILED_RETRYABLE')
             AND (next_retry_at IS NULL OR next_retry_at <= now())
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, payload, attempts`,
      [ARTIFACT_SYNC_JOB, this.batchSize, this.workerId],
    );
  }

  private async finish(
    id: number,
    status: string,
    errorCode: string | null,
    error: string | null,
    retryInMs: number | null = null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
          SET status = $2,
              locked_by = NULL,
              locked_at = NULL,
              last_error_code = $3,
              last_error = $4,
              next_retry_at = CASE WHEN $5::bigint IS NULL THEN NULL
                                   ELSE now() + ($5::bigint || ' milliseconds')::interval END,
              updated_at = now()
        WHERE id = $1`,
      [id, status, errorCode, error ? error.slice(0, 500) : null, retryInMs],
    );
  }

  private backoffMs(attempts: number): number {
    const delay = this.baseDelayMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(this.maxDelayMs, Math.round(delay));
  }

  private async knownPointer(hash: string): Promise<string | null> {
    const row = await one<{ pointer: string }>(
      this.pool,
      "SELECT pointer FROM artifacts WHERE object_hash = $1 AND pointer <> ''",
      [hash],
    );
    return row?.pointer ?? null;
  }

  /* ── writes ────────────────────────────────────────────────────────────── */

  private async upsertArtifact(args: {
    payload: ArtifactSyncPayload;
    pointer: string | null;
    byteLength: number;
    verified: boolean;
    body: unknown;
    producer: string | null;
    createdAt: string | null;
  }): Promise<void> {
    const { payload } = args;
    const pointer = args.pointer ?? "";
    await this.pool.query(
      `INSERT INTO artifacts (
         object_hash, kind, task_id, pointer, root_hash, byte_length, producer,
         driver, name, hash_verified, body, artifact_created_at, first_seen_block
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       ON CONFLICT (object_hash) DO UPDATE SET
         kind          = EXCLUDED.kind,
         task_id       = COALESCE(EXCLUDED.task_id, artifacts.task_id),
         pointer       = CASE WHEN EXCLUDED.pointer <> '' THEN EXCLUDED.pointer ELSE artifacts.pointer END,
         root_hash     = COALESCE(EXCLUDED.root_hash, artifacts.root_hash),
         byte_length   = GREATEST(EXCLUDED.byte_length, artifacts.byte_length),
         producer      = COALESCE(EXCLUDED.producer, artifacts.producer),
         driver        = EXCLUDED.driver,
         -- Both sticky: a gateway serving wrong bytes today does not unprove
         -- bytes that hashed correctly yesterday, and a failed re-check must
         -- never blank a body that already passed.
         hash_verified = artifacts.hash_verified OR EXCLUDED.hash_verified,
         body          = COALESCE(EXCLUDED.body, artifacts.body),
         artifact_created_at = COALESCE(EXCLUDED.artifact_created_at, artifacts.artifact_created_at),
         first_seen_block    = LEAST(artifacts.first_seen_block, EXCLUDED.first_seen_block)`,
      [
        payload.hash.toLowerCase(),
        payload.kind,
        payload.taskId,
        pointer,
        rootHashOf(pointer),
        args.byteLength,
        args.producer,
        this.storage.driver,
        artifactName(payload),
        args.verified,
        args.body ? JSON.stringify(args.body) : null,
        args.createdAt ? new Date(args.createdAt) : null,
        payload.block,
      ],
    );
  }

  /** The index row for an artifact whose body we are not storing: hash, no body. */
  private async recordUnverified(
    payload: ArtifactSyncPayload,
    pointer: string | null,
    byteLength: number,
    hashVerified = false,
  ): Promise<void> {
    await this.upsertArtifact({
      payload,
      pointer,
      byteLength,
      verified: hashVerified,
      body: null,
      producer: null,
      createdAt: null,
    });
  }

  private async recordMismatch(
    payload: ArtifactSyncPayload,
    pointer: string | null,
    byteLength: number,
  ): Promise<void> {
    const hash = payload.hash.toLowerCase();
    await this.recordUnverified(payload, pointer, byteLength);

    // If these bytes already passed once, the earlier proof stands and the rows
    // derived from it stay; only a body we never verified gets marked down.
    const known = await one<{ hash_verified: boolean }>(
      this.pool,
      "SELECT hash_verified FROM artifacts WHERE object_hash = $1",
      [hash],
    );
    if (known?.hash_verified) return;

    if (payload.kind === "task-manifest") {
      await this.pool.query("UPDATE tasks SET manifest_verified = FALSE WHERE manifest_hash = $1", [hash]);
    }
    if (payload.kind === "verifier-report") {
      await this.pool.query("UPDATE reports SET body_verified = FALSE, body = NULL WHERE report_hash = $1", [
        hash,
      ]);
    }
  }

  private async store(
    payload: ArtifactSyncPayload,
    artifact: Artifact,
    raw: unknown,
    pointer: string | null,
    byteLength: number,
  ): Promise<void> {
    await this.upsertArtifact({
      payload,
      pointer,
      byteLength,
      verified: true,
      body: raw,
      producer: producerOf(artifact),
      createdAt: createdAtOf(artifact),
    });

    switch (artifact.kind) {
      case "task-manifest":
        await this.denormaliseManifest(payload, artifact, raw, pointer);
        break;
      case "verifier-report":
        await this.denormaliseReport(payload, artifact, raw);
        break;
      case "consensus-result":
        await this.denormaliseConsensus(payload, artifact, raw, pointer);
        break;
      case "challenge-evidence":
        await this.pool.query(
          `UPDATE disputes SET reason = $2, disputed_claims = $3::jsonb WHERE evidence_hash = $1`,
          [payload.hash.toLowerCase(), artifact.reason, JSON.stringify(artifact.disputedClaims)],
        );
        break;
      case "adjudication-report":
        await this.pool.query("UPDATE disputes SET decision = $2 WHERE adjudication_hash = $1", [
          payload.hash.toLowerCase(),
          artifact.decision,
        ]);
        break;
      default:
        // source-snapshot: indexed, but nothing on a task row is derived from it.
        break;
    }
  }

  private async denormaliseManifest(
    payload: ArtifactSyncPayload,
    manifest: Extract<Artifact, { kind: "task-manifest" }>,
    raw: unknown,
    pointer: string | null,
  ): Promise<void> {
    const hash = payload.hash.toLowerCase();
    const primary = manifest.sources[0]?.uri ?? null;
    await this.pool.query(
      `INSERT INTO manifests (
         manifest_hash, manifest_pointer, chain_id, creator, rule_id, title, question,
         claim_count, source_count, body, verified
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,TRUE)
       ON CONFLICT (manifest_hash) DO UPDATE SET
         manifest_pointer = EXCLUDED.manifest_pointer,
         chain_id    = EXCLUDED.chain_id,
         creator     = EXCLUDED.creator,
         rule_id     = EXCLUDED.rule_id,
         title       = EXCLUDED.title,
         question    = EXCLUDED.question,
         claim_count = EXCLUDED.claim_count,
         source_count= EXCLUDED.source_count,
         body        = EXCLUDED.body,
         verified    = TRUE`,
      [
        hash,
        pointer ?? "",
        manifest.chainId,
        manifest.creator,
        manifest.policy.ruleId.toLowerCase(),
        manifest.title,
        manifest.question,
        manifest.claims.length,
        manifest.sources.length,
        JSON.stringify(raw),
      ],
    );
    // Keyed on the hash, not the task: several tasks may commit to the same
    // manifest, and every one of them has now been proven against it.
    await this.pool.query(
      `UPDATE tasks SET
         title = $2, question = $3, claim_count = $4, source_count = $5,
         primary_source = $6, manifest_verified = TRUE, updated_at = now()
       WHERE manifest_hash = $1`,
      [
        hash,
        manifest.title,
        manifest.question,
        manifest.claims.length,
        manifest.sources.length,
        primary,
      ],
    );
  }

  private async denormaliseReport(
    payload: ArtifactSyncPayload,
    report: Extract<Artifact, { kind: "verifier-report" }>,
    raw: unknown,
  ): Promise<void> {
    const traces = report.compute;
    const latency = traces.reduce((total, trace) => total + trace.latencyMs, 0);
    await this.pool.query(
      `UPDATE reports SET
         model_id = $2, pipeline_version = $3, body = $4::jsonb,
         supported = $5, contradicted = $6, insufficient = $7,
         mean_confidence = $8, evidence_coverage = $9,
         compute_provider = $10, compute_latency_ms = $11, compute_verified = $12,
         body_verified = TRUE
       WHERE report_hash = $1`,
      [
        payload.hash.toLowerCase(),
        report.verifier.modelId,
        report.verifier.pipelineVersion,
        JSON.stringify(raw),
        report.summary.supported,
        report.summary.contradicted,
        report.summary.insufficient,
        report.summary.meanConfidence,
        report.summary.evidenceCoverage,
        traces[0]?.provider ?? null,
        traces.length > 0 ? latency : null,
        traces.length > 0 ? traces.every((trace) => trace.verified) : null,
      ],
    );
  }

  private async denormaliseConsensus(
    payload: ArtifactSyncPayload,
    result: Extract<Artifact, { kind: "consensus-result" }>,
    raw: unknown,
    pointer: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE consensus_results SET
         outcome = $2, agreement_bps = $3, result_pointer = COALESCE($4, result_pointer),
         conflicts = $5::jsonb, rewarded_verifiers = $6::jsonb, claims = $7::jsonb, body = $8::jsonb,
         evaluated_at = $9
       WHERE result_hash = $1`,
      [
        payload.hash.toLowerCase(),
        result.outcome,
        result.agreementBps,
        pointer,
        JSON.stringify(result.conflicts),
        JSON.stringify(result.rewardedVerifiers),
        JSON.stringify(result.claims),
        JSON.stringify(raw),
        new Date(result.evaluatedAt),
      ],
    );
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Storage has no filenames — the key is the hash. The Artifacts page needs
 * something to render, so the name is synthesized from the kind and the task
 * it belongs to, and the hash stays the identity.
 */
export function artifactName(payload: ArtifactSyncPayload): string {
  return `${payload.kind}_${shortHash(payload.taskId ?? payload.hash)}.json`;
}

function rootHashOf(pointer: string): string | null {
  const match = /^0g:\/\/(0x[0-9a-fA-F]+)$/.exec(pointer.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

function producerOf(artifact: Artifact): string | null {
  if ("producer" in artifact && typeof artifact.producer === "string") return artifact.producer;
  if (artifact.kind === "verifier-report") return artifact.verifier.verifierId;
  if (artifact.kind === "adjudication-report") return artifact.adjudicator;
  if (artifact.kind === "challenge-evidence") return artifact.challenger;
  return null;
}

function createdAtOf(artifact: Artifact): string | null {
  if (artifact.kind === "consensus-result") return artifact.evaluatedAt;
  if (artifact.kind === "source-snapshot") return artifact.retrievedAt;
  return artifact.createdAt;
}

/** Bare hex of an object hash, for callers resolving a pointer from a hash. */
export function artifactKey(hash: string): string {
  return bareHex(hash);
}

/** Thrown by callers that need a hard failure rather than a queued retry. */
export function hashMismatchError(hash: string, actual: string, pointer: string | null): ProofRelayError {
  return new ProofRelayError("CONTENT_HASH_MISMATCH", "artifact does not match its onchain hash", {
    retryable: false,
    detail: { expected: hash, actual, pointer },
  });
}
