/**
 * TypeScript mirrors of packages/schemas/src/api.ts — the HTTP contract between
 * apps/api and this UI.
 *
 * Every shape here is a one-to-one transcription of the zod schema of the same
 * name in that file. Nothing is added, renamed or widened: if a field is not in
 * packages/schemas, it is not in this file, and the UI must render a loading or
 * empty state instead of inventing it.
 */

/* ── primitives ──────────────────────────────────────────────────────────── */

export type Hex = `0x${string}`;
/** EIP-55 checksummed, 42 chars. */
export type Address = `0x${string}`;
/** 66 chars — task ids and every canonical object hash. */
export type Bytes32 = `0x${string}`;
/** ISO-8601, e.g. "2026-08-31T10:43:06.115Z". */
export type Iso = string;
/** wei as a decimal string — never a number, the values overflow float64. */
export type Wei = string;
/** "local://<hex>" locally, a 0G storage root under the zerog driver. */
export type Pointer = string;

/* ── enums (packages/schemas/src/artifacts.ts) ───────────────────────────── */

export type Verdict = "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";
export type ConsensusOutcome = "CONSENSUS" | "CONFLICT" | "NO_QUORUM";

/* ── shared ──────────────────────────────────────────────────────────────── */

/**
 * Whether a value came from the chain, from the read model, or from an artifact
 * in 0G Storage. The UI marks chain-sourced values distinctly from derived ones.
 */
export type Provenance = "chain" | "index" | "storage" | "derived";

export type DisplayStatus = "VERIFIED" | "IN REVIEW" | "DISPUTED" | "EXPIRED" | "CANCELLED";

export type Tone = "lime" | "sky" | "coral" | "ink";

export interface TxRef {
  txHash: string | null;
  blockNumber: number | null;
  explorerUrl: string | null;
}

/* ── GET /v1/stats ───────────────────────────────────────────────────────── */

export interface WorkspaceStats {
  activeTasks: number;
  tasksNeedingReview: number;
  openQueue: number;
  inReview: number;
  disputed: number;
  verifiedTasks: number;
  totalTasks: number;
  /** share of claims across settled tasks that carry at least one source pointer */
  evidenceCoveragePct: number | null;
  evidenceCoverageSampleSize: number;
  /** wei, as a decimal string */
  bountiesSettledWei: Wei;
  bountiesEscrowedWei: Wei;
  medianVerificationSec: number | null;
  medianVerificationSampleSize: number;
  activeTasksTrendPct: number | null;
  evidenceCoverageTrendPct: number | null;
  bountiesSettledTrendPct: number | null;
}

/* ── GET /v1/tasks ───────────────────────────────────────────────────────── */

export interface TaskSummary {
  taskId: Bytes32;
  /** short human handle, e.g. PR-1048 — assigned in creation order */
  ref: string;
  title: string;
  question: string;
  primarySource: string | null;
  sourceCount: number;
  status: DisplayStatus;
  rawStatus: string;
  rawStatusCode: number;
  outcome: string;
  tone: Tone;
  creator: Address;
  bountyWei: Wei;
  bountyFormatted: string;
  verifierCount: number;
  committedCount: number;
  revealedCount: number;
  agreementLabel: string;
  agreementPct: number;
  claimCount: number;
  updatedAt: Iso;
  createdAt: Iso;
  commitDeadline: Iso | null;
  revealDeadline: Iso | null;
  disputeDeadline: Iso | null;
  manifestHash: Bytes32;
  manifestPointer: Pointer;
  resultHash: Bytes32 | null;
  hasDispute: boolean;
  syncRequired: boolean;
  tx: TxRef;
}

export interface TaskListQuery {
  status?: string;
  q?: string;
  creator?: Address;
  limit?: number;
  cursor?: string;
}

export interface TaskListResponse {
  items: TaskSummary[];
  nextCursor: string | null;
  total: number;
  counts: Record<string, number>;
}

/* ── GET /v1/tasks/:taskId ───────────────────────────────────────────────── */

export interface EvidenceSpan {
  uri: string;
  snapshotObjectId: string;
  contentHash: string;
  quotedSpan: string;
  score: number;
  retrievedAt: Iso;
}

export interface ClaimVerdictView {
  verifier: Address;
  verifierLabel: string;
  verdict: Verdict;
  confidence: number;
  reasoningSummary: string;
  sources: EvidenceSpan[];
}

export interface ClaimView {
  claimId: string;
  ordinal: string;
  claimText: string;
  majorityVerdict: Verdict | null;
  displayVerdict: "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT" | "PENDING";
  agreed: boolean;
  criticalConflict: boolean;
  confidencePct: number | null;
  evidenceCoverage: number | null;
  primarySourceLabel: string | null;
  excerpt: string | null;
  snapshotObjectId: string | null;
  retrievedAt: Iso | null;
  verdicts: ClaimVerdictView[];
}

