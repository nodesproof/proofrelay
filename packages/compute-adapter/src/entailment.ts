/**
 * The deterministic entailment engine.
 *
 * This is the reference pipeline: no network, no model weights, no randomness.
 * It exists for three reasons. It is what the tests assert against, so a
 * verifier's behaviour is pinned. It is what keeps a demo alive when 0G Compute
 * is unreachable — the runbook's `COMPUTE_DRIVER=local` escape hatch. And it
 * gives the LLM drivers a scoring baseline to fall back to when a model returns
 * something that does not parse, so a malformed completion degrades to a
 * conservative verdict instead of an invented one.
 *
 * The scoring is lexical on purpose. It cannot understand a paraphrase, and it
 * does not claim to: it finds the span of a snapshot that most overlaps the
 * claim, then asks whether the *factual* tokens in the claim — numbers, dates,
 * versions — actually appear in that span. A claim whose subject matches but
 * whose numbers differ is CONTRADICTED, which is the case a purely semantic
 * similarity score gets wrong most often.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "has", "have", "had",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "as", "into", "about", "over", "after",
  "it", "its", "their", "there", "they", "he", "she", "we", "you", "i", "his", "her", "our", "your",
  "not", "no", "so", "such", "can", "will", "would", "should", "may", "might", "must", "shall",
]);

/**
 * A version reads the same with or without its `v`, and a plural or past tense
 * is the same word for the purpose of overlap. Without this "1.4.0" in a claim
 * would fail to match "v1.4.0" in the snapshot that states it, which is the
 * single most common way this scorer would be wrong.
 */
function normalizeToken(token: string): string {
  const stripped = token.replace(/^[.\-/]+|[.\-/]+$/g, "");
  if (/^v\d/.test(stripped)) return stripped.slice(1);
  if (/^\d/.test(stripped)) return stripped;
  return stripped.replace(/(?:ed|es|s)$/, "");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\-/%]+/gu, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * Tokens that carry a fact rather than a topic: versions, dates, quantities,
 * identifiers. Two statements about the same subject that disagree on one of
 * these are contradicting each other, not merely differing in wording.
 *
 * Matches are consumed left to right and the consumed span is blanked out, so
 * "v1.4.0" contributes the fact `1.4.0` and not also the bare numbers 1, 4 and
 * 0 — that pollution used to make every version look like a partial match for
 * every other.
 */
export function factualTokens(text: string): string[] {
  const facts = new Set<string>();
  let remaining = text.toLowerCase();

  const consume = (pattern: RegExp, transform: (match: RegExpExecArray) => string | null) => {
    remaining = remaining.replace(pattern, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      const value = transform(match);
      if (value) facts.add(value);
      return " ".repeat(String(args[0]).length);
    });
  };

  // Most specific first; each pass blanks what it took.
  consume(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/g,
    (match) => {
      const month = MONTHS[match[1]!];
      return month ? `${match[3]}-${month}-${match[2]!.padStart(2, "0")}` : null;
    },
  );
  consume(/\b\d{4}-\d{2}-\d{2}\b/g, (match) => match[0]!);
  consume(/\bv?\d+\.\d+(?:\.\d+)+\b/g, (match) => match[0]!.replace(/^v/, ""));
  consume(/\bv?\d+\.\d+\s*%/g, (match) => `${match[0]!.replace(/^v/, "").replace(/\s*%$/, "")}%`);
  consume(/\b\d+\s*%/g, (match) => `${match[0]!.replace(/\s*%$/, "")}%`);
  consume(/\bv\d+(?:\.\d+)?\b/g, (match) => match[0]!.slice(1));
  consume(/\b\d+(?:,\d{3})+\b/g, (match) => match[0]!.replace(/,/g, ""));
  consume(/\b\d+\.\d+\b/g, (match) => match[0]!);
  consume(/\b\d+\b/g, (match) => match[0]!);

  return [...facts].sort();
}

/** The facts a piece of text asserts, in a comparable normal form. */
export function normalizeFacts(text: string): Set<string> {
  return new Set(factualTokens(text));
}

export interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * Sentence-ish windows. Snapshots are markdown and prose, so paragraph breaks
 * and sentence ends both matter; a window of two adjacent sentences catches the
 * common "heading then value" shape without diluting the score.
 *
 * A period only ends a sentence when whitespace or the end of the text follows
 * it. Without that rule "version 1.4.0" splits into three sentences and the
 * fact it states never appears in any single span, and "Node.js 20" loses its
 * subject — both of which this engine exists to get right.
 */
