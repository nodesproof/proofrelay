/**
 * The six 0G Storage object types (architecture doc §10.1).
 *
 * These schemas are pinned against the artifacts already sitting in
 * `.proofrelay/storage/` — every field name and nesting level here matches an
 * object that was really produced, uploaded and hashed. Changing a field name
 * changes the content hash, which is why they are versioned rather than edited.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0";

export const ArtifactKind = z.enum([
  "source-snapshot",
  "task-manifest",
  "verifier-report",
  "consensus-result",
  "challenge-evidence",
  "adjudication-report",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Verdict = z.enum(["SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE"]);
export type Verdict = z.infer<typeof Verdict>;

export const SourceStatus = z.enum(["OK", "SOURCE_UNAVAILABLE", "TRUNCATED", "REJECTED"]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const ConsensusOutcome = z.enum(["CONSENSUS", "CONFLICT", "NO_QUORUM"]);
export type ConsensusOutcome = z.infer<typeof ConsensusOutcome>;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<hex>");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");
const isoDate = z.string().datetime();

/* ── source-snapshot ─────────────────────────────────────────────────────── */

export const SourceSnapshot = z.object({
  kind: z.literal("source-snapshot"),
  schemaVersion: z.string(),
  producer: z.string(),
  sourceId: z.string(),
  uri: z.string(),
  status: SourceStatus,
  httpStatus: z.number().int().nullable(),
  contentType: z.string().nullable(),
  headers: z.record(z.string()),
  text: z.string(),
  byteLength: z.number().int().nonnegative(),
  contentHash: sha256,
  truncated: z.boolean(),
  error: z.string().nullable(),
  retrievedAt: isoDate,
});
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

/* ── task-manifest ───────────────────────────────────────────────────────── */

export const ManifestClaim = z.object({
  claimId: z.string(),
  claimText: z.string(),
  origin: z.enum(["creator", "extraction"]),
});
export type ManifestClaim = z.infer<typeof ManifestClaim>;

export const ManifestSource = z.object({
  sourceId: z.string(),
  uri: z.string(),
  status: SourceStatus,
  contentHash: sha256,
  byteLength: z.number().int().nonnegative(),
  snapshotHash: hex32,
  snapshotPointer: z.string(),
});
export type ManifestSource = z.infer<typeof ManifestSource>;

export const TaskPolicy = z.object({
  verifierCount: z.number().int().min(2).max(16),
  commitWindowSec: z.number().int().positive(),
  revealWindowSec: z.number().int().positive(),
  disputeWindowSec: z.number().int().positive(),
  maxEvidencePerClaim: z.number().int().positive(),
  ruleId: hex32,
});
export type TaskPolicy = z.infer<typeof TaskPolicy>;

export const TaskManifest = z.object({
  kind: z.literal("task-manifest"),
  schemaVersion: z.string(),
  producer: z.string(),
  manifestId: z.string(),
  chainId: z.number().int(),
  creator: address,
  title: z.string(),
  question: z.string(),
  answerText: z.string().nullable(),
  claims: z.array(ManifestClaim).min(1).max(50),
  sources: z.array(ManifestSource).max(20),
  extraction: z
    .object({
      modelId: z.string(),
      pipelineVersion: z.string(),
      requestId: z.string(),
      outputHash: hex32,
    })
    .nullable(),
  policy: TaskPolicy,
  safety: z.object({
    publicDataOnly: z.boolean(),
    redactions: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  createdAt: isoDate,
});
export type TaskManifest = z.infer<typeof TaskManifest>;

/* ── verifier-report ─────────────────────────────────────────────────────── */

export const EvidenceSource = z.object({
  uri: z.string(),
  snapshotObjectId: z.string(),
  contentHash: sha256,
  quotedSpan: z.string(),
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().nonnegative(),
  score: z.number(),
  retrievedAt: isoDate,
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const VerifierIdentity = z.object({
  address: address,
  verifierId: z.string(),
  modelId: z.string(),
  pipelineVersion: z.string(),
});
export type VerifierIdentity = z.infer<typeof VerifierIdentity>;

/** One row of the evidence schema in PRD §10. */
export const ClaimEvidence = z.object({
  taskId: hex32,
  claimId: z.string(),
  claimText: z.string(),
  verdict: Verdict,
  confidence: z.number().min(0).max(1),
  sources: z.array(EvidenceSource),
  verifier: VerifierIdentity,
  reasoningSummary: z.string(),
  /**
   * This verdict came from the offline scorer, not from the model named above.
   *
   * Optional so every report written before this field existed still parses.
   * Absent and `false` mean the same thing; only `true` is a claim about the
   * verdict's provenance.
   *
   * `verifier.modelId` reports the whole call and cannot express this: a report
   * can name the router truthfully while one of its verdicts never reached it.
   * Consensus reads this field, so a degraded verdict neither counts toward
   * agreement nor earns a share of the bounty.
   */
  degraded: z.boolean().optional(),
  createdAt: isoDate,
});
export type ClaimEvidence = z.infer<typeof ClaimEvidence>;

export const ComputeTrace = z.object({
  requestId: z.string(),
  operation: z.enum(["claim-extraction", "evidence-scoring"]),
  provider: z.string(),
  modelId: z.string(),
  pipelineVersion: z.string(),
  inputHash: hex32,
  outputHash: hex32,
  latencyMs: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  // Strictly per-response: "the router affirmed, for THIS completion, that the
  // provider's TEE attestation verified". `attestation` below is a weaker,
  // separate claim and must never be folded into this flag.
  verified: z.boolean(),
  /**
   * What the router's provider directory says about the machine that served
   * this request. It is a claim ABOUT A PROVIDER, not a proof about this
   * response: it arrives over the same TLS session as the completion, from the
   * same router, and may have been read at a different moment. A reader
   * weighing a report should treat it as attribution, not as verification —
   * that is why it is not `verified`.
   *
   * Optional so reports written before this field existed still validate.
   */
  attestation: z
    .object({
      verifiability: z.string(),
      teeType: z.string(),
      teeVerifier: z.string(),
      source: z.literal("router-directory"),
    })
    .nullable()
    .optional(),
  rawArtifactPointer: z.string().nullable(),
});
export type ComputeTrace = z.infer<typeof ComputeTrace>;

export const EvidenceGraph = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["claim", "evidence", "source"]),
      label: z.string(),
      // A source node carries neither: it is the thing being cited, not a
      // judgement about it. The producer writes them as explicit nulls, so a
      // reader can tell "no opinion" from "field missing"; they are optional
      // here only so a report written by an older producer still validates
      // rather than being discarded as untrusted.
      confidence: z.number().nullable().optional(),
      verdict: Verdict.nullable().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      type: z.enum(["supports", "contradicts", "insufficient", "cites"]),
      weight: z.number(),
    }),
  ),
});
export type EvidenceGraph = z.infer<typeof EvidenceGraph>;