export interface ReportView {
  verifier: Address;
  verifierLabel: string;
  committed: boolean;
  revealed: boolean;
  commitment: Bytes32 | null;
  reportHash: Bytes32 | null;
  reportPointer: Pointer | null;
  modelId: string | null;
  pipelineVersion: string | null;
  committedAt: Iso | null;
  revealedAt: Iso | null;
  supported: number | null;
  contradicted: number | null;
  insufficient: number | null;
  meanConfidence: number | null;
  computeProvider: string | null;
  computeLatencyMs: number | null;
  commitTx: TxRef;
  revealTx: TxRef;
}

export interface DisputeView {
  challenger: Address;
  bondWei: Wei;
  reason: string | null;
  evidenceHash: Bytes32;
  evidencePointer: Pointer;
  openedAt: Iso | null;
  deadline: Iso | null;
  resolved: boolean;
  upheld: boolean;
  decision: string | null;
  adjudicationHash: Bytes32 | null;
  adjudicationPointer: Pointer | null;
  tx: TxRef;
}

export interface TaskSource {
  sourceId: string;
  uri: string;
  status: string;
  contentHash: string;
  byteLength: number;
  snapshotPointer: Pointer;
  snapshotHash: Bytes32;
}

export interface TaskConsensus {
  outcome: ConsensusOutcome;
  agreementBps: number;
  conflicts: string[];
  rewardedVerifiers: Address[];
  resultHash: Bytes32;
  resultPointer: Pointer | null;
  evaluatedAt: Iso;
}

export interface TimelineEntry {
  at: Iso;
  label: string;
  detail: string;
  tx: TxRef;
}

export interface TaskAllocation {
  verifier: Address;
  amountWei: Wei;
}

export interface TaskDetail extends TaskSummary {
  manifest: unknown | null;
  sources: TaskSource[];
  claims: ClaimView[];
  reports: ReportView[];
  consensus: TaskConsensus | null;
  dispute: DisputeView | null;
  allocations: TaskAllocation[];
  timeline: TimelineEntry[];
}

/* ── POST /v1/tasks/prepare ──────────────────────────────────────────────── */

export type PrepareTaskSource = string | { uri: string } | { inlineText: string; label?: string };

export interface PrepareTaskRequest {
  /**
   * The wallet the manifest will name as creator. The API takes the acting
   * address from the session when there is one and from this field otherwise;
   * sending neither is a 401, which is why every caller sets it.
   */
  creator?: Address;
  title: string;
  question: string;
  answerText?: string | null;
  claims: string[];
  sources?: PrepareTaskSource[];
  verifierCount?: number;
  commitWindowSec?: number;
  revealWindowSec?: number;
  disputeWindowSec?: number;
  bountyWei: Wei;
}

export interface PreparedSource {
  sourceId: string;
  uri: string;
  status: string;
  contentHash: string;
  byteLength: number;
  snapshotPointer: Pointer;
  snapshotHash: Bytes32;
  error: string | null;
}

/** exactly what to pass to createTask, in tuple order */
export interface CreateTaskArgs {
  verifierCount: number;
  commitWindowSec: number;
  revealWindowSec: number;
  disputeWindowSec: number;
  manifestHash: Bytes32;
  manifestPointer: Pointer;
  ruleId: Bytes32;
  valueWei: Wei;
}

export interface PrepareTaskResponse {
  manifestId: string;
  manifestHash: Bytes32;
  manifestPointer: Pointer;
  manifest: unknown;
  ruleId: Bytes32;
  predictedTaskId: Bytes32;
  sources: PreparedSource[];
  warnings: string[];
  createTaskArgs: CreateTaskArgs;
}

/* ── POST /v1/tasks/:taskId/challenge ────────────────────────────────────── */

export interface PrepareChallengeRequest {
  /** Same rule as PrepareTaskRequest.creator: session first, this field otherwise. */
  challenger?: Address;
  reason: string;
  disputedClaims?: string[];
  additionalEvidence?: { uri: string; note?: string }[];
}

export interface PrepareChallengeResponse {
  evidenceHash: Bytes32;
  evidencePointer: Pointer;
  bondWei: Wei;
  evidence: unknown;
}

/* ── POST /v1/tasks/:taskId/sync ─────────────────────────────────────────── */

/**
 * The one response shape not yet in packages/schemas/src/api.ts; it is taken
 * verbatim from docs/research/FRONTEND_DATA_CONTRACT.md §2.
 */
export interface SyncResponse {
  taskId: Bytes32;
  scannedFrom: number;
  scannedTo: number;
  eventsProcessed: number;
  status: string;
  syncState: "OK" | "SYNC_REQUIRED";
}

/* ── GET /v1/verifiers ───────────────────────────────────────────────────── */

export type VerifierStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "PENDING";

export interface VerifierView {
  address: Address;
  name: string;
  shortAddress: string;
  role: string;
  modelId: string | null;
  pipelineVersion: string | null;
  registered: boolean;
  approved: boolean;
  active: boolean;
  status: VerifierStatus;
  tone: Tone;
  stakeWei: Wei;
  stakeFormatted: string;
  metadataHash: Bytes32;
  metadataPointer: Pointer;
  reportsRevealed: number;
  reportsCommitted: number;
  tasksSeen: number;
  agreementPct: number | null;
  uptimePct: number | null;
  /** reveal-rate per day over the last 24 buckets, 0..100; drives the uptime bars */
  uptimeSeries: number[];
  medianLatencyMs: number | null;
  lastSeenAt: Iso | null;
  pendingWithdrawalWei: Wei;
}

