/**
 * The HTTP contract between apps/api and the web UI.
 *
 * Every field here exists because something in the Evidence Ledger interface
 * renders it. Where the UI showed an invented number, the field carries the
 * nearest honest measurement instead — the design is kept, the number becomes
 * real.
 */
import { z } from "zod";
import { ConsensusOutcome, Verdict } from "./artifacts.js";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/* ── shared ──────────────────────────────────────────────────────────────── */

/**
 * Whether a value came from the chain, from the read model, or from an artifact
 * in 0G Storage. The UI marks chain-sourced values distinctly (threat model:
 * "the UI marks chain-sourced values distinctly from derived ones").
 */
export const Provenance = z.enum(["chain", "index", "storage", "derived"]);
export type Provenance = z.infer<typeof Provenance>;

export const DisplayStatusSchema = z.enum([
  "VERIFIED",
  "IN REVIEW",
  "CONFLICT",
  "NO QUORUM",
  "DISPUTED",
  "EXPIRED",
  "CANCELLED",
]);

export const ToneSchema = z.enum(["lime", "sky", "coral", "ink"]);

export const TxRef = z.object({
  txHash: z.string().nullable(),
  blockNumber: z.number().int().nullable(),
  explorerUrl: z.string().nullable(),
});
export type TxRef = z.infer<typeof TxRef>;

/* ── /v1/stats ───────────────────────────────────────────────────────────── */

export const WorkspaceStats = z.object({
  activeTasks: z.number().int(),
  tasksNeedingReview: z.number().int(),
  openQueue: z.number().int(),
  inReview: z.number().int(),
  disputed: z.number().int(),
  conflict: z.number().int(),
  noQuorum: z.number().int(),
  verifiedTasks: z.number().int(),
  totalTasks: z.number().int(),
  /** share of claims across settled tasks that carry at least one source pointer */
  evidenceCoveragePct: z.number().nullable(),
  evidenceCoverageSampleSize: z.number().int(),
  /** wei, as a decimal string */
  bountiesSettledWei: z.string(),
  bountiesEscrowedWei: z.string(),
  medianVerificationSec: z.number().nullable(),
  medianVerificationSampleSize: z.number().int(),
  activeTasksTrendPct: z.number().nullable(),
  evidenceCoverageTrendPct: z.number().nullable(),
  bountiesSettledTrendPct: z.number().nullable(),
});
export type WorkspaceStats = z.infer<typeof WorkspaceStats>;

/* ── /v1/tasks ───────────────────────────────────────────────────────────── */

