import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConsensusResult,
  DEFAULT_RULE,
  canonicalize,
  type ConsensusRule,
  type TaskManifest,
  type Verdict,
  type VerifierReport,
} from "@proofrelay/schemas";
import {
  agreementLabel,
  agreementPct,
  claimConfidencePct,
  claimConsensusById,
  conflictingVerifiers,
  displayVerdict,
  evaluateClaim,
  evaluateConsensus,
  type ManifestClaimRef,
} from "./engine.js";

const TASK_ID = `0x${"11".repeat(32)}` as const;
const MANIFEST_HASH = `0x${"22".repeat(32)}` as const;
const OTHER_TASK_ID = `0x${"33".repeat(32)}` as const;
const AT = "2026-08-31T10:32:35.875Z";

/** The two demo verifiers, deliberately not in address order. */
const VERIFIER_B = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
const VERIFIER_A = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const VERIFIER_C = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

const CHANGELOG = `sha256:${"a1".repeat(32)}`;
const README = `sha256:${"b2".repeat(32)}`;
const BLOG = `sha256:${"c3".repeat(32)}`;

const CLAIMS: ManifestClaimRef[] = [
  { claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10." },
];

interface VoteSpec {
  claimId: string;
  verdict: Verdict;
  confidence: number;
  /** `[]` means the verifier answered without citing anything. */
  sources?: string[];
}

function report(
  verifier: string,
  votes: VoteSpec[],
  overrides: Partial<VerifierReport> = {},
): VerifierReport {
  const identity = {
    address: verifier,
    verifierId: `verifier-${verifier.slice(2, 6)}`,
    modelId: "local-entailment/2-0.55",
    pipelineVersion: "0.1.0",
  };
  return {
    kind: "verifier-report",
    schemaVersion: "1.0.0",
    taskId: TASK_ID,
    manifestHash: MANIFEST_HASH,
    manifestPointer: `local://${MANIFEST_HASH.slice(2)}`,
    verifier: identity,
    claims: votes.map((vote) => ({
      taskId: TASK_ID,
      claimId: vote.claimId,
      // Deliberately not the manifest wording: the manifest owns the text.
      claimText: `verifier restatement of ${vote.claimId}`,
      verdict: vote.verdict,
      confidence: vote.confidence,
      sources: (vote.sources ?? [CHANGELOG]).map((contentHash, index) => ({
        uri: `https://example.org/acme-widgets/source-${index}`,
        snapshotObjectId: `local://${contentHash.slice(7)}`,
        contentHash,
        quotedSpan: "Release v1.4.0 — August 10, 2026.",
        spanStart: 0,
        spanEnd: 33,
        score: 0.58,
        retrievedAt: AT,
      })),
      verifier: identity,
      reasoningSummary: "The quoted span states the claim directly.",
      createdAt: AT,
    })),
    graph: { nodes: [], edges: [] },
    compute: [],
    summary: {
      supported: 0,
      contradicted: 0,
      insufficient: 0,
      meanConfidence: 0,
      evidenceCoverage: 0,
    },
    createdAt: AT,
    ...overrides,
  };
}

function evaluate(
  reports: VerifierReport[],
  manifestClaims: ManifestClaimRef[] = CLAIMS,
  rule?: ConsensusRule,
) {
  return evaluateConsensus({
    taskId: TASK_ID,
    manifestHash: MANIFEST_HASH,
    ruleId: DEFAULT_RULE.ruleId,
    producer: "proofrelay-api/1.0.0",
    reports,
    manifestClaims,
    evaluatedAt: AT,
    ...(rule ? { rule } : {}),
  });
}

describe("claim agreement", () => {
  it("settles a claim when both verifiers share a verdict and cite the same snapshots", () => {
    const result = evaluate([
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.93, sources: [CHANGELOG, README] }]),
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97, sources: [README, CHANGELOG] }]),
    ]);

    expect(result.outcome).toBe("CONSENSUS");
    expect(result.agreementBps).toBe(10_000);
    expect(result.conflicts).toEqual([]);
    expect(result.rewardedVerifiers).toEqual([VERIFIER_A, VERIFIER_B]);

    const claim = result.claims[0]!;
    expect(claim.agreed).toBe(true);
    expect(claim.majorityVerdict).toBe("SUPPORTED");
    expect(claim.evidenceCoverage).toBe(1);
    expect(claim.evidenceOverlap).toBe(1);
    expect(claim.agreeingVerifiers).toEqual([VERIFIER_A, VERIFIER_B]);
    expect(claim.dissentingVerifiers).toEqual([]);
    expect(claim.reason).toBe("2 verifiers agree on SUPPORTED with matching evidence");
    // The manifest owns the claim text, not the verifier's restatement of it.
    expect(claim.claimText).toBe(CLAIMS[0]!.claimText);
  });

  it("does not settle a claim whose agreeing verifiers cite disjoint evidence", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [CHANGELOG] }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [BLOG] }]),
    ]);

    const claim = result.claims[0]!;
    expect(claim.agreed).toBe(false);
    expect(claim.majorityVerdict).toBe("SUPPORTED");
    expect(claim.evidenceCoverage).toBe(1);
    expect(claim.evidenceOverlap).toBe(0);
    expect(claim.reason).toBe(
      "agreeing verifiers cite disjoint evidence (overlap 0.00, floor 0.50)",
    );
    expect(result.outcome).toBe("CONFLICT");
    expect(result.rewardedVerifiers).toEqual([]);
  });

  it("scores partial evidence overlap as Jaccard and settles above the floor", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [CHANGELOG, README] }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [CHANGELOG] }]),
    ]);

    // shared {CHANGELOG} over union {CHANGELOG, README}
    expect(result.claims[0]!.evidenceOverlap).toBe(0.5);
    expect(result.claims[0]!.agreed).toBe(true);
  });

  it("flags SUPPORTED against CONTRADICTED as a critical conflict", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.95 }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.95 }]),
    ]);

    const claim = result.claims[0]!;
    expect(claim.criticalConflict).toBe(true);
    expect(claim.agreed).toBe(false);
    expect(claim.majorityVerdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(claim.reason).toBe("verifiers split on direction: 1 SUPPORTED vs 1 CONTRADICTED");
    expect(result.outcome).toBe("CONFLICT");
    expect(result.conflicts).toEqual([
      "claim-001: verifiers split on direction: 1 SUPPORTED vs 1 CONTRADICTED",
    ]);
  });

  it("blocks settlement even when a majority outvotes a contradicting verifier", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.95 }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
      report(VERIFIER_C, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.8 }]),
    ]);

    const claim = result.claims[0]!;
    expect(claim.majorityVerdict).toBe("SUPPORTED");
    expect(claim.agreeingVerifiers).toEqual([VERIFIER_A, VERIFIER_B]);
    expect(claim.dissentingVerifiers).toEqual([VERIFIER_C]);
    expect(claim.criticalConflict).toBe(true);
    expect(claim.agreed).toBe(false);
  });

  it("does not count a verdict below the confidence floor toward agreement", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.41 }]),
    ]);

    const claim = result.claims[0]!;
    expect(claim.agreeingVerifiers).toEqual([VERIFIER_A]);
    expect(claim.dissentingVerifiers).toEqual([VERIFIER_B]);
    expect(claim.agreed).toBe(false);
    expect(claim.reason).toBe(
      "only 1/2 verifiers share a verdict above the confidence floor",
    );
    // The verdict is still reported — a dropped vote must stay visible.
    expect(claim.verdicts).toHaveLength(2);
    expect(claim.verdicts[1]).toEqual({
      verifier: VERIFIER_B,
      verdict: "SUPPORTED",
      confidence: 0.41,
    });
  });

  it("settles a shared abstention even below the floor", () => {
    // Recorded behaviour: a claim settled on two INSUFFICIENT_EVIDENCE verdicts
    // at 0.3103, well under the 0.55 floor. Confidence gates a statement about
    // the world, not "the sources do not settle this".
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.3103 }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.3103 }]),
    ]);

    expect(result.outcome).toBe("CONSENSUS");
    expect(result.claims[0]!.agreed).toBe(true);
    expect(result.claims[0]!.reason).toBe(
      "2 verifiers agree that the sources do not settle this claim",
    );
  });

  it("requires the agreeing verifiers to have cited anything at all", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [CHANGELOG] }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [] }]),
    ]);

    const claim = result.claims[0]!;
    expect(claim.evidenceCoverage).toBe(0.5);
    expect(claim.agreed).toBe(false);
    expect(claim.reason).toBe("only 1/2 agreeing verifiers cited any evidence");
  });

  it("reports a claim no verifier answered", () => {
    const claims: ManifestClaimRef[] = [
      ...CLAIMS,
      { claimId: "claim-002", claimText: "The maintainers relocated to Lisbon in 2026." },
    ];
    const result = evaluate(
      [
        report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
        report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
      ],
      claims,
    );

    const missing = result.claims[1]!;
    expect(missing.verdicts).toEqual([]);
    expect(missing.agreed).toBe(false);
    expect(missing.majorityVerdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(missing.evidenceCoverage).toBe(0);
    expect(missing.evidenceOverlap).toBe(0);
    expect(missing.reason).toBe("no verifier reported on this claim");
    expect(result.outcome).toBe("CONFLICT");
    expect(result.conflicts).toEqual(["claim-002: no verifier reported on this claim"]);
    expect(displayVerdict(missing)).toBe("PENDING");
  });

  it("honours a stricter rule than the default", () => {
    const strict: ConsensusRule = { ...DEFAULT_RULE, requiredAgreement: 3 };
    const result = evaluate(
      [
        report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
        report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
      ],
      CLAIMS,
      strict,
    );

    // Two reveals cannot satisfy a three-of rule: the task never had a quorum.
    expect(result.outcome).toBe("NO_QUORUM");
    expect(result.claims[0]!.agreed).toBe(false);
  });

  it("evaluates a single claim on its own for the claim view", () => {
    const claim = evaluateClaim({
      claimId: "claim-001",
      claimText: CLAIMS[0]!.claimText,
      reports: [
        report(VERIFIER_A, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.7346 }]),
        report(VERIFIER_B, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.728 }]),
      ],
    });

    expect(claim.agreed).toBe(true);
    expect(claim.reason).toBe("2 verifiers agree on CONTRADICTED with matching evidence");
    expect(displayVerdict(claim)).toBe("CONTRADICTED");
    expect(claimConfidencePct(claim)).toBe(73);
  });
});

