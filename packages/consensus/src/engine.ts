/**
 * The agreement engine (architecture doc §8).
 *
 * Agreement is never a string compare of answers. Three dimensions decide a
 * claim — the verdict label, the evidence the agreeing verifiers cite, and the
 * absence of a direction conflict:
 *
 *     claimAgreement =
 *         sameVerdict >= requiredAgreement
 *         AND evidenceCoverage >= minimumEvidenceCoverage
 *         AND evidenceOverlap >= minimumEvidenceOverlap
 *         AND noCriticalConflict
 *
 * The overlap term is the one the threat model leans on: "two independent lies
 * must also coincide on evidence". Two verifiers that answer `SUPPORTED` while
 * quoting unrelated snapshots have not corroborated each other, and settling
 * such a task would pay for a coincidence.
 *
 * Everything here is pure and order-independent: `evaluatedAt` is an argument
 * rather than a clock reading, addresses are lowercased and sorted, and the
 * same reports in any order produce byte-identical output. The result is what
 * gets hashed and pointed at from `finalizeConsensus`, so a non-deterministic
 * field would change a hash that is already onchain.
 */
import {
  ConsensusResult,
  DEFAULT_RULE,
  SCHEMA_VERSION,
  hashesEqual,
  objectHash,
  resolveRule,
  type ClaimConsensus,
  type ConsensusOutcome,
  type ConsensusRule,
  type Verdict,
  type VerifierReport,
} from "@proofrelay/schemas";

/** The claim identity the manifest fixes; a report may not rename a claim. */
export interface ManifestClaimRef {
  claimId: string;
  claimText: string;
}

export interface ConsensusInput {
  /** `0x`-prefixed 32-byte hex, as the chain records them; shape-checked on the way out. */
  taskId: string;
  manifestHash: string;
  ruleId: string;
  producer: string;
  reports: readonly VerifierReport[];
  manifestClaims: readonly ManifestClaimRef[];
  evaluatedAt: string;
  /** Defaults to the rule `ruleId` names, so a stored result stays reproducible. */
  rule?: ConsensusRule;
  /**
   * Storage ids the reports were uploaded under, index-aligned with `reports`.
   * The storage adapter owns that id — it is what the verifier committed to and
   * what the chain recorded at reveal — so it is passed in rather than guessed.
   * Absent entries fall back to the canonical hash of the report itself.
   */
  reportHashes?: readonly string[];
}

/** One verifier's answer to one claim, normalised for comparison. */
interface ClaimVote {
  verifier: string;
  verdict: Verdict;
  confidence: number;
  /** `sha256:` content hashes of the snapshots this verdict cites. */
  snapshots: readonly string[];
  /** Whether the verdict clears the rule's confidence floor. */
  counts: boolean;
  /**
   * Scored offline because the compute call failed — not an opinion at all,
   * as distinct from a real opinion too weak to count.
   *
   * The two are kept apart because `criticalConflict` treats them differently:
   * a low-confidence CONTRADICTED is still a model saying "no" and should
   * withhold settlement, while a degraded one is only lexical overlap and must
   * not.
   */
  degraded: boolean;
}

const ABSTENTION: Verdict = "INSUFFICIENT_EVIDENCE";

/** Fixed iteration order so a tally never depends on Map insertion order. */
const VERDICTS: readonly Verdict[] = ["SUPPORTED", "CONTRADICTED", ABSTENTION];

/**
 * A confidence floor gates a statement about the world, not an abstention.
 * `INSUFFICIENT_EVIDENCE` at 0.31 is a verifier saying the sources do not
 * settle the claim, and demanding it say so confidently would make the safest
 * verdict the hardest one to reach — the recorded results settle exactly such a
 * claim on two low-confidence abstentions.
 */
function clearsFloor(verdict: Verdict, confidence: number, rule: ConsensusRule): boolean {
  return verdict === ABSTENTION || confidence >= rule.minimumConfidence;
}