export const TaskSummary = z.object({
  taskId: hex32,
  /** short human handle, e.g. PR-1048 — assigned in creation order */
  ref: z.string(),
  title: z.string(),
  question: z.string(),
  primarySource: z.string().nullable(),
  sourceCount: z.number().int(),
  status: DisplayStatusSchema,
  rawStatus: z.string(),
  rawStatusCode: z.number().int(),
  outcome: z.string(),
  tone: ToneSchema,
  creator: address,
  bountyWei: z.string(),
  bountyFormatted: z.string(),
  verifierCount: z.number().int(),
  committedCount: z.number().int(),
  revealedCount: z.number().int(),
  agreementLabel: z.string(),
  agreementPct: z.number().int(),
  claimCount: z.number().int(),
  updatedAt: z.string(),
  createdAt: z.string(),
  commitDeadline: z.string().nullable(),
  revealDeadline: z.string().nullable(),
  disputeDeadline: z.string().nullable(),
  manifestHash: hex32,
  manifestPointer: z.string(),
  resultHash: hex32.nullable(),
  hasDispute: z.boolean(),
  syncRequired: z.boolean(),
  tx: TxRef,
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskListQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  creator: address.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const TaskListResponse = z.object({
  items: z.array(TaskSummary),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  counts: z.record(z.number().int()),
});
export type TaskListResponse = z.infer<typeof TaskListResponse>;

/* ── /v1/tasks/:taskId ───────────────────────────────────────────────────── */

export const EvidenceSpan = z.object({
  uri: z.string(),
  snapshotObjectId: z.string(),
  contentHash: z.string(),
  quotedSpan: z.string(),
  score: z.number(),
  retrievedAt: z.string(),
});

export const ClaimVerdictView = z.object({
  verifier: address,
  verifierLabel: z.string(),
  verdict: Verdict,
  confidence: z.number(),
  reasoningSummary: z.string(),
  sources: z.array(EvidenceSpan),
});

export const ClaimView = z.object({
  claimId: z.string(),
  ordinal: z.string(),
  claimText: z.string(),
  majorityVerdict: Verdict.nullable(),
  displayVerdict: z.enum(["SUPPORTED", "CONTRADICTED", "INSUFFICIENT", "PENDING"]),
  agreed: z.boolean(),
  criticalConflict: z.boolean(),
  confidencePct: z.number().nullable(),
  evidenceCoverage: z.number().nullable(),
  primarySourceLabel: z.string().nullable(),
  excerpt: z.string().nullable(),
  snapshotObjectId: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  verdicts: z.array(ClaimVerdictView),
});
export type ClaimView = z.infer<typeof ClaimView>;

export const ReportView = z.object({
  verifier: address,
  verifierLabel: z.string(),
  committed: z.boolean(),
  revealed: z.boolean(),
  commitment: hex32.nullable(),
  reportHash: hex32.nullable(),
  reportPointer: z.string().nullable(),
  modelId: z.string().nullable(),
  pipelineVersion: z.string().nullable(),
  committedAt: z.string().nullable(),
  revealedAt: z.string().nullable(),
  supported: z.number().int().nullable(),
  contradicted: z.number().int().nullable(),
  insufficient: z.number().int().nullable(),
  meanConfidence: z.number().nullable(),
  computeProvider: z.string().nullable(),
  computeLatencyMs: z.number().int().nullable(),
  commitTx: TxRef,
  revealTx: TxRef,
});
export type ReportView = z.infer<typeof ReportView>;

export const DisputeView = z.object({
  challenger: address,
  bondWei: z.string(),
  reason: z.string().nullable(),
  evidenceHash: hex32,
  evidencePointer: z.string(),
  openedAt: z.string().nullable(),
  deadline: z.string().nullable(),
  resolved: z.boolean(),
  upheld: z.boolean(),
  decision: z.string().nullable(),
  adjudicationHash: hex32.nullable(),
  adjudicationPointer: z.string().nullable(),
  tx: TxRef,
});
export type DisputeView = z.infer<typeof DisputeView>;

export const TaskDetail = TaskSummary.extend({
  manifest: z.unknown().nullable(),
  sources: z.array(
    z.object({
      sourceId: z.string(),
      uri: z.string(),
      status: z.string(),
      contentHash: z.string(),
      byteLength: z.number().int(),
      snapshotPointer: z.string(),
      snapshotHash: hex32,
    }),
  ),
  claims: z.array(ClaimView),
  reports: z.array(ReportView),
  consensus: z
    .object({
      outcome: ConsensusOutcome,
      agreementBps: z.number().int(),
      conflicts: z.array(z.string()),
      rewardedVerifiers: z.array(address),
      resultHash: hex32,
      resultPointer: z.string().nullable(),
      evaluatedAt: z.string(),
    })
    .nullable(),
  dispute: DisputeView.nullable(),
  allocations: z.array(z.object({ verifier: address, amountWei: z.string() })),
  timeline: z.array(
    z.object({
      at: z.string(),
      label: z.string(),
      detail: z.string(),
      tx: TxRef,
    }),
  ),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/* ── /v1/tasks/prepare ───────────────────────────────────────────────────── */

export const PrepareTaskRequest = z.object({
  title: z.string().min(3).max(200),
  question: z.string().min(3).max(2000),
  answerText: z.string().max(20_000).nullable().optional(),
  claims: z.array(z.string().min(3).max(1000)).min(1).max(50),
  sources: z
    .array(
      z.union([
        z.string().url(),
        z.object({ uri: z.string().url() }),
        z.object({ inlineText: z.string().min(1).max(200_000), label: z.string().optional() }),
      ]),
    )
    .max(20)
    .default([]),
  verifierCount: z.number().int().min(2).max(16).default(2),
  commitWindowSec: z.number().int().min(30).max(2_592_000).default(900),
  revealWindowSec: z.number().int().min(30).max(2_592_000).default(900),
  disputeWindowSec: z.number().int().min(30).max(2_592_000).default(900),
  bountyWei: z.string().regex(/^\d+$/),
});
export type PrepareTaskRequest = z.infer<typeof PrepareTaskRequest>;

export const PrepareTaskResponse = z.object({
  manifestId: z.string(),
  manifestHash: hex32,
  manifestPointer: z.string(),
  manifest: z.unknown(),
  ruleId: hex32,
  predictedTaskId: hex32,
  sources: z.array(
    z.object({
      sourceId: z.string(),
      uri: z.string(),
      status: z.string(),
      contentHash: z.string(),
      byteLength: z.number().int(),
      snapshotPointer: z.string(),
      snapshotHash: hex32,
      error: z.string().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
  /** exactly what to pass to createTask, in tuple order */
  createTaskArgs: z.object({
    verifierCount: z.number().int(),
    commitWindowSec: z.number().int(),
    revealWindowSec: z.number().int(),
    disputeWindowSec: z.number().int(),
    manifestHash: hex32,
    manifestPointer: z.string(),
    ruleId: hex32,
    valueWei: z.string(),
  }),
});
export type PrepareTaskResponse = z.infer<typeof PrepareTaskResponse>;

/* ── /v1/tasks/:taskId/challenge ─────────────────────────────────────────── */

export const PrepareChallengeRequest = z.object({
  reason: z.string().min(10).max(2000),
  disputedClaims: z.array(z.string()).default([]),
  additionalEvidence: z
    .array(z.object({ uri: z.string().url(), note: z.string().max(500).default("") }))
    .max(10)
    .default([]),
});

export const PrepareChallengeResponse = z.object({
  evidenceHash: hex32,
  evidencePointer: z.string(),
  bondWei: z.string(),
  evidence: z.unknown(),
});
export type PrepareChallengeResponse = z.infer<typeof PrepareChallengeResponse>;

/* ── /v1/verifiers ───────────────────────────────────────────────────────── */

export const VerifierView = z.object({
  address: address,
  name: z.string(),
  shortAddress: z.string(),
  role: z.string(),
  modelId: z.string().nullable(),
  pipelineVersion: z.string().nullable(),
  registered: z.boolean(),
  approved: z.boolean(),
  active: z.boolean(),
  status: z.enum(["ONLINE", "DEGRADED", "OFFLINE", "PENDING"]),
  tone: ToneSchema,
  stakeWei: z.string(),
  stakeFormatted: z.string(),
  metadataHash: hex32,
  metadataPointer: z.string(),
  reportsRevealed: z.number().int(),
  reportsCommitted: z.number().int(),
  tasksSeen: z.number().int(),
  agreementPct: z.number().nullable(),
  uptimePct: z.number().nullable(),
  /** reveal-rate per day over the last 24 buckets, 0..100; drives the uptime bars */
  uptimeSeries: z.array(z.number()),
  medianLatencyMs: z.number().int().nullable(),
  lastSeenAt: z.string().nullable(),
  pendingWithdrawalWei: z.string(),
});
export type VerifierView = z.infer<typeof VerifierView>;

export const VerifierListResponse = z.object({
  items: z.array(VerifierView),
  summary: z.object({
    active: z.number().int(),
    online: z.number().int(),
    degraded: z.number().int(),
    networkAgreementPct: z.number().nullable(),
    networkAgreementTrendPct: z.number().nullable(),
    totalStakedWei: z.string(),
    totalStakedFormatted: z.string(),
    medianLatencyMs: z.number().int().nullable(),
    slashingEnabled: z.boolean(),
  }),
  events: z.array(
    z.object({
      label: z.string(),
      operator: z.string(),
      taskRef: z.string(),
      taskId: hex32.nullable(),
      at: z.string(),
      tone: ToneSchema,
    }),
  ),
});
export type VerifierListResponse = z.infer<typeof VerifierListResponse>;

/* ── /v1/artifacts ───────────────────────────────────────────────────────── */

export const ArtifactView = z.object({
  name: z.string(),
  kind: z.string(),
  typeLabel: z.string(),
  taskRef: z.string(),
  taskId: hex32.nullable(),
  objectId: z.string(),
  pointer: z.string(),
  hash: z.string(),
  shortHash: z.string(),
  byteLength: z.number().int(),
  sizeLabel: z.string(),
  createdAt: z.string(),
  driver: z.string(),
  icon: z.enum(["json", "text", "check", "image"]),
  tone: ToneSchema,
  storageExplorerUrl: z.string().nullable(),
});
export type ArtifactView = z.infer<typeof ArtifactView>;

export const ArtifactListResponse = z.object({
  items: z.array(ArtifactView),
  nextCursor: z.string().nullable(),
  summary: z.object({
    totalObjects: z.number().int(),
    taskCount: z.number().int(),
    totalBytes: z.number().int(),
    totalSizeLabel: z.string(),
    hashCoveragePct: z.number(),
    driver: z.string(),
    network: z.string(),
  }),
  types: z.array(z.string()),
});
export type ArtifactListResponse = z.infer<typeof ArtifactListResponse>;

/* ── /v1/activity ────────────────────────────────────────────────────────── */

export const ACTIVITY_CATEGORIES = [
  "Verification",
  "Storage",
  "Settlement",
  "Dispute",
  "Compute",
  "Registry",
] as const;

export const ActivityEvent = z.object({
  id: z.string(),
  day: z.string(),
  at: z.string(),
  time: z.string(),
  title: z.string(),
  detail: z.string(),
  actor: z.string(),
  actorAddress: address.nullable(),
  taskRef: z.string(),
  taskId: hex32.nullable(),
  category: z.enum(ACTIVITY_CATEGORIES),
  icon: z.string(),
  tone: ToneSchema,
  hash: z.string(),
  tx: TxRef,
  payload: z.unknown().nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityListResponse = z.object({
  items: z.array(ActivityEvent),
  nextCursor: z.string().nullable(),
  summary: z.object({
    eventsToday: z.number().int(),
    eventsYesterday: z.number().int(),
    trendPct: z.number().nullable(),
    lastBlock: z.number().int().nullable(),
    lastBlockAgeSec: z.number().int().nullable(),
    openSignals: z.number().int(),
    openSignalDetail: z.string(),
  }),
  categories: z.array(z.string()),
});
export type ActivityListResponse = z.infer<typeof ActivityListResponse>;

/* ── /health ─────────────────────────────────────────────────────────────── */

export const DependencyHealth = z.object({
  ok: z.boolean(),
  detail: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
});
export type DependencyHealth = z.infer<typeof DependencyHealth>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  chainId: z.number().int(),
  contract: address,
  network: z.string(),
  explorer: z.string(),
  storageExplorer: z.string(),
  drivers: z.object({ storage: z.string(), compute: z.string() }),
  dependencies: z.record(DependencyHealth),
  indexer: z.object({
    running: z.boolean(),
    lastError: z.string().nullable(),
    processedEvents: z.number().int(),
    lastBlock: z.number().int().nullable(),
    headBlock: z.number().int().nullable(),
    lagBlocks: z.number().int().nullable(),
  }),
  queue: z.record(z.number().int()),
  paused: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/* ── /v1/reports/:reportHash ─────────────────────────────────────────────── */

export const ReportFetchResponse = z.object({
  reportHash: hex32,
  verified: z.boolean(),
  source: z.enum(["storage", "cache"]),
  pointer: z.string().nullable(),
  report: z.unknown(),
});
export type ReportFetchResponse = z.infer<typeof ReportFetchResponse>;

/* ── /v1/artifacts/{contentHash} ─────────────────────────────────────────── */

/**
 * One canonical object, fetched by its content hash and proved before it is
 * served. `verified` is the comparison this route performed, not a flag copied
 * from a row: a body that did not rehash to the hash in the URL is answered
 * with 409 rather than with `verified: false`.
 *
 * `byteLength` describes the bytes that were actually hashed, which is why it
 * can differ from the size the index recorded — the index is a cache, and the
 * bytes are the thing.
 */
export const ArtifactFetchResponse = z.object({
  contentHash: hex32,
  kind: z.string(),
  pointer: z.string().nullable(),
  byteLength: z.number().int().nonnegative(),
  verified: z.literal(true),
  source: z.enum(["storage", "cache"]),
  fetchedAt: z.string(),
  body: z.unknown(),
});
export type ArtifactFetchResponse = z.infer<typeof ArtifactFetchResponse>;

/* ── auth ────────────────────────────────────────────────────────────────── */

export const NonceRequest = z.object({ address: address });
export const NonceResponse = z.object({
  nonce: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});
export const VerifyRequest = z.object({
  address: address,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  nonce: z.string(),
});
export const VerifyResponse = z.object({
  token: z.string(),
  address: address,
  expiresAt: z.string(),
});
