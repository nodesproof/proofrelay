import { describe, expect, it } from "vitest";
import { compareFacts, factualTokens, judge, normalizeFacts, scoreSpan, splitSpans, tokenize } from "./entailment.js";
import { LocalComputeAdapter, scoreClaim } from "./local.js";
import type { EvidenceCorpusEntry } from "./types.js";

const CHANGELOG = `# Changelog

All notable changes to the acme-widgets repository are documented here.

Release v1.4.0 — August 10, 2026.
Adds streaming support and drops Node.js 18.

Release v1.3.0 — May 21, 2026.
Maintenance release with dependency bumps and documentation fixes.`;

const README = `# acme-widgets

acme-widgets is a client library maintained by the core team.
The current stable release is v1.4.0 and it requires Node.js 20 or newer.
The project publishes a release roughly every month.`;

const corpus: EvidenceCorpusEntry[] = [
  {
    sourceId: "src-001",
    uri: "https://example.org/acme-widgets/CHANGELOG.md",
    snapshotObjectId: "local://aaaa",
    contentHash: "sha256:aaaa",
    text: CHANGELOG,
    retrievedAt: "2026-08-31T10:00:00.000Z",
  },
  {
    sourceId: "src-002",
    uri: "https://example.org/acme-widgets/README.md",
    snapshotObjectId: "local://bbbb",
    contentHash: "sha256:bbbb",
    text: README,
    retrievedAt: "2026-08-31T10:00:00.000Z",
  },
];

describe("tokenisation", () => {
  it("drops stopwords and keeps version-like tokens intact", () => {
    const tokens = tokenize("The repository released version 1.4.0 on 2026-08-10.");
    expect(tokens).toContain("1.4.0");
    expect(tokens).toContain("2026-08-10");
    expect(tokens).not.toContain("the");
  });

  it("treats numbers, versions and dates as factual tokens", () => {
    const facts = factualTokens("Release v1.4.0 on 2026-08-10 grew 12.5%");
    expect(facts).toContain("1.4.0");
    expect(facts).toContain("2026-08-10");
    expect(facts).toContain("12.5%");
  });

  it("normalises a written date to the same fact as an ISO one", () => {
    expect(normalizeFacts("Release v1.4.0 — August 10, 2026.")).toContain("2026-08-10");
    expect(normalizeFacts("released on 2026-08-10")).toContain("2026-08-10");
  });
});