export interface VerifierSummary {
  active: number;
  online: number;
  degraded: number;
  networkAgreementPct: number | null;
  networkAgreementTrendPct: number | null;
  totalStakedWei: Wei;
  totalStakedFormatted: string;
  medianLatencyMs: number | null;
  slashingEnabled: boolean;
}

export interface VerifierEvent {
  label: string;
  operator: string;
  taskRef: string;
  taskId: Bytes32 | null;
  at: Iso;
  tone: Tone;
}

export interface VerifierListResponse {
  items: VerifierView[];
  summary: VerifierSummary;
  events: VerifierEvent[];
}

/* ── GET /v1/artifacts ───────────────────────────────────────────────────── */

export type ArtifactIcon = "json" | "text" | "check" | "image";

export interface ArtifactView {
  name: string;
  kind: string;
  typeLabel: string;
  taskRef: string;
  taskId: Bytes32 | null;
  objectId: string;
  pointer: Pointer;
  hash: string;
  shortHash: string;
  byteLength: number;
  sizeLabel: string;
  createdAt: Iso;
  driver: string;
  icon: ArtifactIcon;
  tone: Tone;
  storageExplorerUrl: string | null;
}

export interface ArtifactSummary {
  totalObjects: number;
  taskCount: number;
  totalBytes: number;
  totalSizeLabel: string;
  hashCoveragePct: number;
  driver: string;
  network: string;
}

export interface ArtifactListResponse {
  items: ArtifactView[];
  nextCursor: string | null;
  summary: ArtifactSummary;
  types: string[];
}

/* ── GET /v1/activity ────────────────────────────────────────────────────── */

export const ACTIVITY_CATEGORIES = ["Verification", "Storage", "Settlement", "Dispute", "Compute", "Registry"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export interface ActivityEvent {
  id: string;
  day: string;
  at: Iso;
  time: string;
  title: string;
  detail: string;
  actor: string;
  actorAddress: Address | null;
  taskRef: string;
  taskId: Bytes32 | null;
  category: ActivityCategory;
  icon: string;
  tone: Tone;
  hash: string;
  tx: TxRef;
  payload: unknown | null;
}

export interface ActivitySummary {
  eventsToday: number;
  eventsYesterday: number;
  trendPct: number | null;
  lastBlock: number | null;
  lastBlockAgeSec: number | null;
  openSignals: number;
  openSignalDetail: string;
}

export interface ActivityListResponse {
  items: ActivityEvent[];
  nextCursor: string | null;
  summary: ActivitySummary;
  categories: string[];
}

/* ── GET /health ─────────────────────────────────────────────────────────── */

export interface DependencyHealth {
  ok: boolean;
  detail: string | null;
  latencyMs: number | null;
}

export interface IndexerHealth {
  running: boolean;
  lastError: string | null;
  processedEvents: number;
  lastBlock: number | null;
  headBlock: number | null;
  lagBlocks: number | null;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  chainId: number;
  contract: Address;
  network: string;
  explorer: string;
  storageExplorer: string;
  drivers: { storage: string; compute: string };
  dependencies: Record<string, DependencyHealth>;
  indexer: IndexerHealth;
  queue: Record<string, number>;
  paused: boolean;
}

/* ── GET /v1/reports/:reportHash ─────────────────────────────────────────── */

export interface ReportFetchResponse {
  reportHash: Bytes32;
  verified: boolean;
  source: "storage" | "cache";
  pointer: Pointer | null;
  report: unknown;
}

/* ── auth ────────────────────────────────────────────────────────────────── */

export interface NonceRequest {
  address: Address;
}

export interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: Iso;
}

export interface VerifyRequest {
  address: Address;
  signature: Hex;
  nonce: string;
}

export interface VerifyResponse {
  token: string;
  address: Address;
  expiresAt: Iso;
}

/* ── errors (packages/schemas/src/errors.ts) ─────────────────────────────── */

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "PERSONAL_DATA_REJECTED",
  "SOURCE_UNAVAILABLE",
  "SOURCE_BLOCKED",
  "SOURCE_TOO_LARGE",
  "STORAGE_UNAVAILABLE",
  "STORAGE_UPLOAD_FAILED",
  "CONTENT_HASH_MISMATCH",
  "COMPUTE_UNAVAILABLE",
  "COMPUTE_TIMEOUT",
  "COMPUTE_INVALID_OUTPUT",
  "CHAIN_UNAVAILABLE",
  "CHAIN_REVERTED",
  "TASK_NOT_FOUND",
  "REPORT_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "SYNC_REQUIRED",
  "UNAUTHORIZED",
  "NONCE_INVALID",
  "SIGNATURE_INVALID",
  "SESSION_EXPIRED",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "NOT_CONFIGURED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The exact envelope ProofRelayError.toJSON() produces on the wire. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    detail: Record<string, unknown> | null;
  };
}