describe("quorum", () => {
  it("returns NO_QUORUM when fewer reports were revealed than the rule requires", () => {
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 }]),
    ]);

    expect(result.outcome).toBe("NO_QUORUM");
    expect(result.agreementBps).toBe(0);
    expect(result.rewardedVerifiers).toEqual([]);
    expect(result.reportHashes).toHaveLength(1);
    expect(result.claims[0]!.agreed).toBe(false);
    expect(agreementLabel(result.outcome, result.agreementBps)).toBe("No quorum");
  });

  it("ignores a report bound to another task", () => {
    const stray = report(VERIFIER_B, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 },
    ]);
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 }]),
      { ...stray, taskId: OTHER_TASK_ID },
    ]);

    expect(result.outcome).toBe("NO_QUORUM");
    expect(result.reportHashes).toHaveLength(1);
    expect(result.claims[0]!.verdicts).toHaveLength(1);
  });

  it("ignores a report bound to an older manifest", () => {
    const stale = report(VERIFIER_B, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 },
    ]);
    const result = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 }]),
      { ...stale, manifestHash: `0x${"44".repeat(32)}` },
    ]);

    expect(result.outcome).toBe("NO_QUORUM");
    expect(result.claims[0]!.verdicts).toHaveLength(1);
  });

  it("counts one verifier once however many reports it submits", () => {
    const first = report(VERIFIER_A, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 },
    ]);
    const second = report(VERIFIER_A, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.61 },
    ]);
    const result = evaluate([first, second]);

    expect(result.outcome).toBe("NO_QUORUM");
    expect(result.reportHashes).toHaveLength(1);
    expect(result.claims[0]!.verdicts).toHaveLength(1);
    expect(result.claims[0]!.agreeingVerifiers).toEqual([VERIFIER_A]);
  });
});

