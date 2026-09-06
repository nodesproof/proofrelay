import type { ComputeTrace, Verdict } from "@proofrelay/schemas";

/** A snapshot as the compute layer sees it: identity plus the text to search. */
export interface EvidenceCorpusEntry {
  sourceId: string;
  uri: string;
  snapshotObjectId: string;
  contentHash: string;
  text: string;
  retrievedAt: string;
}

export interface ClaimExtractionInput {
  question: string;
  answerText: string | null;
  corpus: EvidenceCorpusEntry[];
  maxClaims: number;
}

export interface ExtractedClaim {
  claimId: string;
  claimText: string;
}

export interface EvidenceSpanResult {
  sourceId: string;
  uri: string;
  snapshotObjectId: string;
  contentHash: string;
  quotedSpan: string;
  spanStart: number;
  spanEnd: number;
  score: number;
  retrievedAt: string;
}

export interface ClaimScoringResult {
  claimId: string;
  claimText: string;
  verdict: Verdict;
  confidence: number;
  reasoningSummary: string;
  sources: EvidenceSpanResult[];
  /**
   * This one claim was scored offline because the model's answer for it could
   * not be used — a verdict outside the accepted literals, an unusable span
   * index, a confidence out of range — or because the whole call fell back.
   *
   * Report-level `provider` only records the second case, so before this a
   * per-claim fallback was invisible: the report named the router while one of
   * its verdicts had never reached it.
   */
  degraded?: boolean;
}

export interface EvidenceScoringInput {
  claims: ExtractedClaim[];
  corpus: EvidenceCorpusEntry[];
  /** How many spans to keep per claim. */
  evidenceDepth: number;
  /** Entailment score above which a span counts as support. */
  supportThreshold: number;
}

export interface ComputeResult<T> {
  value: T;
  trace: ComputeTrace;
}

export interface DependencyHealth {
  ok: boolean;
  detail: string | null;
  latencyMs: number | null;
}

/** Architecture doc §11. */
export interface ComputeAdapter {
  readonly driver: string;
  readonly modelId: string;
  readonly pipelineVersion: string;
  runClaimExtraction(input: ClaimExtractionInput): Promise<ComputeResult<ExtractedClaim[]>>;
  scoreEvidence(input: EvidenceScoringInput): Promise<ComputeResult<ClaimScoringResult[]>>;
  health(): Promise<DependencyHealth>;
}