export function splitSpans(text: string, windowSize = 2): Span[] {
  const pieces: Span[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1] ?? "";
    const isTerminator =
      char === "\n" ||
      ((char === "." || char === "!" || char === "?") && (next === "" || /[\s)\]"']/.test(next)));
    if (!isTerminator && i !== text.length - 1) continue;

    let end = i + 1;
    while (end < text.length && /[.!?\n]/.test(text[end]!)) end += 1;
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const offset = start + raw.indexOf(trimmed);
      pieces.push({ text: trimmed, start: offset, end: offset + trimmed.length });
    }
    start = end;
    i = end - 1;
  }

  if (pieces.length === 0) {
    const trimmed = text.trim();
    return trimmed ? [{ text: trimmed, start: text.indexOf(trimmed), end: text.indexOf(trimmed) + trimmed.length }] : [];
  }

  const spans: Span[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const window = pieces.slice(i, i + windowSize);
    const first = window[0]!;
    const last = window[window.length - 1]!;
    spans.push({ text: text.slice(first.start, last.end).trim(), start: first.start, end: last.end });
  }
  return spans;
}

/**
 * Overlap of the claim's content tokens with the span's, weighted so a factual
 * token counts double: matching "1.4.0" says far more than matching "release".
 * Facts are compared in their normal form, so an ISO date in a claim matches a
 * written date in the source that states it.
 */
export function scoreSpan(claim: string, span: string): number {
  const claimTokens = tokenize(claim);
  const claimFacts = normalizeFacts(claim);
  if (claimTokens.length === 0 && claimFacts.size === 0) return 0;

  const spanTokens = new Set(tokenize(span));
  const spanFacts = normalizeFacts(span);

  let weight = 0;
  let matched = 0;

  for (const fact of claimFacts) {
    weight += 2;
    if (spanFacts.has(fact)) matched += 2;
  }
  for (const token of claimTokens) {
    // A token that is itself a fact was already counted above.
    if (claimFacts.has(token)) continue;
    weight += 1;
    if (spanTokens.has(token) || spanFacts.has(token)) matched += 1;
  }
  if (weight === 0) return 0;

  const coverage = matched / weight;
  // A long span that happens to contain the claim's words is weaker evidence
  // than a tight one, so divide by a gentle length penalty rather than a hard cap.
  const spanLength = Math.max(1, tokenize(span).length);
  const density = Math.min(1, Math.max(claimTokens.length, 1) / spanLength);
  return coverage * (0.75 + 0.25 * density);
}

export type FactKind = "date" | "version" | "percentage" | "number";

/** Two facts only contradict each other if they are the same kind of fact. */
export function factKind(fact: string): FactKind {
  if (/^\d{4}-\d{2}-\d{2}$/.test(fact)) return "date";
  if (/^\d+\.\d+\.\d+/.test(fact)) return "version";
  if (fact.endsWith("%")) return "percentage";
  return "number";
}

export interface FactualComparison {
  /** Facts asserted by the claim that the span also asserts. */
  matched: string[];
  /** Facts the span states a different value for, of the same kind. */
  contradicted: string[];
  /** Facts the claim asserts that the span simply does not mention. */
  unconfirmed: string[];
  /** 0..1 — share of the claim's facts the span confirms. */
  overlap: number;
}

/**
 * A claim's facts against a span's.
 *
 * The distinction that matters is between a fact the span *disagrees* with and
 * one it merely does not mention. "Version 2.0.0" against a span that says
 * "v1.4.0" is a contradiction — the span states a version, and it is a
 * different one. "Version 2.0.0" against a span that mentions no version at all
 * is only unconfirmed. Collapsing those two into "not matched" is how a
 * scorer ends up calling a plain absence of evidence a contradiction.
 */
export function compareFacts(claim: string, span: string): FactualComparison {
  const claimFacts = normalizeFacts(claim);
  const spanFacts = normalizeFacts(span);
  if (claimFacts.size === 0) {
    return { matched: [], contradicted: [], unconfirmed: [], overlap: 0 };
  }

  const spanByKind = new Map<FactKind, Set<string>>();
  for (const fact of spanFacts) {
    const kind = factKind(fact);
    if (!spanByKind.has(kind)) spanByKind.set(kind, new Set());
    spanByKind.get(kind)!.add(fact);
  }

  const matched: string[] = [];
  const contradicted: string[] = [];
  const unconfirmed: string[] = [];
  for (const fact of claimFacts) {
    if (spanFacts.has(fact)) {
      matched.push(fact);
      continue;
    }
    const sameKind = spanByKind.get(factKind(fact));
    if (sameKind && sameKind.size > 0) contradicted.push(fact);
    else unconfirmed.push(fact);
  }
  return {
    matched: matched.sort(),
    contradicted: contradicted.sort(),
    unconfirmed: unconfirmed.sort(),
    overlap: matched.length / claimFacts.size,
  };
}

export type LocalVerdict = "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE";

export interface Judgement {
  verdict: LocalVerdict;
  confidence: number;
  reasoningSummary: string;
}