describe("task outcome arithmetic", () => {
  const threeClaims: ManifestClaimRef[] = [
    { claimId: "claim-001", claimText: "one" },
    { claimId: "claim-002", claimText: "two" },
    { claimId: "claim-003", claimText: "three" },
  ];

  function withAgreement(agreedCount: number) {
    const votes = (confidence: number): VoteSpec[] =>
      threeClaims.map((claim, index) => ({
        claimId: claim.claimId,
        verdict: "SUPPORTED" as Verdict,
        // Under the floor for the claims that must not agree.
        confidence: index < agreedCount ? confidence : 0.2,
      }));
    return evaluate(
      [report(VERIFIER_A, votes(0.95)), report(VERIFIER_B, votes(0.9))],
      threeClaims,
    );
  }

  it("reports agreement in basis points", () => {
    expect(withAgreement(3).agreementBps).toBe(10_000);
    expect(withAgreement(2).agreementBps).toBe(6667);
    expect(withAgreement(1).agreementBps).toBe(3333);
    expect(withAgreement(0).agreementBps).toBe(0);
  });

  it("settles only when every claim agrees", () => {
    expect(withAgreement(3).outcome).toBe("CONSENSUS");
    expect(withAgreement(2).outcome).toBe("CONFLICT");
    expect(withAgreement(2).conflicts).toEqual([
      "claim-003: only 0/2 verifiers share a verdict above the confidence floor",
    ]);
  });

  it("rewards only verifiers that agreed on a majority of claims", () => {
    // C dissents on two of three claims but never contradicts, so every claim
    // still settles on A and B.
    const cVotes: VoteSpec[] = [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 },
      { claimId: "claim-002", verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.4 },
      { claimId: "claim-003", verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.4 },
    ];
    const agreeing: VoteSpec[] = threeClaims.map((claim) => ({
      claimId: claim.claimId,
      verdict: "SUPPORTED" as Verdict,
      confidence: 0.9,
    }));

    const result = evaluate(
      [report(VERIFIER_A, agreeing), report(VERIFIER_B, agreeing), report(VERIFIER_C, cVotes)],
      threeClaims,
    );

    expect(result.outcome).toBe("CONSENSUS");
    expect(result.rewardedVerifiers).toEqual([VERIFIER_A, VERIFIER_B]);
    expect(conflictingVerifiers(result)).toEqual([VERIFIER_C]);
  });

  it("does not settle a manifest with no claims", () => {
    const result = evaluate(
      [
        report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
        report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
      ],
      [],
    );

    expect(result.outcome).toBe("CONFLICT");
    expect(result.agreementBps).toBe(0);
    expect(result.rewardedVerifiers).toEqual([]);
  });
});