export const VerifierReport = z.object({
  kind: z.literal("verifier-report"),
  schemaVersion: z.string(),
  taskId: hex32,
  manifestHash: hex32,
  manifestPointer: z.string(),
  verifier: VerifierIdentity,
  claims: z.array(ClaimEvidence),
  graph: EvidenceGraph,
  compute: z.array(ComputeTrace),
  summary: z.object({
    supported: z.number().int().nonnegative(),
    contradicted: z.number().int().nonnegative(),
    insufficient: z.number().int().nonnegative(),
    meanConfidence: z.number(),
    evidenceCoverage: z.number(),
  }),
  createdAt: isoDate,
});
export type VerifierReport = z.infer<typeof VerifierReport>;

/* ── consensus-result ────────────────────────────────────────────────────── */

export const ClaimConsensus = z.object({
  claimId: z.string(),
  claimText: z.string(),
  majorityVerdict: Verdict,
  agreed: z.boolean(),
  criticalConflict: z.boolean(),
  evidenceCoverage: z.number(),
  evidenceOverlap: z.number(),
  agreeingVerifiers: z.array(address),
  dissentingVerifiers: z.array(address),
  verdicts: z.array(
    z.object({ verifier: address, verdict: Verdict, confidence: z.number() }),
  ),
  reason: z.string(),
});
export type ClaimConsensus = z.infer<typeof ClaimConsensus>;

export const ConsensusResult = z.object({
  kind: z.literal("consensus-result"),
  schemaVersion: z.string(),
  producer: z.string(),
  taskId: hex32,
  manifestHash: hex32,
  ruleId: hex32,
  outcome: ConsensusOutcome,
  agreementBps: z.number().int().min(0).max(10_000),
  claims: z.array(ClaimConsensus),
  conflicts: z.array(z.string()),
  reportHashes: z.array(hex32),
  rewardedVerifiers: z.array(address),
  evaluatedAt: isoDate,
});
export type ConsensusResult = z.infer<typeof ConsensusResult>;

/* ── challenge-evidence ──────────────────────────────────────────────────── */

export const ChallengeEvidence = z.object({
  kind: z.literal("challenge-evidence"),
  schemaVersion: z.string(),
  taskId: hex32,
  challenger: address,
  reason: z.string().min(1).max(2000),
  disputedClaims: z.array(z.string()),
  disputedReportHashes: z.array(hex32),
  additionalEvidence: z.array(
    z.object({ uri: z.string(), contentHash: sha256, note: z.string() }),
  ),
  createdAt: isoDate,
});
export type ChallengeEvidence = z.infer<typeof ChallengeEvidence>;

/* ── adjudication-report ─────────────────────────────────────────────────── */

export const AdjudicationReport = z.object({
  kind: z.literal("adjudication-report"),
  schemaVersion: z.string(),
  taskId: hex32,
  challengeHash: hex32,
  adjudicator: address,
  upheld: z.boolean(),
  decision: z.string(),
  claims: z.array(ClaimEvidence),
  compute: z.array(ComputeTrace),
  revisedRewardedVerifiers: z.array(address),
  createdAt: isoDate,
});
export type AdjudicationReport = z.infer<typeof AdjudicationReport>;

/* ── discriminated union ─────────────────────────────────────────────────── */

export const Artifact = z.discriminatedUnion("kind", [
  SourceSnapshot,
  TaskManifest,
  VerifierReport,
  ConsensusResult,
  ChallengeEvidence,
  AdjudicationReport,
]);
export type Artifact = z.infer<typeof Artifact>;

const BY_KIND = {
  "source-snapshot": SourceSnapshot,
  "task-manifest": TaskManifest,
  "verifier-report": VerifierReport,
  "consensus-result": ConsensusResult,
  "challenge-evidence": ChallengeEvidence,
  "adjudication-report": AdjudicationReport,
} as const;

/**
 * Verifier and adjudicator output is untrusted input (threat model: "Verifier
 * worker — No"). Everything read back from storage goes through this.
 */
export function parseArtifact(kind: ArtifactKind, value: unknown): Artifact {
  return BY_KIND[kind].parse(value) as Artifact;
}