/** Code-unit ordering, not `localeCompare` — a hash must sort the same everywhere. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ascending);
}

/**
 * Jaccard overlap of the snapshots the agreeing verifiers cite: shared over
 * union. A lone verifier has nothing to disagree with, so it scores 1 as long
 * as it cited anything at all.
 */
function jaccard(sets: readonly (readonly string[])[]): number {
  if (sets.length === 0) return 0;
  if (sets.length === 1) return (sets[0]?.length ?? 0) > 0 ? 1 : 0;
  const union = new Set<string>();
  for (const set of sets) for (const hash of set) union.add(hash);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const hash of union) {
    if (sets.every((set) => set.includes(hash))) shared += 1;
  }
  return shared / union.size;
}

function subject(count: number): string {
  return count === 1 ? "1 verifier agrees" : `${count} verifiers agree`;
}

/** Tally the eligible verdicts; a tie is not a majority. */
function majorityVerdict(votes: readonly ClaimVote[]): Verdict {
  let winner: Verdict = ABSTENTION;
  let best = 0;
  let tied = false;
  for (const verdict of VERDICTS) {
    const count = votes.filter((vote) => vote.counts && vote.verdict === verdict).length;
    if (count > best) {
      best = count;
      winner = verdict;
      tied = false;
    } else if (count === best && count > 0) {
      tied = true;
    }
  }
  // No clear winner means the honest label is "the sources do not settle this
  // claim" — the same fallback the recorded CONFLICT results carry.
  return best === 0 || tied ? ABSTENTION : winner;
}

function consensusForVotes(
  claim: ManifestClaimRef,
  votes: readonly ClaimVote[],
  rule: ConsensusRule,
): ClaimConsensus {
  const ordered = [...votes].sort((a, b) => ascending(a.verifier, b.verifier));
  const verdict = majorityVerdict(ordered);
  const agreeing = ordered.filter((vote) => vote.counts && vote.verdict === verdict);
  const agreeingVerifiers = uniqueSorted(agreeing.map((vote) => vote.verifier));
  const agreeingSet = new Set(agreeingVerifiers);
  const dissentingVerifiers = uniqueSorted(
    ordered.map((vote) => vote.verifier).filter((address) => !agreeingSet.has(address)),
  );

  const cited = agreeing.filter((vote) => vote.snapshots.length > 0).length;
  const evidenceCoverage = agreeing.length === 0 ? 0 : cited / agreeing.length;
  const evidenceOverlap = jaccard(agreeing.map((vote) => vote.snapshots));

  // A decisive verdict too weak to count toward agreement is still strong
  // enough to withhold settlement: an open split on direction is exactly the
  // case the dispute path exists for, so it is measured over every reveal.
  //
  // Degraded votes are the one exclusion. The rule above is about a model that
  // answered weakly; a degraded verdict is lexical overlap standing in for a
  // model that never answered. Letting it force a conflict would hand the
  // outcome back to the offline scorer through the withholding door — and cost
  // the creator half the bounty for a transient router failure.
  const opinions = ordered.filter((vote) => !vote.degraded);
  const supported = opinions.filter((vote) => vote.verdict === "SUPPORTED").length;
  const contradicted = opinions.filter((vote) => vote.verdict === "CONTRADICTED").length;
  const criticalConflict = supported > 0 && contradicted > 0;

  // An abstention is the one verdict coherent without a citation: it says the
  // snapshot does not settle the claim, and no span demonstrates an absence.
  // The driver already encodes this — llm.ts requires citations only for an
  // asserting verdict — and `clearsFloor` above makes the matching exemption
  // for the confidence floor. The evidence gate did not, so the three rules
  // disagreed and a claim every verifier honestly abstained on could never
  // agree: it dragged its whole task to CONFLICT.
  //
  // Mainnet task 0xec3b19e5… is the case. Four verifiers returned
  // INSUFFICIENT_EVIDENCE on a claim the sources genuinely do not support —
  // the system refusing to assert something false, which is the behaviour this
  // market exists to sell — and the recorded reason was "only 0/4 agreeing
  // verifiers cited any evidence". The contract then applied conflictRateBps to
  // everyone who revealed, paying a verifier that had scored the whole report
  // offline exactly what it paid the four that ran real inference.
  const abstained = verdict === ABSTENTION;
  const enoughAgreement = agreeingVerifiers.length >= rule.requiredAgreement;
  const enoughCoverage = abstained || evidenceCoverage >= rule.minimumEvidenceCoverage;
  const enoughOverlap = abstained || evidenceOverlap >= rule.minimumEvidenceOverlap;
  const agreed = enoughAgreement && enoughCoverage && enoughOverlap && !criticalConflict;

  return {
    claimId: claim.claimId,
    claimText: claim.claimText,
    majorityVerdict: verdict,
    agreed,
    criticalConflict,
    evidenceCoverage,
    evidenceOverlap,
    agreeingVerifiers,
    dissentingVerifiers,
    verdicts: ordered.map((vote) => ({
      verifier: vote.verifier,
      verdict: vote.verdict,
      confidence: vote.confidence,
    })),
    reason: reasonFor({
      votes: ordered,
      verdict,
      agreeing: agreeingVerifiers.length,
      cited,
      evidenceOverlap,
      criticalConflict,
      supported,
      contradicted,
      enoughAgreement,
      enoughCoverage,
      enoughOverlap,
      rule,
    }),
  };
}