describe("determinism", () => {
  const votes: VoteSpec[] = [
    { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9, sources: [CHANGELOG, README] },
    { claimId: "claim-002", verdict: "CONTRADICTED", confidence: 0.75, sources: [CHANGELOG] },
    { claimId: "claim-003", verdict: "INSUFFICIENT_EVIDENCE", confidence: 0.31, sources: [README] },
  ];
  const claims: ManifestClaimRef[] = [
    { claimId: "claim-001", claimText: "one" },
    { claimId: "claim-002", claimText: "two" },
    { claimId: "claim-003", claimText: "three" },
  ];
  const reports = [
    report(VERIFIER_C, votes),
    report(VERIFIER_A, votes),
    report(VERIFIER_B, votes),
  ];

  it("produces the same result whatever order the reports arrive in", () => {
    const forward = evaluate(reports, claims);
    const reversed = evaluate([...reports].reverse(), claims);
    const rotated = evaluate([reports[1]!, reports[2]!, reports[0]!], claims);

    expect(canonicalize(reversed)).toEqual(canonicalize(forward));
    expect(canonicalize(rotated)).toEqual(canonicalize(forward));
  });

  /**
   * `evaluateClaim` is the path the API renders a single claim row through, and
   * it takes whatever report list the caller assembled. Before the lowest-hash
   * tie-break it kept the first copy in the array, so a duplicated verifier let
   * row order decide the verdict: one ordering settled the claim on SUPPORTED,
   * the reverse abstained.
   */
  it("resolves a duplicated verifier the same way whichever copy comes first", () => {
    const supported = report(VERIFIER_A, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.99 },
    ]);
    const contradicted = report(VERIFIER_A, [
      { claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.99 },
    ]);
    const other = report(VERIFIER_B, [
      { claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 },
    ]);
    const forClaim = (reports: VerifierReport[]) =>
      evaluateClaim({ claimId: "claim-001", claimText: CLAIMS[0]!.claimText, reports });

    const forward = forClaim([supported, contradicted, other]);
    const reversed = forClaim([contradicted, supported, other]);

    expect(canonicalize(reversed)).toEqual(canonicalize(forward));
    expect(forward.verdicts).toHaveLength(2);
    // And the same copy the whole-task path would have picked.
    expect(forward.majorityVerdict).toBe(
      evaluate([supported, contradicted, other]).claims[0]!.majorityVerdict,
    );
  });

  it("sorts every address and hash it emits", () => {
    const result = evaluate(reports, claims);
    const sorted = <T>(values: T[]) => [...values].sort();

    expect(result.rewardedVerifiers).toEqual(sorted(result.rewardedVerifiers));
    expect(result.reportHashes).toEqual(sorted(result.reportHashes));
    for (const claim of result.claims) {
      expect(claim.agreeingVerifiers).toEqual(sorted(claim.agreeingVerifiers));
      expect(claim.verdicts.map((entry) => entry.verifier)).toEqual(
        sorted(claim.verdicts.map((entry) => entry.verifier)),
      );
    }
  });

  it("emits an artifact the consensus-result schema accepts", () => {
    const result = evaluate(reports, claims);
    expect(() => ConsensusResult.parse(result)).not.toThrow();
    expect(result.kind).toBe("consensus-result");
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.evaluatedAt).toBe(AT);
  });
});

