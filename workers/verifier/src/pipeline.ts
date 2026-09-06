import {
  ProofRelayError,
  SCHEMA_VERSION,
  hashesEqual,
  objectHash,
  parseArtifact,
  type ClaimEvidence,
  type ComputeTrace,
  type EvidenceGraph,
  type SourceSnapshot,
  type TaskManifest,
  type VerifierReport,
} from "@proofrelay/schemas";
import type { ComputeAdapter, EvidenceCorpusEntry } from "@proofrelay/compute-adapter";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { Address, Hex } from "viem";

export interface PipelineInput {
  taskId: Hex;
  manifestHash: Hex;
  manifestPointer: string;
  verifier: { address: Address; verifierId: string };
  storage: StorageAdapter;
  compute: ComputeAdapter;
  evidenceDepth: number;
  supportThreshold: number;
  /** Injected so a report is reproducible from its inputs in a test. */
  now: () => Date;
}

/**
 * Manifest -> snapshots -> compute -> report.
 *
 * The manifest is hash-checked before anything is read out of it, and each
 * snapshot is hash-checked against the manifest's record of it. That is the
 * property that makes two verifiers comparable at all: they are not merely
 * looking at the same URL, they are provably looking at the same bytes, so a
 * source that changed mid-task cannot split them.
 */
export async function buildReport(input: PipelineInput): Promise<{
  report: VerifierReport;
  reportHash: Hex;
  traces: ComputeTrace[];
}> {
  const manifest = await loadManifest(input);
  const corpus = await loadCorpus(input, manifest);

  const traces: ComputeTrace[] = [];
  const claims = manifest.claims.map((claim) => ({ claimId: claim.claimId, claimText: claim.claimText }));

  // The manifest already carries the creator's claims. Extraction only runs
  // when it does not — inventing claims the creator never made would put words
  // in their mouth and settle a task they did not post.
  const resolvedClaims = claims.length
    ? claims
    : await (async () => {
        const extracted = await input.compute.runClaimExtraction({
          question: manifest.question,
          answerText: manifest.answerText,
          corpus,
          maxClaims: 50,
        });
        traces.push(extracted.trace);
        return extracted.value;
      })();

  const scored = await input.compute.scoreEvidence({
    claims: resolvedClaims,
    corpus,
    evidenceDepth: input.evidenceDepth,
    supportThreshold: input.supportThreshold,
  });
  traces.push(scored.trace);

  const createdAt = input.now().toISOString();
  const evidence: ClaimEvidence[] = scored.value.map((result) => ({
    taskId: input.taskId,
    claimId: result.claimId,
    claimText: result.claimText,
    verdict: result.verdict,
    confidence: result.confidence,
    sources: result.sources.map((source) => ({
      uri: source.uri,
      snapshotObjectId: source.snapshotObjectId,
      contentHash: source.contentHash,
      quotedSpan: source.quotedSpan,
      spanStart: source.spanStart,
      spanEnd: source.spanEnd,
      score: source.score,
      retrievedAt: source.retrievedAt,
    })),
    verifier: {
      address: input.verifier.address,
      verifierId: input.verifier.verifierId,
      // The trace's model, not the adapter's configured one. `compute.modelId`
      // is a getter that knows nothing about degradation, so a report whose
      // verdicts all came from the offline fallback still named the 0G model —
      // and `verifier.modelId` is what a reader uses to judge reproducibility.
      modelId: scored.trace.modelId,
      pipelineVersion: input.compute.pipelineVersion,
    },
    reasoningSummary: result.reasoningSummary,
    ...(result.degraded ? { degraded: true } : {}),
    createdAt,
  }));

  const report: VerifierReport = {
    kind: "verifier-report",
    schemaVersion: SCHEMA_VERSION,
    taskId: input.taskId,
    manifestHash: input.manifestHash,
    manifestPointer: input.manifestPointer,
    verifier: {
      address: input.verifier.address,
      verifierId: input.verifier.verifierId,
      // The trace's model, not the adapter's configured one. `compute.modelId`
      // is a getter that knows nothing about degradation, so a report whose
      // verdicts all came from the offline fallback still named the 0G model —
      // and `verifier.modelId` is what a reader uses to judge reproducibility.
      modelId: scored.trace.modelId,
      pipelineVersion: input.compute.pipelineVersion,
    },
    claims: evidence,
    graph: buildGraph(evidence),
    compute: traces,
    summary: summarize(evidence),
    createdAt,
  };

  return { report, reportHash: objectHash(report), traces };
}

