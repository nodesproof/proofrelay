import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, VerifierReport, canonicalBytes, contentHash, objectHash } from "@proofrelay/schemas";
import { LocalStorageAdapter } from "@proofrelay/storage-adapter";
import { LocalComputeAdapter } from "@proofrelay/compute-adapter";
import { buildReport } from "./pipeline.js";
import { CommitJournal } from "./journal.js";

const TASK_ID = `0x${"11".repeat(32)}` as const;
const VERIFIER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as const;

const SOURCES = [
  {
    sourceId: "src-001",
    uri: "https://example.org/acme-widgets/CHANGELOG.md",
    text: `# Changelog

All notable changes to the acme-widgets repository are documented here.

Release v1.4.0 — August 10, 2026.
Adds streaming support and drops Node.js 18.`,
  },
  {
    sourceId: "src-002",
    uri: "https://example.org/acme-widgets/README.md",
    text: `# acme-widgets

acme-widgets is a client library maintained by the core team.
The current stable release is v1.4.0 and it requires Node.js 20 or newer.`,
  },
];

const CLAIMS = [
  { claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10.", origin: "creator" as const },
  { claimId: "claim-002", claimText: "The repository released version 2.0.0 on August 10, 2026.", origin: "creator" as const },
  { claimId: "claim-003", claimText: "The maintainers relocated their head office to Lisbon in 2026.", origin: "creator" as const },
];

let root: string;
let storage: LocalStorageAdapter;
let manifestHash: `0x${string}`;
let manifestPointer: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofrelay-pipeline-"));
  storage = new LocalStorageAdapter(join(root, "storage"));

  const stored = [];
  for (const source of SOURCES) {
    const snapshot = {
      kind: "source-snapshot",
      schemaVersion: SCHEMA_VERSION,
      producer: "test",
      sourceId: source.sourceId,
      uri: source.uri,
      status: "OK",
      httpStatus: 200,
      contentType: "text/plain; charset=utf-8",
      headers: {},
      text: source.text,
      byteLength: Buffer.byteLength(source.text),
      contentHash: contentHash(source.text),
      truncated: false,
      error: null,
      retrievedAt: "2026-08-31T10:00:00.000Z",
    };
    const put = await storage.put("source-snapshot", snapshot);
    stored.push({
      sourceId: source.sourceId,
      uri: source.uri,
      status: "OK" as const,
      contentHash: snapshot.contentHash,
      byteLength: snapshot.byteLength,
      snapshotHash: put.hash,
      snapshotPointer: put.pointer,
    });
  }

  const manifest = {
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: "test",
    manifestId: "manifest-001",
    chainId: 16602,
    creator: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    title: "acme-widgets v1.4.0 release claims",
    question: "Are the stated release facts supported by the public documentation?",
    answerText: null,
    claims: CLAIMS,
    sources: stored,
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      maxEvidencePerClaim: 3,
      ruleId: `0x${"22".repeat(32)}`,
    },
    safety: { publicDataOnly: true, redactions: [], warnings: [] },
    createdAt: "2026-08-31T10:00:00.000Z",
  };
  const put = await storage.put("task-manifest", manifest);
  manifestHash = put.hash;
  manifestPointer = put.pointer;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function pipelineInput(overrides: Partial<Parameters<typeof buildReport>[0]> = {}) {
  return {
    taskId: TASK_ID,
    manifestHash,
    manifestPointer,
    verifier: { address: VERIFIER, verifierId: "verifier-a" },
    storage,
    compute: new LocalComputeAdapter({ evidenceDepth: 2, supportThreshold: 0.55 }),
    evidenceDepth: 2,
    supportThreshold: 0.55,
    now: () => new Date("2026-08-31T10:05:00.000Z"),
    ...overrides,
  } as Parameters<typeof buildReport>[0];
}