describe("span selection", () => {
  it("scores the span that states the claim highest", () => {
    const spans = splitSpans(CHANGELOG);
    const claim = "The repository released version 1.4.0 on 2026-08-10.";
    const best = spans
      .map((span) => ({ span, score: scoreSpan(claim, span.text) }))
      .sort((a, b) => b.score - a.score)[0]!;
    expect(best.span.text).toContain("v1.4.0");
    expect(best.score).toBeGreaterThan(0.5);
  });

  it("returns spans whose offsets index back into the original text", () => {
    for (const span of splitSpans(README)) {
      expect(README.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("handles text with no sentence punctuation", () => {
    expect(splitSpans("a single line with no terminator")).toHaveLength(1);
  });
});

describe("judging", () => {
  it("SUPPORTS a claim whose facts the span confirms", () => {
    const result = judge({
      claim: "The repository released version 1.4.0 on 2026-08-10.",
      bestSpan: "Release v1.4.0 — August 10, 2026.",
      bestScore: 0.8,
      supportThreshold: 0.55,
    });
    expect(result.verdict).toBe("SUPPORTED");
    expect(result.reasoningSummary).toContain("factual overlap 100%");
  });

  it("CONTRADICTS a claim about the right subject with the wrong number", () => {
    const result = judge({
      claim: "The repository released version 2.0.0 on August 10, 2026.",
      bestSpan: "Release v1.4.0 — August 10, 2026.",
      bestScore: 0.6,
      supportThreshold: 0.55,
    });
    expect(result.verdict).toBe("CONTRADICTED");
  });

  it("returns INSUFFICIENT_EVIDENCE below the threshold and names it", () => {
    const result = judge({
      claim: "The maintainers relocated to Lisbon.",
      bestSpan: "Release v1.4.0 — August 10, 2026.",
      bestScore: 0.18,
      supportThreshold: 0.55,
    });
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasoningSummary).toContain("0.55");
  });

  it("contradicts below the support threshold — the threshold gates support, not refutation", () => {
    const result = judge({
      claim: "The repository released version 2.0.0 on August 10, 2026.",
      bestSpan: "Release v1.4.0 — August 10, 2026.",
      bestScore: 0.47,
      supportThreshold: 0.55,
    });
    expect(result.verdict).toBe("CONTRADICTED");
  });

  it("does not contradict on a span that is not even about the claim", () => {
    const result = judge({
      claim: "The repository released version 2.0.0.",
      bestSpan: "Contributions are welcome; see CONTRIBUTING.md for the process, revision 3.",
      bestScore: 0.05,
      supportThreshold: 0.55,
    });
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("never reaches certainty", () => {
    const result = judge({
      claim: "v1.4.0 released 2026-08-10",
      bestSpan: "v1.4.0 released 2026-08-10",
      bestScore: 1,
      supportThreshold: 0.55,
    });
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("is monotone in the score for a given verdict", () => {
    const low = judge({ claim: "x 1", bestSpan: "y 2", bestScore: 0.6, supportThreshold: 0.55 });
    const high = judge({ claim: "x 1", bestSpan: "y 2", bestScore: 0.9, supportThreshold: 0.55 });
    expect(high.confidence).toBeGreaterThan(low.confidence);
  });
});

describe("factual comparison", () => {
  it("reports full overlap when every fact appears", () => {
    expect(compareFacts("version 1.4.0", "Release v1.4.0 today").overlap).toBe(1);
  });

  it("reports a contradiction when the span states a different value of the same kind", () => {
    const facts = compareFacts("version 2.0.0", "Release v1.4.0 today");
    expect(facts.contradicted).toContain("2.0.0");
    expect(facts.unconfirmed).toEqual([]);
    expect(facts.overlap).toBe(0);
  });

  it("separates a fact the span disagrees with from one it never mentions", () => {
    const absent = compareFacts("version 2.0.0", "The library is maintained by the core team.");
    expect(absent.contradicted).toEqual([]);
    expect(absent.unconfirmed).toContain("2.0.0");
  });

  it("has no opinion on a claim that asserts no facts", () => {
    expect(compareFacts("the library is well maintained", "anything").overlap).toBe(0);
  });
});

describe("LocalComputeAdapter", () => {
  it("keeps one span per source so evidence overlap stays meaningful", async () => {
    const result = scoreClaim(
      { claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10." },
      corpus,
      2,
      0.55,
    );
    expect(result.sources).toHaveLength(2);
    expect(new Set(result.sources.map((source) => source.contentHash)).size).toBe(2);
  });

  it("is deterministic across runs and independent of corpus order", async () => {
    const adapter = new LocalComputeAdapter({ evidenceDepth: 2, supportThreshold: 0.55 });
    const claims = [{ claimId: "claim-001", claimText: "The current stable release is v1.4.0." }];
    const a = await adapter.scoreEvidence({ claims, corpus, evidenceDepth: 2, supportThreshold: 0.55 });
    const b = await adapter.scoreEvidence({
      claims,
      corpus: [...corpus].reverse(),
      evidenceDepth: 2,
      supportThreshold: 0.55,
    });
    expect(a.trace.outputHash).toBe(b.trace.outputHash);
  });

  it("encodes the pipeline configuration in its model id", () => {
    expect(new LocalComputeAdapter({ evidenceDepth: 3, supportThreshold: 0.62 }).modelId).toBe(
      "local-entailment/3-0.62",
    );
  });

  it("never lets a stricter threshold decide more claims than a lenient one", async () => {
    const claims = [
      { claimId: "claim-001", claimText: "The project publishes a release every month." },
      { claimId: "claim-002", claimText: "The maintainers relocated their head office to Lisbon in 2026." },
      { claimId: "claim-003", claimText: "acme-widgets requires Node.js 20 or newer." },
      { claimId: "claim-004", claimText: "The library ships a command line interface." },
    ];
    const decided = async (threshold: number) => {
      const result = await new LocalComputeAdapter({ evidenceDepth: 2, supportThreshold: threshold }).scoreEvidence({
        claims,
        corpus,
        evidenceDepth: 2,
        supportThreshold: threshold,
      });
      return result.value.filter((entry) => entry.verdict !== "INSUFFICIENT_EVIDENCE").length;
    };
    const strict = await decided(0.95);
    const lenient = await decided(0.15);
    expect(strict).toBeLessThanOrEqual(lenient);
    expect(lenient).toBeGreaterThan(strict);
  });

  it("never invents a claim from the sources during extraction", async () => {
    const adapter = new LocalComputeAdapter();
    const extracted = await adapter.runClaimExtraction({
      question: "Is v1.4.0 real?",
      answerText: "The repository released version 1.4.0. It requires Node.js 20.",
      corpus,
      maxClaims: 10,
    });
    expect(extracted.value).toHaveLength(2);
    for (const claim of extracted.value) {
      expect("The repository released version 1.4.0. It requires Node.js 20.").toContain(
        claim.claimText.replace(/\.$/, ""),
      );
    }
  });

  it("records a trace whose input hash covers the corpus, not just the claims", async () => {
    const adapter = new LocalComputeAdapter();
    const claims = [{ claimId: "claim-001", claimText: "v1.4.0 shipped" }];
    const a = await adapter.scoreEvidence({ claims, corpus, evidenceDepth: 2, supportThreshold: 0.55 });
    const b = await adapter.scoreEvidence({
      claims,
      corpus: [corpus[0]!],
      evidenceDepth: 2,
      supportThreshold: 0.55,
    });
    expect(a.trace.inputHash).not.toBe(b.trace.inputHash);
  });

  it("returns INSUFFICIENT_EVIDENCE with no sources when the corpus is empty", () => {
    const result = scoreClaim({ claimId: "claim-001", claimText: "anything at all" }, [], 2, 0.55);
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.sources).toEqual([]);
  });
});

/**
 * The failure this suite exists to prevent, taken from a real mainnet task
 * (0xa11e3223…, 2026-09-05). The claim swaps one decisive word — MAJOR for
 * MINOR — against a source that states the rule for both. Lexical overlap is
 * near-total, so the scorer read it as support and published SUPPORTED at 0.74
 * on a claim the source directly refutes.
 *
 * As the primary engine that behaviour stays: an operator who chose
 * COMPUTE_DRIVER=local asked for a lexical pipeline and gets one. As the
 * fallback behind a model it must not, because there nobody chose it — it is
 * what happens when the model could not be reached, and asserting support from
 * word overlap is worse than admitting the evidence was never weighed.
 */
describe("judge in conservative mode", () => {
  const SEMVER =
    "MAJOR version when you make incompatible API changes. " +
    "MINOR version when you add functionality in a backward compatible manner. " +
    "PATCH version when you make backward compatible bug fixes.";
  const swapped =
    "Under Semantic Versioning, the MAJOR version is incremented when you add functionality in a backward compatible manner.";
  const args = { claim: swapped, bestSpan: SEMVER, bestScore: 0.58, supportThreshold: 0.55 };

  it("reproduces the wrong SUPPORTED as the primary engine", () => {
    expect(judge(args).verdict).toBe("SUPPORTED");
  });

  it("refuses to assert support as a fallback", () => {
    const verdict = judge({ ...args, conservative: true });
    expect(verdict.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.reasoningSummary).toMatch(/model/i);
  });

  it("still reports a contradiction it can actually see", () => {
    // Conservative caps support; it must not also silence refutation, or a
    // degraded verifier would go quiet exactly when it has something to say.
    const numeric = judge({
      claim: "The 0G mainnet chain id is 16602.",
      bestSpan: "0G Mainnet — Chain ID 16661.",
      bestScore: 0.8,
      supportThreshold: 0.55,
      conservative: true,
    });
    expect(numeric.verdict).toBe("CONTRADICTED");
  });

  it("leaves an already-insufficient verdict alone", () => {
    const weak = { claim: "unrelated assertion", bestSpan: SEMVER, bestScore: 0.1, supportThreshold: 0.55 };
    expect(judge({ ...weak, conservative: true })).toEqual(judge(weak));
  });
});
