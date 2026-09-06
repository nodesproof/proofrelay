import { objectHash } from "@proofrelay/schemas";
import { judge, scoreSpan, splitSpans, tokenize } from "./entailment.js";
import type {
  ClaimExtractionInput,
  ClaimScoringResult,
  ComputeAdapter,
  ComputeResult,
  DependencyHealth,
  EvidenceScoringInput,
  EvidenceSpanResult,
  ExtractedClaim,
} from "./types.js";

export const PIPELINE_VERSION = "0.1.0";

export interface LocalComputeOptions {
  evidenceDepth?: number;
  supportThreshold?: number;
}

/**
 * The offline driver. Its modelId encodes the two knobs that make verifier A
 * and verifier B different pipelines rather than the same one run twice, so a
 * report always records which configuration produced it.
 */
export class LocalComputeAdapter implements ComputeAdapter {
  readonly driver = "local";
  readonly pipelineVersion = PIPELINE_VERSION;
  private readonly evidenceDepth: number;
  private readonly supportThreshold: number;

  constructor(options: LocalComputeOptions = {}) {
    this.evidenceDepth = options.evidenceDepth ?? 2;
    this.supportThreshold = options.supportThreshold ?? 0.55;
  }

  get modelId(): string {
    return `local-entailment/${this.evidenceDepth}-${this.supportThreshold}`;
  }

  async runClaimExtraction(input: ClaimExtractionInput): Promise<ComputeResult<ExtractedClaim[]>> {
    const started = Date.now();
    const inputHash = objectHash({
      op: "claim-extraction",
      question: input.question,
      answerText: input.answerText,
      corpus: input.corpus.map((entry) => entry.contentHash),
      maxClaims: input.maxClaims,
    });

    // Without a model, "extraction" means taking the declarative sentences the
    // creator actually wrote and treating each as a claim. It never invents a
    // claim from the sources — a claim nobody asserted is not evidence of
    // anything, and inventing one would put words in the creator's mouth.
    const source = input.answerText?.trim() ? input.answerText : input.question;
    const claims = splitSpans(source, 1)
      .map((span) => span.text.trim())
      .filter((text) => tokenize(text).length >= 3)
      .slice(0, input.maxClaims)
      .map((claimText, index) => ({
        claimId: `claim-${String(index + 1).padStart(3, "0")}`,
        claimText,
      }));

    return {
      value: claims,
      trace: {
        requestId: `local-${inputHash.slice(2, 18)}`,
        operation: "claim-extraction",
        provider: this.driver,
        modelId: this.modelId,
        pipelineVersion: this.pipelineVersion,
        inputHash,
        outputHash: objectHash(claims),
        latencyMs: Date.now() - started,
        attempts: 1,
        verified: false,
        rawArtifactPointer: null,
      },
    };
  }

  async scoreEvidence(input: EvidenceScoringInput): Promise<ComputeResult<ClaimScoringResult[]>> {
    const started = Date.now();
    const depth = input.evidenceDepth ?? this.evidenceDepth;
    const threshold = input.supportThreshold ?? this.supportThreshold;
    const inputHash = objectHash({
      op: "evidence-scoring",
      claims: input.claims,
      corpus: input.corpus.map((entry) => entry.contentHash),
      depth,
      threshold,
    });

    const results = input.claims.map((claim) => scoreClaim(claim, input.corpus, depth, threshold));

    return {
      value: results,
      trace: {
        requestId: `local-${inputHash.slice(2, 18)}`,
        operation: "evidence-scoring",
        provider: this.driver,
        modelId: this.modelId,
        pipelineVersion: this.pipelineVersion,
        inputHash,
        outputHash: objectHash(results),
        latencyMs: Date.now() - started,
        attempts: 1,
        verified: false,
        rawArtifactPointer: null,
      },
    };
  }

  async health(): Promise<DependencyHealth> {
    return { ok: true, detail: "deterministic offline engine", latencyMs: 0 };
  }
}

/**
 * Best span per source, then the best `depth` of those overall. Keeping one
 * span per source rather than the top-N globally is what makes evidence overlap
 * meaningful downstream: two verifiers that both cite the changelog and the
 * README agree on more than two that both quote the changelog twice.
 */
export function scoreClaim(
  claim: ExtractedClaim,
  corpus: EvidenceScoringInput["corpus"],
  depth: number,
  supportThreshold: number,
  /** Standing in for a model rather than serving as the chosen engine. */
  conservative = false,
): ClaimScoringResult {
  const perSource: EvidenceSpanResult[] = [];

  for (const entry of corpus) {
    let best: EvidenceSpanResult | null = null;
    for (const span of splitSpans(entry.text)) {
      const score = scoreSpan(claim.claimText, span.text);
      if (!best || score > best.score) {
        best = {
          sourceId: entry.sourceId,
          uri: entry.uri,
          snapshotObjectId: entry.snapshotObjectId,
          contentHash: entry.contentHash,
          quotedSpan: span.text,
          spanStart: span.start,
          spanEnd: span.end,
          score,
          retrievedAt: entry.retrievedAt,
        };
      }
    }
    if (best) perSource.push(best);
  }

  // Ties broken by contentHash so the ordering never depends on corpus order.
  perSource.sort((a, b) => b.score - a.score || a.contentHash.localeCompare(b.contentHash));
  const sources = perSource.slice(0, Math.max(1, depth));
  const top = sources[0];

  const judgement = top
    ? judge({
        claim: claim.claimText,
        bestSpan: top.quotedSpan,
        bestScore: top.score,
        supportThreshold,
        conservative,
      })
    : {
        verdict: "INSUFFICIENT_EVIDENCE" as const,
        confidence: 0.25,
        reasoningSummary: "No snapshot was available for this task, so the claim has no evidence at all.",
      };

  return {
    claimId: claim.claimId,
    claimText: claim.claimText,
    verdict: judgement.verdict,
    confidence: judgement.confidence,
    reasoningSummary: judgement.reasoningSummary,
    sources: top ? sources : [],
    // Only when standing in for a model. As the chosen engine there is nothing
    // degraded about this result.
    ...(conservative ? { degraded: true } : {}),
  };
}