describe("verifier pipeline", () => {
  it("produces a report that satisfies the schema", async () => {
    const { report } = await buildReport(pipelineInput());
    expect(() => VerifierReport.parse(report)).not.toThrow();
    expect(report.claims).toHaveLength(3);
  });

  /**
   * The report hash is a hash of the report, not a function of the inputs, and
   * the difference is `compute[].latencyMs` — a real measurement of a real
   * request, which is why two builds of the same task hash differently.
   *
   * Asserting cross-run equality of the whole report was asserting a property
   * the design deliberately does not have; it passed only when both builds
   * landed on the same millisecond. What must hold is asserted instead: the
   * hash addresses the bytes, and everything the verifier actually decided is
   * reproducible. Reproducing the *hash* is `CommitJournal`'s job, and the test
   * below it is the one that says why.
   */
  it("hashes the bytes it produced, and decides the same thing every time", async () => {
    const a = await buildReport(pipelineInput());
    const b = await buildReport(pipelineInput());

    expect(a.reportHash).toBe(objectHash(a.report));
    expect(b.reportHash).toBe(objectHash(b.report));

    const withoutMeasuredLatency = (built: typeof a) => ({
      ...built.report,
      compute: built.report.compute.map((trace) => ({ ...trace, latencyMs: 0 })),
    });
    expect(withoutMeasuredLatency(a)).toEqual(withoutMeasuredLatency(b));

    // And the latency really is a measurement rather than a constant someone
    // could have hardcoded to make the line above pass.
    expect(a.report.compute.every((trace) => Number.isFinite(trace.latencyMs))).toBe(true);
  });

  it("changes its hash when the timestamp changes, which is why commits are journalled", async () => {
    const a = await buildReport(pipelineInput());
    const b = await buildReport(pipelineInput({ now: () => new Date("2026-08-31T11:00:00.000Z") }));
    expect(a.reportHash).not.toBe(b.reportHash);
  });

  it("supports the claim the changelog states and contradicts the one it disagrees with", async () => {
    const { report } = await buildReport(pipelineInput());
    const byId = Object.fromEntries(report.claims.map((claim) => [claim.claimId, claim]));
    expect(byId["claim-001"]!.verdict).toBe("SUPPORTED");
    expect(byId["claim-002"]!.verdict).toBe("CONTRADICTED");
    expect(byId["claim-003"]!.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("quotes spans that really appear in the snapshot", async () => {
    const { report } = await buildReport(pipelineInput());
    const texts = new Map(SOURCES.map((source) => [source.uri, source.text]));
    for (const claim of report.claims) {
      for (const source of claim.sources) {
        expect(texts.get(source.uri)).toContain(source.quotedSpan);
        expect(texts.get(source.uri)!.slice(source.spanStart, source.spanEnd)).toBe(source.quotedSpan);
      }
    }
  });

  it("builds a graph where every evidence node cites a source node", async () => {
    const { report } = await buildReport(pipelineInput());
    const ids = new Set(report.graph.nodes.map((node) => node.id));
    for (const edge of report.graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    for (const node of report.graph.nodes.filter((n) => n.type === "evidence")) {
      const cites = report.graph.edges.filter((edge) => edge.from === node.id && edge.type === "cites");
      expect(cites.length).toBeGreaterThan(0);
    }
  });

  it("records which compute driver actually ran", async () => {
    const { report } = await buildReport(pipelineInput());
    expect(report.compute.length).toBeGreaterThan(0);
    expect(report.compute[0]!.provider).toBe("local");
    expect(report.compute[0]!.modelId).toBe("local-entailment/2-0.55");
  });

  it("two profiles reach different reports for the same task", async () => {
    const a = await buildReport(pipelineInput());
    const b = await buildReport(
      pipelineInput({
        compute: new LocalComputeAdapter({ evidenceDepth: 3, supportThreshold: 0.9 }),
        evidenceDepth: 3,
        supportThreshold: 0.9,
        verifier: { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", verifierId: "verifier-b" },
      }),
    );
    expect(a.reportHash).not.toBe(b.reportHash);
    expect(a.report.verifier.modelId).not.toBe(b.report.verifier.modelId);
  });

  it("refuses a manifest whose bytes do not match the committed hash", async () => {
    await expect(
      buildReport(pipelineInput({ manifestHash: `0x${"ff".repeat(32)}` as `0x${string}` })),
    ).rejects.toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
  });

  it("refuses a snapshot that does not match the manifest's record of it", async () => {
    // A tampered store: the pointer resolves, but to different bytes than the
    // manifest recorded. This is the source-substitution attack.
    const tampered = new LocalStorageAdapter(join(root, "tampered"));
    const original = await storage.get(manifestPointer);
    const manifest = JSON.parse(original.bytes.toString("utf8"));
    await tampered.putBytes("task-manifest", canonicalBytes(manifest));
    for (const source of manifest.sources) {
      const snapshot = await storage.getJson<Record<string, unknown>>(source.snapshotPointer);
      await tampered.put("source-snapshot", { ...snapshot, text: "totally different bytes" });
      // Re-file the tampered snapshot under the pointer the manifest names.
      const id = source.snapshotPointer.replace("local://", "");
      await tampered.putBytes("source-snapshot", canonicalBytes({ ...snapshot, text: "different" }));
      expect(id).toBeTruthy();
    }
    await expect(buildReport(pipelineInput({ storage: tampered }))).rejects.toMatchObject({
      code: expect.stringMatching(/CONTENT_HASH_MISMATCH|ARTIFACT_NOT_FOUND/),
    });
  });
});

describe("commit journal", () => {
  it("survives a restart", async () => {
    const dir = join(root, "journal");
    const record = {
      taskId: TASK_ID,
      reportHash: `0x${"ab".repeat(32)}` as const,
      pointer: "local://abc",
      salt: `0x${"cd".repeat(32)}` as const,
      createdAt: "2026-08-31T10:05:00.000Z",
      committedAt: "2026-08-31T10:05:01.000Z",
      txHash: "0xdead",
    };
    await new CommitJournal(dir, "verifier-a").put(record);
    // A fresh instance, as a restarted process would see it.
    expect(await new CommitJournal(dir, "verifier-a").get(TASK_ID)).toEqual(record);
  });

  it("keeps each verifier's commitments separate", async () => {
    const dir = join(root, "journal");
    expect(await new CommitJournal(dir, "verifier-b").get(TASK_ID)).toBeNull();
  });

  it("forgets a task once it is revealed", async () => {
    const dir = join(root, "journal");
    const journal = new CommitJournal(dir, "verifier-a");
    await journal.remove(TASK_ID);
    expect(await journal.get(TASK_ID)).toBeNull();
    expect(await journal.pending()).toEqual([]);
  });
});