/** The first unmet condition explains the claim; agreement explains itself. */
function reasonFor(args: {
  votes: readonly ClaimVote[];
  verdict: Verdict;
  agreeing: number;
  cited: number;
  evidenceOverlap: number;
  criticalConflict: boolean;
  supported: number;
  contradicted: number;
  enoughAgreement: boolean;
  enoughCoverage: boolean;
  enoughOverlap: boolean;
  rule: ConsensusRule;
}): string {
  const total = args.votes.length;
  if (total === 0) return "no verifier reported on this claim";
  if (args.criticalConflict) {
    return `verifiers split on direction: ${args.supported} SUPPORTED vs ${args.contradicted} CONTRADICTED`;
  }
  if (!args.enoughAgreement) {
    return `only ${args.agreeing}/${total} verifiers share a verdict above the confidence floor`;
  }
  if (!args.enoughCoverage) {
    return `only ${args.cited}/${args.agreeing} agreeing verifiers cited any evidence`;
  }
  if (!args.enoughOverlap) {
    return `agreeing verifiers cite disjoint evidence (overlap ${args.evidenceOverlap.toFixed(
      2,
    )}, floor ${args.rule.minimumEvidenceOverlap.toFixed(2)})`;
  }
  if (args.verdict === ABSTENTION) {
    return `${subject(args.agreeing)} that the sources do not settle this claim`;
  }
  return `${subject(args.agreeing)} on ${args.verdict} with matching evidence`;
}

function voteFor(
  report: VerifierReport,
  claimId: string,
  rule: ConsensusRule,
): ClaimVote | null {
  // The first entry wins if a report repeats a claim: the report's own array
  // order is part of the bytes it committed to, so this stays reproducible.
  const entry = report.claims.find((claim) => claim.claimId === claimId);
  if (!entry) return null;
  return {
    // The report-level identity is the one the chain binds to `msg.sender` on
    // reveal; the per-claim copy is verifier-authored and could differ.
    verifier: report.verifier.address.toLowerCase(),
    verdict: entry.verdict,
    confidence: entry.confidence,
    snapshots: uniqueSorted(entry.sources.map((source) => source.contentHash.toLowerCase())),
    // A verdict the verifier's model never produced does not count.
    //
    // `degraded` marks a claim scored by the offline lexical fallback because
    // the compute call failed. Such a verdict is still listed in `verdicts`, so
    // the failure stays auditable — it simply carries no weight, which through
    // `agreeingVerifiers` also removes it from `rewardedVerifiers`. One flag
    // closes both: a verifier is not paid for work its model did not do.
    //
    // Task 0xa11e3223… (2026-09-05) is why. Two verifiers lost their model on
    // one claim, both fell back, both returned the same wrong SUPPORTED, and
    // the two-two split settled the task CONFLICT — at which point the contract
    // paid all four, including the one that spent nothing on inference.
    //
    // The cost of this is real and intended: enough degraded reports and a task
    // drops below `requiredAgreement` and refunds as NO_QUORUM. A refund is a
    // better answer than a consensus assembled from word overlap.
    degraded: entry.degraded === true,
    counts: entry.degraded !== true && clearsFloor(entry.verdict, entry.confidence, rule),
  };
}