describe("rendering helpers", () => {
  const result = evaluate([
    report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.97 }]),
    report(VERIFIER_B, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.93 }]),
  ]);

  it("indexes claims by id", () => {
    const index = claimConsensusById(result);
    expect(index.get("claim-001")?.majorityVerdict).toBe("SUPPORTED");
    expect(index.get("claim-404")).toBeUndefined();
  });

  it("averages the agreeing verifiers' confidence", () => {
    expect(claimConfidencePct(result.claims[0]!)).toBe(95);
  });

  it("labels agreement for the task table", () => {
    expect(agreementPct(10_000)).toBe(100);
    expect(agreementPct(6667)).toBe(67);
    expect(agreementLabel("CONSENSUS", 10_000)).toBe("Full agreement");
    expect(agreementLabel("CONFLICT", 0)).toBe("No agreement");
    expect(agreementLabel("CONFLICT", 6667)).toBe("Partial agreement 67%");
    expect(agreementLabel("NO_QUORUM", 0)).toBe("No quorum");
  });

  it("falls back to every reported verdict when nobody agreed", () => {
    const split = evaluate([
      report(VERIFIER_A, [{ claimId: "claim-001", verdict: "SUPPORTED", confidence: 0.9 }]),
      report(VERIFIER_B, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.7 }]),
    ]);
    expect(split.claims[0]!.agreeingVerifiers).toEqual([]);
    expect(claimConfidencePct(split.claims[0]!)).toBe(80);
  });
});

/* ── golden: the results the lost implementation really produced ─────────── */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STORAGE = join(ROOT, ".proofrelay", "storage");

interface StoredObjects {
  get(id: string): Record<string, unknown> | undefined;
  values(): Record<string, unknown>[];
}

function loadStorage(): StoredObjects {
  const objects = new Map<string, Record<string, unknown>>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json") && !entry.name.endsWith(".meta.json")) {
        objects.set(entry.name.slice(0, -".json".length), JSON.parse(readFileSync(path, "utf8")));
      }
    }
  };
  walk(STORAGE);
  return {
    get: (id) => objects.get(id.replace(/^0x/, "")),
    values: () => [...objects.values()],
  };
}

describe("recorded results", () => {
  // The fixtures are the ground truth for wording and shape; a missing store is
  // a broken checkout, not a reason to pass silently.
  it("has the storage fixtures", () => {
    expect(existsSync(STORAGE)).toBe(true);
  });

  const objects = loadStorage();

  /**
   * Only the results whose manifest and every report are also in the local
   * store.
   *
   * The store is a mirror of everything this machine has uploaded, so a live
   * run adds consensus results for tasks whose *inputs* were fetched from 0G
   * and never written to disk. Those cannot be replayed offline, and treating
   * them as broken fixtures would make this suite fail every time someone runs
   * the demo. What must not silently shrink is the recorded set itself, which
   * the count below pins.
   */
  const resolvable = (result: ConsensusResult): boolean =>
    objects.get(result.manifestHash) !== undefined &&
    result.reportHashes.every((hash) => objects.get(hash) !== undefined);

  const recorded = objects
    .values()
    .filter((object) => object["kind"] === "consensus-result")
    .map((object) => object as unknown as ConsensusResult)
    .filter(resolvable)
    .sort((a, b) => (a.taskId < b.taskId ? -1 : 1));

  function replay(result: ConsensusResult, reverse = false): ConsensusResult {
    const manifest = objects.get(result.manifestHash) as unknown as TaskManifest;
    const hashes = reverse ? [...result.reportHashes].reverse() : result.reportHashes;
    // The fixtures predate the report schema's graph node shape, and the engine
    // only reads verdicts and cited sources, so they are replayed as-is.
    const reports = hashes.map((hash) => objects.get(hash) as unknown as VerifierReport);
    return evaluateConsensus({
      taskId: result.taskId,
      manifestHash: result.manifestHash,
      ruleId: result.ruleId,
      producer: result.producer,
      reports,
      manifestClaims: manifest.claims.map((claim) => ({
        claimId: claim.claimId,
        claimText: claim.claimText,
      })),
      evaluatedAt: result.evaluatedAt,
      reportHashes: hashes,
    });
  }

  it("covers both a settled and a conflicting task", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(4);
    const outcomes = new Set(recorded.map((result) => result.outcome));
    expect(outcomes.has("CONSENSUS")).toBe(true);
    expect(outcomes.has("CONFLICT")).toBe(true);
  });

  for (const result of recorded) {
    it(`reproduces ${result.outcome} for task ${result.taskId.slice(0, 10)}`, () => {
      expect(canonicalize(replay(result))).toEqual(canonicalize(result));
      expect(canonicalize(replay(result, true))).toEqual(canonicalize(result));
    });
  }

  it("reproduces the recorded conflict wording", () => {
    const conflicted = recorded.filter((result) => result.outcome === "CONFLICT");
    expect(conflicted.length).toBeGreaterThan(0);
    for (const result of conflicted) {
      expect(result.conflicts).toContain(
        "claim-001: only 1/2 verifiers share a verdict above the confidence floor",
      );
      expect(replay(result).conflicts).toEqual(result.conflicts);
    }
  });
});

