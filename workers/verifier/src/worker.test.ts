import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { ProofRelayError, SCHEMA_VERSION, TaskStatus, contentHash } from "@proofrelay/schemas";
import type { ChainClient } from "@proofrelay/chain-client";
import { LocalStorageAdapter } from "@proofrelay/storage-adapter";
import { LocalComputeAdapter } from "@proofrelay/compute-adapter";
import { CommitJournal } from "./journal.js";
import { VerifierWorker } from "./worker.js";

const VERIFIER = "0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA" as const;
const DOOMED = `0x${"11".repeat(32)}` as Hex;
const HEALTHY = `0x${"22".repeat(32)}` as Hex;

const SOURCE_TEXT = `# Changelog

Release v1.4.0 — August 10, 2026.`;

let root: string;
let storage: LocalStorageAdapter;
let manifestHash: Hex;
let manifestPointer: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proofrelay-worker-"));
  storage = new LocalStorageAdapter(join(root, "storage"));

  const snapshot = {
    kind: "source-snapshot",
    schemaVersion: SCHEMA_VERSION,
    producer: "test",
    sourceId: "src-001",
    uri: "https://example.org/CHANGELOG.md",
    status: "OK",
    httpStatus: 200,
    contentType: "text/plain; charset=utf-8",
    headers: {},
    text: SOURCE_TEXT,
    byteLength: Buffer.byteLength(SOURCE_TEXT),
    contentHash: contentHash(SOURCE_TEXT),
    truncated: false,
    error: null,
    retrievedAt: "2026-08-31T10:00:00.000Z",
  };
  const snapshotPut = await storage.put("source-snapshot", snapshot);
  const manifest = {
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: "test",
    manifestId: "manifest-001",
    chainId: 16602,
    creator: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    title: "worker isolation",
    question: "Are the stated release facts supported?",
    answerText: null,
    claims: [{ claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10.", origin: "creator" }],
    sources: [
      {
        sourceId: "src-001",
        uri: snapshot.uri,
        status: "OK" as const,
        contentHash: snapshot.contentHash,
        byteLength: snapshot.byteLength,
        snapshotHash: snapshotPut.hash,
        snapshotPointer: snapshotPut.pointer,
      },
    ],
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: 900,
      revealWindowSec: 900,
      disputeWindowSec: 900,
      maxEvidencePerClaim: 3,
      ruleId: `0x${"33".repeat(32)}`,
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

/**
 * Only the surface `tick()` reaches: two live tasks, no commitment on either,
 * and a `send` that refuses the first one the way the live chain refused a task
 * that was cancelled while its report was being built.
 */
function fakeChain(refuse: (taskId: Hex) => boolean) {
  const sent: string[] = [];
  const task = (taskId: Hex) => ({
    creator: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    bounty: 10n ** 15n,
    verifierCount: 2,
    committedCount: 0,
    revealedCount: 0,
    status: TaskStatus.Open,
    outcome: 0,
    commitDeadline: 4_000_000_000,
    revealDeadline: 4_000_000_100,
    disputeWindow: 900,
    consensusAt: 0,
    manifestHash,
    manifestPointer,
    ruleId: `0x${"33".repeat(32)}`,
    resultHash: `0x${"0".repeat(64)}`,
    rewardBps: 0,
    taskId,
  });
  return {
    sent,
    chain: {
      account: VERIFIER,
      async blockNumber() { return 100n; },
      async getLogs() { return []; },
      eventNameForTopic() { return null; },
      async getTask(taskId: Hex) { return task(taskId); },
      async getReport() { return { verifier: VERIFIER, commitment: `0x${"0".repeat(64)}`, revealed: false, reportHash: `0x${"0".repeat(64)}`, reportPointer: "", committedAt: 0, revealedAt: 0 }; },
      async getVerifier() { return { registered: true, approved: true, active: true, stake: 0n, metadataHash: `0x${"0".repeat(64)}`, metadataPointer: "" }; },
      async send(fn: string, args: readonly unknown[]) {
        const taskId = args[0] as Hex;
        if (refuse(taskId)) throw new ProofRelayError("CHAIN_REVERTED", `${fn} would revert`, { retryable: false });
        sent.push(`${fn}:${taskId}`);
        return { txHash: `0x${"ab".repeat(32)}` as Hex, blockNumber: 1n, gasUsed: 1n, status: "success" as const };
      },
    } as unknown as ChainClient,
  };
}

function worker(chain: ChainClient, journalName: string, logs: string[][]) {
  return new VerifierWorker({
    chain,
    storage,
    compute: new LocalComputeAdapter({ evidenceDepth: 2, supportThreshold: 0.55 }),
    journal: new CommitJournal(join(root, "journal"), journalName),
    verifierId: "verifier-a",
    evidenceDepth: 2,
    supportThreshold: 0.55,
    pollMs: 1_000,
    lookbackBlocks: 100n,
    log: (level, message, fields) => logs.push([level, message, String(fields?.taskId ?? "")]),
  });
}

describe("verifier worker", () => {
  let logs: string[][];
  beforeEach(() => {
    logs = [];
  });

  /**
   * The regression this file exists for. A task cancelled mid-build makes
   * `commitReport` revert; before the per-task catch that exception escaped
   * `tick()` and every task after it in the batch was skipped — silently, once
   * per poll, for as long as the doomed task stayed live.
   */
  it("keeps working after one task's commit reverts", async () => {
    const { chain, sent } = fakeChain((taskId) => taskId === DOOMED);
    const subject = worker(chain, "isolation", logs);
    // findWork reads the journal for pending commitments; seeding it is how the
    // two tasks get into one batch without a log fixture.
    const journal = new CommitJournal(join(root, "journal"), "isolation");
    for (const taskId of [DOOMED, HEALTHY]) {
      await journal.put({
        taskId,
        reportHash: `0x${"cd".repeat(32)}`,
        pointer: "local://seed",
        salt: `0x${"ef".repeat(32)}`,
        createdAt: "2026-08-31T10:00:00.000Z",
        committedAt: null,
        txHash: null,
      });
    }

    await expect(subject.tick()).resolves.toBeUndefined();

    expect(sent).toContain(`commitReport:${HEALTHY}`);
    expect(sent).not.toContain(`commitReport:${DOOMED}`);
    const skipped = logs.filter(([level, message]) => level === "warn" && message === "skipping a task this tick");
    expect(skipped.map((entry) => entry[2])).toEqual([DOOMED]);
  }, 30_000);

  /**
   * An idle verifier reaches the "holding rewards" branch on every poll. Logging
   * it unconditionally filled 99% of a live log file with one repeated sentence
   * — 2,189 of 2,208 lines — which buries the nineteen that say something.
   */
  it("logs a held balance once, not once per poll", async () => {
    const { chain } = fakeChain(() => false);
    const held = { allocation: 400_000_000_000_000n };
    const holding = {
      ...chain,
      async allocationOf() { return held.allocation; },
      async pendingWithdrawals() { return 0n; },
    } as unknown as ChainClient;

    const subject = worker(holding, "holding", logs);
    const said = () => logs.filter(([, message]) => message.startsWith("holding rewards")).length;

    for (let poll = 0; poll < 5; poll += 1) await subject.collect([HEALTHY]);
    expect(said()).toBe(1);

    // A different amount is a different fact, and is reported again.
    held.allocation = 500_000_000_000_000n;
    await subject.collect([HEALTHY]);
    expect(said()).toBe(2);
  });

  it("still surfaces a failure rather than swallowing it silently", async () => {
    const { chain } = fakeChain(() => true);
    const subject = worker(chain, "all-refused", logs);
    const journal = new CommitJournal(join(root, "journal"), "all-refused");
    await journal.put({
      taskId: DOOMED,
      reportHash: `0x${"cd".repeat(32)}`,
      pointer: "local://seed",
      salt: `0x${"ef".repeat(32)}`,
      createdAt: "2026-08-31T10:00:00.000Z",
      committedAt: null,
      txHash: null,
    });

    await subject.tick();
    expect(logs.some(([level, message]) => level === "warn" && message === "skipping a task this tick")).toBe(true);
  }, 30_000);
});
