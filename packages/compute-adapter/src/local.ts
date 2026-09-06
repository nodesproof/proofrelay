import { objectHash } from "@proofrelay/schemas";
import { type FallbackReason, judge, scoreSpan, splitSpans, tokenize } from "./entailment.js";
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
 * The `limit` spans a claim is judged against: one per source first, then the
 * best of the rest.
 *
 * Source diversity comes first because it is what makes evidence overlap
 * meaningful downstream — two verifiers that both cite the changelog and the
 * README agree on more than two that both quote the changelog twice. So while
 * there are sources left unrepresented, every slot goes to a new one, and a
 * task with at least `limit` sources behaves exactly as it always did.
 *
 * What changed is the case underneath. Taking ONLY the best span per source
 * meant a task naming one document showed the model exactly one paragraph of
 * it, whatever `evidenceDepth` said — so depth was inert for the commonest
 * shape of task, and a claim was judged against a paragraph that merely scored
 * highest rather than the one that answers it. On mainnet task 0xaca56aee…
 * every verifier was handed RFC 2119's definition of MUST and asked about
 * MUST NOT; they answered correctly about the wrong paragraph. Once each source
 * has a seat, the remaining slots go to the strongest spans from anywhere.
 */
export function selectSpans(
  claimText: string,
  corpus: EvidenceScoringInput["corpus"],
  limit: number,
): EvidenceSpanResult[] {
  const slots = Math.max(1, limit);
  // Ties broken by contentHash then offset: a report is hashed and replayed, so
  // the ordering must never depend on corpus order or on sort stability.
  const strongest = (a: EvidenceSpanResult, b: EvidenceSpanResult) =>
    b.score - a.score || a.contentHash.localeCompare(b.contentHash) || a.spanStart - b.spanStart;

  const perSource: EvidenceSpanResult[][] = [];
  for (const entry of corpus) {
    const scored: EvidenceSpanResult[] = [];
    for (const span of splitSpans(entry.text)) {
      scored.push({
        sourceId: entry.sourceId,
        uri: entry.uri,
        snapshotObjectId: entry.snapshotObjectId,
        contentHash: entry.contentHash,
        quotedSpan: span.text,
        spanStart: span.start,
        spanEnd: span.end,
        score: scoreSpan(claimText, span.text),
        retrievedAt: entry.retrievedAt,
      });
    }
    scored.sort(strongest);
    // Retain more than the budget per source: the overlap filter below discards
    // candidates, and trimming to `slots` first left it nothing to fall back on
    // — a single-source claim came back with one span instead of three.
    if (scored.length > 0) perSource.push(scored.slice(0, Math.max(slots * 8, 32)));
  }

  const leaders = perSource.map((spans) => spans[0]!).sort(strongest);
  const chosen = leaders.slice(0, slots);
  if (chosen.length < slots) {
    // `splitSpans` emits a two-sentence window starting at EVERY sentence, so
    // consecutive candidates always share a sentence and near-duplicates score
    // near-identically. Filling by score alone therefore spends the budget on
    // one neighbourhood: on mainnet task 0x88218974… claim-002 drew windows
    // 17651-17784 and 17717-17818, two overlapping views of RFC 9309 §2.3.1.4's
    // first paragraph, while the paragraph that follows it — the one carrying
    // the "crawlers MAY … continue to use a cached copy" qualification — never
    // entered any model's context. The verdict was faithful to what it was
    // shown and silent about what it was not.
    //
    // A slot spent on text already visible buys nothing. Require new text.
    const rest = perSource.flatMap((spans) => spans.slice(1)).sort(strongest);

    // One slot is reserved for whatever comes NEXT after the best match, when
    // there is room for it. Normative documents put the exception after the
    // rule — RFC 9309 §2.3.1.4 states the MUST, then qualifies it in the
    // following paragraph — and lexical scoring cannot see that, because the
    // qualification restates none of the claim's words. It is the one span the
    // claim's own wording guarantees will score badly and the reader most needs.
    // Reserved rather than hoped for: on a multi-source task the leaders have
    // already taken every slot, so this only spends one where nothing else was
    // going to.
    const top = chosen[0];
    if (top && chosen.length < slots) {
      let following;
      for (const span of rest) {
        if (span.contentHash !== top.contentHash || span.spanStart < top.spanEnd) continue;
        if (!following || span.spanStart < following.spanStart) following = span;
      }
      if (following) chosen.push(following);
    }
    for (const span of rest) {
      if (chosen.length >= slots) break;
      const overlapsChosen = chosen.some(
        (taken) =>
          taken.contentHash === span.contentHash &&
          span.spanStart < taken.spanEnd &&
          taken.spanStart < span.spanEnd,
      );
      if (overlapsChosen) continue;
      chosen.push(span);
    }
    // Preferring new text must never mean showing the model LESS. When a source
    // is short enough that everything overlaps something already taken, fall
    // back to filling by score, exactly as before.
    if (chosen.length < slots) {
      for (const span of rest) {
        if (chosen.length >= slots) break;
        if (chosen.includes(span)) continue;
        chosen.push(span);
      }
    }
  }
  return chosen.sort(strongest);
}

/**
 * Scores one claim against the corpus, offline.
 */
export function scoreClaim(
  claim: ExtractedClaim,
  corpus: EvidenceScoringInput["corpus"],
  depth: number,
  supportThreshold: number,
  /** Standing in for a model rather than serving as the chosen engine, and why. */
  conservative: FallbackReason | false = false,
): ClaimScoringResult {
  const sources = selectSpans(claim.claimText, corpus, depth);
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