/**
 * From mainnet task 0xa11e3223… (2026-09-05). Two of four verifiers could not
 * reach their model on one claim; both fell to the offline scorer, both
 * returned the same wrong SUPPORTED, and the claim split two-two. The task
 * settled CONFLICT and the contract paid all four the conflict rate — including
 * the one whose entire report came from lexical scoring and cost it no
 * inference at all.
 *
 * A verdict nobody's model produced must not decide the outcome or earn a share.
 * It stays in the record: the vote is still listed, so the failure is auditable.
 */
const VERIFIER_D = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

describe("degraded verdicts", () => {
  const supported = (claimId: string) => ({ claimId, verdict: "SUPPORTED" as const, confidence: 0.9 });

  function degrade(r: VerifierReport): VerifierReport {
    return { ...r, claims: r.claims.map((claim) => ({ ...claim, degraded: true })) };
  }

  it("does not let an offline verdict carry the majority", () => {
    // Two real CONTRADICTED against two degraded SUPPORTED: without the change
    // this is a two-two split and the claim does not agree.
    const result = evaluate([
        report(VERIFIER_A, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 0.95 }]),
        report(VERIFIER_B, [{ claimId: "claim-001", verdict: "CONTRADICTED", confidence: 1 }]),
        degrade(report(VERIFIER_C, [supported("claim-001")])),
        degrade(report(VERIFIER_D, [supported("claim-001")])),
    ]);
    expect(result.claims[0]!.majorityVerdict).toBe("CONTRADICTED");
    expect(result.outcome).toBe("CONSENSUS");
  });

  it("pays only the verifiers whose model answered", () => {
    const result = evaluate([
        report(VERIFIER_A, [supported("claim-001")]),
        report(VERIFIER_B, [supported("claim-001")]),
        degrade(report(VERIFIER_C, [supported("claim-001")])),
    ]);
    expect(result.outcome).toBe("CONSENSUS");
    expect(result.rewardedVerifiers).toEqual([VERIFIER_A, VERIFIER_B]);
    expect(result.rewardedVerifiers).not.toContain(VERIFIER_C);
  });

  it("keeps the degraded vote visible in the record", () => {
    const result = evaluate([
        report(VERIFIER_A, [supported("claim-001")]),
        report(VERIFIER_B, [supported("claim-001")]),
        degrade(report(VERIFIER_C, [supported("claim-001")])),
    ]);
    const voters = result.claims[0]!.verdicts.map((v) => v.verifier);
    expect(voters).toContain(VERIFIER_C);
    // Listed, but not counted as agreeing.
    expect(result.claims[0]!.agreeingVerifiers).not.toContain(VERIFIER_C);
  });

  it("falls to NO_QUORUM when too few models answered", () => {
    // Three of four offline leaves one usable opinion, below requiredAgreement.
    // A refund is the honest outcome; a consensus built from lexical scoring
    // would not be.
    const result = evaluate([
        report(VERIFIER_A, [supported("claim-001")]),
        degrade(report(VERIFIER_B, [supported("claim-001")])),
        degrade(report(VERIFIER_C, [supported("claim-001")])),
    ]);
    expect(result.claims[0]!.agreed).toBe(false);
    expect(result.rewardedVerifiers).toEqual([]);
  });
});