interface RevealedReport {
  report: VerifierReport;
  hash: string;
}

/**
 * One report per verifier, and when a verifier somehow submitted more than one,
 * the lowest hash wins. The tie-break is on content rather than on position
 * because the caller's array order is whatever a database row order happened to
 * be, and it must not be able to change a verdict.
 */
function lowestPerVerifier(entries: readonly RevealedReport[]): RevealedReport[] {
  const kept = new Map<string, RevealedReport>();
  for (const entry of entries) {
    const verifier = entry.report.verifier.address.toLowerCase();
    const seen = kept.get(verifier);
    if (!seen || entry.hash < seen.hash) kept.set(verifier, entry);
  }
  return [...kept.values()];
}

/**
 * Reports that actually count: bound to this task and this manifest, one per
 * verifier. Verifier output is untrusted input (threat model), so a report
 * about some other task or an older manifest is dropped rather than counted.
 */
function revealedReports(input: ConsensusInput): RevealedReport[] {
  const eligible: RevealedReport[] = [];
  input.reports.forEach((report, index) => {
    if (!hashesEqual(report.taskId, input.taskId)) return;
    if (!hashesEqual(report.manifestHash, input.manifestHash)) return;
    eligible.push({ report, hash: (input.reportHashes?.[index] ?? objectHash(report)).toLowerCase() });
  });
  return lowestPerVerifier(eligible).sort((a, b) => ascending(a.hash, b.hash));
}

/**
 * Per-claim agreement for one claim, for callers that render a claim at a time.
 * Duplicates collapse through the same lowest-hash rule `evaluateConsensus`
 * uses, so the two paths cannot disagree about which of a verifier's reports is
 * the one that counts.
 */
export function evaluateClaim(args: {
  claimId: string;
  claimText: string;
  reports: readonly VerifierReport[];
  rule?: ConsensusRule;
}): ClaimConsensus {
  const rule = args.rule ?? DEFAULT_RULE;
  const votes: ClaimVote[] = [];
  for (const { report } of lowestPerVerifier(
    args.reports.map((report) => ({ report, hash: objectHash(report).toLowerCase() })),
  )) {
    const vote = voteFor(report, args.claimId, rule);
    if (vote) votes.push(vote);
  }
  return consensusForVotes({ claimId: args.claimId, claimText: args.claimText }, votes, rule);
}

/**
 * Evaluate a task. `CONSENSUS` only when every claim agrees, `NO_QUORUM` when
 * too few verifiers revealed to compare anything, `CONFLICT` for the rest —
 * the same three outcomes `finalizeConsensus` settles on.
 */