/**
 * Confidence is a stated function of the score, not a model's self-report, so
 * two runs of the same pipeline over the same snapshot produce the same number.
 * The curves are deliberately conservative: nothing reaches 1.0, and a claim
 * that fails the threshold cannot look confident.
 */
/**
 * Why a claim fell back to lexical scoring.
 *
 * Named rather than boolean because the reason is published, in the report the
 * verifier anchors onchain. The first version of this said "the compute call
 * failed" for every fallback, which is true of only one of the four: the other
 * three happen when the model DID answer and the driver refused the row. On
 * mainnet task 0xe95f50b2… a verifier scored one claim with its model and fell
 * back on the other, and the artifact blamed a call that had plainly worked.
 * An evidence market cannot publish the wrong reason for its own degradation.
 */
export type FallbackReason =
  | "call-failed"
  | "unusable-verdict"
  | "unusable-citations"
  | "unusable-confidence";

const FALLBACK_CAUSE: Record<FallbackReason, string> = {
  "call-failed": "the compute call failed",
  "unusable-verdict": "the model answered with a verdict outside the three this pipeline accepts",
  "unusable-citations":
    "the model cited a span that does not exist, or asserted a verdict while citing none",
  "unusable-confidence": "the model returned a confidence that is not a number between 0 and 1",
};

export function judge(args: {
  claim: string;
  bestSpan: string;
  bestScore: number;
  supportThreshold: number;
  /**
   * Refuse to assert SUPPORTED from lexical overlap alone.
   *
   * Set only when this scorer is standing in for a model that could not be
   * reached. As the primary engine — COMPUTE_DRIVER=local — the operator chose
   * a lexical pipeline and gets its verdicts unchanged.
   *
   * The distinction is not fussiness. A claim that swaps one decisive word
   * against a source stating the rule for both ("MAJOR version when you add
   * functionality in a backward compatible manner", against a page that says
   * MINOR) overlaps almost perfectly, so the score clears the threshold and the
   * verdict comes out SUPPORTED — the opposite of what the source says. That
   * happened on mainnet task 0xa11e3223… on 2026-09-05. Overlap is not
   * entailment, and a fallback that cannot tell them apart should say so rather
   * than guess in the confident direction.
   */
  conservative?: FallbackReason | false;
}): Judgement {
  const { claim, bestSpan, bestScore, supportThreshold, conservative = false } = args;
  const facts = compareFacts(claim, bestSpan);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;

  // Contradiction is checked before the support threshold, deliberately. The
  // threshold asks "is this span strong enough to establish the claim"; a span
  // that states a different value for the same fact is not weak evidence for
  // the claim, it is evidence against it. Gating that behind the support bar
  // would silently downgrade every refutation to "not enough evidence", which
  // is the more comfortable answer and the wrong one.
  //
  // It still needs a relevance floor: a span has to be about the same subject
  // before its numbers can disagree with the claim's.
  const relevanceFloor = supportThreshold * 0.6;
  if (facts.contradicted.length > 0 && bestScore >= relevanceFloor) {
    return {
      verdict: "CONTRADICTED",
      confidence: round(0.5 + bestScore / 2),
      reasoningSummary:
        "The best matching span shares the claim's subject but states a different value for at least " +
        `one factual token (score ${bestScore.toFixed(2)}).`,
    };
  }

  if (bestScore < supportThreshold) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: round(0.25 + bestScore / 3),
      reasoningSummary:
        `The closest span (score ${bestScore.toFixed(2)}) is below this pipeline's support threshold ` +
        `of ${supportThreshold.toFixed(2)}, so the claim is not established by the snapshot.`,
    };
  }

  if (conservative) {
    // Deliberately after the CONTRADICTED branch above: capping support must
    // not also silence refutation, or a degraded verifier goes quiet exactly
    // when it has something worth saying.
    return {
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: round(0.25 + bestScore / 3),
      reasoningSummary:
        `The closest span scores ${bestScore.toFixed(2)}, above this pipeline's support threshold of ` +
        `${supportThreshold.toFixed(2)}, but no model weighed it: ${FALLBACK_CAUSE[conservative]}, so this ` +
        "verdict comes from lexical scoring alone, which cannot tell a matching sentence from an " +
        "entailing one. Reported as insufficient rather than asserted as support.",
    };
  }

  const base = 0.45 + bestScore / 2;
  // Confirming every fact the claim asserts closes most of the remaining gap,
  // without ever reaching certainty.
  const confidence = facts.overlap >= 1 ? base + (1 - base) * 0.6 : base;
  return {
    verdict: "SUPPORTED",
    confidence: round(confidence),
    reasoningSummary:
      `The quoted span states the claim directly (score ${bestScore.toFixed(2)}, ` +
      `factual overlap ${Math.round(facts.overlap * 100)}%).`,
  };
}