async function loadManifest(input: PipelineInput): Promise<TaskManifest> {
  const fetched = await input.storage.get(input.manifestPointer);
  if (!hashesEqual(fetched.hash, input.manifestHash)) {
    throw new ProofRelayError(
      "CONTENT_HASH_MISMATCH",
      "the manifest at this pointer is not the manifest the task committed to",
      { detail: { expected: input.manifestHash, actual: fetched.hash, pointer: input.manifestPointer } },
    );
  }
  return parseArtifact("task-manifest", JSON.parse(fetched.bytes.toString("utf8"))) as TaskManifest;
}

async function loadCorpus(input: PipelineInput, manifest: TaskManifest): Promise<EvidenceCorpusEntry[]> {
  const corpus: EvidenceCorpusEntry[] = [];
  for (const source of manifest.sources) {
    if (source.status !== "OK" && source.status !== "TRUNCATED") continue;
    const fetched = await input.storage.get(source.snapshotPointer);
    if (!hashesEqual(fetched.hash, source.snapshotHash)) {
      throw new ProofRelayError("CONTENT_HASH_MISMATCH", `snapshot ${source.sourceId} does not match the manifest`, {
        detail: { expected: source.snapshotHash, actual: fetched.hash, sourceId: source.sourceId },
      });
    }
    const snapshot = parseArtifact(
      "source-snapshot",
      JSON.parse(fetched.bytes.toString("utf8")),
    ) as SourceSnapshot;
    corpus.push({
      sourceId: snapshot.sourceId,
      uri: snapshot.uri,
      snapshotObjectId: source.snapshotPointer,
      contentHash: snapshot.contentHash,
      text: snapshot.text,
      retrievedAt: snapshot.retrievedAt,
    });
  }
  return corpus;
}

const EDGE_FOR: Record<string, "supports" | "contradicts" | "insufficient"> = {
  SUPPORTED: "supports",
  CONTRADICTED: "contradicts",
  INSUFFICIENT_EVIDENCE: "insufficient",
};

/**
 * The claim-evidence graph. Every evidence node points at the source it was
 * quoted from, which is what lets a reader walk backwards from a verdict to
 * bytes rather than taking the verdict's word for it.
 */
function buildGraph(claims: ClaimEvidence[]): EvidenceGraph {
  const nodes: EvidenceGraph["nodes"] = [];
  const edges: EvidenceGraph["edges"] = [];
  const sources = new Set<string>();

  for (const claim of claims) {
    nodes.push({
      id: claim.claimId,
      type: "claim",
      label: claim.claimText,
      confidence: claim.confidence,
      verdict: claim.verdict,
    });
    claim.sources.forEach((source, index) => {
      const evidenceId = `${claim.claimId}-ev-${index + 1}`;
      const sourceId = `source:${source.contentHash}`;
      nodes.push({
        id: evidenceId,
        type: "evidence",
        label: source.quotedSpan,
        // The span's own score, not the claim's confidence: how well this
        // particular quote matched is what a reader is inspecting here.
        confidence: source.score,
        verdict: claim.verdict,
      });
      if (!sources.has(sourceId)) {
        sources.add(sourceId);
        nodes.push({ id: sourceId, type: "source", label: source.uri, confidence: null, verdict: null });
      }
      edges.push({
        from: claim.claimId,
        to: evidenceId,
        type: EDGE_FOR[claim.verdict] ?? "insufficient",
        weight: source.score,
      });
      edges.push({ from: evidenceId, to: sourceId, type: "cites", weight: 1 });
    });
  }
  return { nodes, edges };
}

function summarize(claims: ClaimEvidence[]): VerifierReport["summary"] {
  const supported = claims.filter((claim) => claim.verdict === "SUPPORTED").length;
  const contradicted = claims.filter((claim) => claim.verdict === "CONTRADICTED").length;
  const insufficient = claims.length - supported - contradicted;
  const withEvidence = claims.filter((claim) => claim.sources.length > 0).length;
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    supported,
    contradicted,
    insufficient,
    meanConfidence: claims.length
      ? round(claims.reduce((total, claim) => total + claim.confidence, 0) / claims.length)
      : 0,
    evidenceCoverage: claims.length ? round(withEvidence / claims.length) : 0,
  };
}