export function evaluateConsensus(input: ConsensusInput): ConsensusResult {
  const rule = input.rule ?? resolveRule(input.ruleId);
  const revealed = revealedReports(input);
  const reports = revealed.map((entry) => entry.report);

  const seenClaims = new Set<string>();
  const claims: ClaimConsensus[] = [];
  for (const claim of input.manifestClaims) {
    if (seenClaims.has(claim.claimId)) continue;
    seenClaims.add(claim.claimId);
    const votes: ClaimVote[] = [];
    for (const report of reports) {
      const vote = voteFor(report, claim.claimId, rule);
      if (vote) votes.push(vote);
    }
    claims.push(consensusForVotes(claim, votes, rule));
  }

  const agreedClaims = claims.filter((claim) => claim.agreed).length;
  const agreementBps =
    claims.length === 0 ? 0 : Math.round((agreedClaims / claims.length) * 10_000);

  const quorum = reports.length >= rule.requiredAgreement;
  const outcome: ConsensusOutcome = !quorum
    ? "NO_QUORUM"
    : claims.length > 0 && agreedClaims === claims.length
      ? "CONSENSUS"
      : "CONFLICT";

  // Only a settled task names beneficiaries. On conflict the contract applies
  // its own `conflictRateBps` to everyone who revealed, so naming a subset here
  // would be the keeper deciding a payout it is not allowed to decide.
  const rewardedVerifiers =
    outcome === "CONSENSUS"
      ? uniqueSorted(
          reports
            .map((report) => report.verifier.address.toLowerCase())
            .filter((verifier) => agreedOnMajority(verifier, claims)),
        )
      : [];

  const result: ConsensusResult = {
    kind: "consensus-result",
    schemaVersion: SCHEMA_VERSION,
    producer: input.producer,
    taskId: input.taskId,
    manifestHash: input.manifestHash,
    ruleId: input.ruleId,
    outcome,
    agreementBps,
    claims,
    conflicts: claims
      .filter((claim) => !claim.agreed)
      .map((claim) => `${claim.claimId}: ${claim.reason}`),
    reportHashes: uniqueSorted(revealed.map((entry) => entry.hash)),
    rewardedVerifiers,
    evaluatedAt: input.evaluatedAt,
  };

  // The result is hashed and pointed at from the chain, so it is validated on
  // the way out rather than on the way back in.
  return ConsensusResult.parse(result);
}

function agreedOnMajority(verifier: string, claims: readonly ClaimConsensus[]): boolean {
  const agreed = claims.filter(
    (claim) => claim.agreed && claim.agreeingVerifiers.includes(verifier),
  ).length;
  return agreed * 2 > claims.length;
}

/* ── rendering helpers ───────────────────────────────────────────────────── */

/** Claim lookup for merging consensus into the API's per-claim view. */
export function claimConsensusById(result: ConsensusResult): Map<string, ClaimConsensus> {
  return new Map(result.claims.map((claim) => [claim.claimId, claim]));
}

/**
 * What the claim row shows. A claim nobody reported on is `PENDING`, not
 * "insufficient evidence" — the difference is whether anyone looked.
 */
export function displayVerdict(
  claim: ClaimConsensus | null | undefined,
): "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT" | "PENDING" {
  if (!claim || claim.verdicts.length === 0) return "PENDING";
  if (claim.majorityVerdict === "SUPPORTED") return "SUPPORTED";
  if (claim.majorityVerdict === "CONTRADICTED") return "CONTRADICTED";
  return "INSUFFICIENT";
}

/**
 * The confidence the UI puts next to a claim: the agreeing verifiers' mean,
 * since that is the number the verdict rests on. Falls back to every reported
 * verdict when nobody agreed, and to null when nobody reported.
 */
export function claimConfidencePct(claim: ClaimConsensus): number | null {
  const agreeing = new Set(claim.agreeingVerifiers);
  const scored = claim.verdicts.filter((entry) => agreeing.has(entry.verifier));
  const sample = scored.length > 0 ? scored : claim.verdicts;
  if (sample.length === 0) return null;
  const mean = sample.reduce((sum, entry) => sum + entry.confidence, 0) / sample.length;
  return Math.round(mean * 100);
}

export function agreementPct(agreementBps: number): number {
  return Math.round(agreementBps / 100);
}

/** The short label in the task table, alongside `agreementPct`. */
export function agreementLabel(outcome: ConsensusOutcome, agreementBps: number): string {
  if (outcome === "NO_QUORUM") return "No quorum";
  if (outcome === "CONSENSUS") return "Full agreement";
  return agreementBps === 0
    ? "No agreement"
    : `Partial agreement ${agreementPct(agreementBps)}%`;
}

/** Verifiers that reported on a claim but not with the majority verdict. */
export function conflictingVerifiers(result: ConsensusResult): string[] {
  return uniqueSorted(result.claims.flatMap((claim) => claim.dissentingVerifiers));
}
