import type { Address, Hex } from "viem";
import {
  ProofRelayError,
  SCHEMA_VERSION,
  TaskStatus,
  hashesEqual,
  objectHash,
  parseArtifact,
  type AdjudicationReport,
  type ChallengeEvidence,
  type ClaimEvidence,
  type ComputeTrace,
  type SourceSnapshot,
  type TaskManifest,
  type VerifierReport,
} from "@proofrelay/schemas";
import { claimConsensusById, evaluateConsensus } from "@proofrelay/consensus";
import type { ChainClient } from "@proofrelay/chain-client";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { ComputeAdapter, EvidenceCorpusEntry } from "@proofrelay/compute-adapter";

export interface AdjudicatorDeps {
  chain: ChainClient;
  storage: StorageAdapter;
  compute: ComputeAdapter;
  evidenceDepth: number;
  supportThreshold: number;
  pollMs: number;
  lookbackBlocks?: bigint;
  /** Chain cadence used to turn the adjudication window into a block range. */
  /**
   * The chain's nominal seconds per block, used to turn the adjudication
   * window into a block range. Supplied from config; the fallback below is
   * deliberately the slower cadence, which over-covers rather than under-covers.
   */
  blockSeconds?: number;
  log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

/**
 * The adjudicator.
 *
 * It is a scoped-trust role, not a truth oracle: it can reallocate a *disputed*
 * task's reward within the bounty it already holds, and every decision carries
 * a stored reason hash and a full second-pass report. It cannot touch a task
 * nobody challenged, and it cannot move value outside the state machine.
 *
 * Its independence is what makes it worth running: a third pipeline
 * configuration, over the same snapshotted bytes, that neither verifier saw.
 * If it agrees with the challenged verifier, the challenge is rejected.
 */
export class Adjudicator {
  private readonly deps: AdjudicatorDeps;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: AdjudicatorDeps) {
    this.deps = deps;
  }

  get address(): Address {
    const account = this.deps.chain.account;
    if (!account) throw new ProofRelayError("NOT_CONFIGURED", "the adjudicator needs a signer");
    return account;
  }

  async start(): Promise<void> {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (error) {
        this.deps.log("error", "adjudicator tick failed", {
          error: String((error as Error).message).slice(0, 300),
        });
      }
      if (this.running) this.timer = setTimeout(loop, this.deps.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    for (const taskId of await this.findDisputed()) {
      // Per-task isolation. `findDisputed` returns the same set every poll, so a
      // single dispute that always throws — a missing snapshot, a malformed
      // challenge, an RPC that will not answer for that task — used to stop the
      // loop at the same place forever and starve every dispute behind it.
      try {
        await this.resolve(taskId);
      } catch (error) {
        this.deps.log("error", "could not resolve a dispute; continuing with the rest", {
          taskId,
          errorCode: (error as { code?: string })?.code ?? "INTERNAL",
          error: String((error as Error).message).slice(0, 300),
        });
      }
    }
  }

  private async findDisputed(): Promise<Hex[]> {
    const head = await this.deps.chain.blockNumber();
    // Derived from the adjudication window, not a fixed block count. 50,000
    // blocks is about 28 hours at Galileo's ~2 s cadence, against a window the
    // contract measures in days — so a dispute opened early enough simply fell
    // out of view and expired unadjudicated. Half again as many blocks as the
    // window needs covers a slower chain too — but only if the cadence passed
    // in is the cadence of the chain actually connected.
    const lookback = this.deps.lookbackBlocks ?? (await this.windowInBlocks());
    const from = head > lookback ? head - lookback : 0n;
    const logs = await this.deps.chain.getLogs(from, head);

    const candidates = new Set<string>();
    for (const log of logs) {
      const topic0 = log.topics[0];
      const taskId = log.topics[1];
      if (topic0 && taskId && this.deps.chain.eventNameForTopic(topic0) === "ChallengeOpened") {
        candidates.add(taskId.toLowerCase());
      }
    }

    const open: Hex[] = [];
    for (const taskId of candidates) {
      const task = await this.deps.chain.getTask(taskId as Hex);
      if (task.status !== TaskStatus.Disputed && task.status !== TaskStatus.Adjudication) continue;
      const dispute = await this.deps.chain.getDispute(taskId as Hex);
      if (dispute.resolved) continue;
      open.push(taskId as Hex);
    }
    return open;
  }

  async resolve(taskId: Hex): Promise<void> {
    const [task, dispute] = await Promise.all([
      this.deps.chain.getTask(taskId),
      this.deps.chain.getDispute(taskId),
    ]);

    const challenge = await this.loadChallenge(dispute.evidencePointer, dispute.evidenceHash);
    const manifest = await this.loadManifest(task.manifestPointer, task.manifestHash);
    const corpus = await this.loadCorpus(manifest);
    const reports = await this.loadReports(taskId);

    if (reports.length === 0) {
      this.deps.log("warn", "no revealed report to adjudicate; leaving the dispute to expire", { taskId });
      return;
    }

    // Only the disputed claims are re-examined. Re-deciding claims nobody
    // challenged would let the adjudicator rewrite a settlement it was never
    // asked about — and falling back to every claim when the list came in empty
    // did precisely that. The schema puts no minimum on `disputedClaims`, so an
    // empty list is reachable input, not an exotic one. A challenge that names
    // nothing is malformed: leave it to expireDispute, which now forfeits part
    // of the bond rather than returning it whole.
    if (challenge.disputedClaims.length === 0) {
      this.deps.log("warn", "the challenge names no disputed claim; leaving it to expire", { taskId });
      return;
    }
    const disputed = manifest.claims.filter((claim) =>
      challenge.disputedClaims.includes(claim.claimId),
    );
    if (disputed.length === 0) {
      this.deps.log("warn", "the challenge names no claim this manifest has; leaving it to expire", {
        taskId,
        named: challenge.disputedClaims.slice(0, 8),
      });
      return;
    }

    const scored = await this.deps.compute.scoreEvidence({
      claims: disputed.map((claim) => ({ claimId: claim.claimId, claimText: claim.claimText })),
      corpus,
      evidenceDepth: this.deps.evidenceDepth,
      supportThreshold: this.deps.supportThreshold,
    });
    const traces: ComputeTrace[] = [scored.trace];

    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    const claims: ClaimEvidence[] = scored.value.map((result) => ({
      taskId,
      claimId: result.claimId,
      claimText: result.claimText,
      verdict: result.verdict,
      confidence: result.confidence,
      sources: result.sources,
      verifier: {
        address: this.address,
        verifierId: "adjudicator",
        // The trace's model, not the configured one: it is the only one that
        // knows whether this pass actually reached 0G Compute.
        modelId: scored.trace.modelId,
        pipelineVersion: this.deps.compute.pipelineVersion,
      },
      reasoningSummary: result.reasoningSummary,
      createdAt,
    }));

    // A challenge is upheld when the second pass overturns the verdict the task
    // actually SETTLED on — not when it disagrees with some individual report.
    //
    // Comparing against every report made a dissenting verifier's own report
    // enough to uphold: on a three-verifier task where A and B agree and C does
    // not, consensus settles on A and B's verdict, and a second pass reproducing
    // it still "disagreed with C". C could challenge its own task, be upheld
    // against itself, and collect the challenger reward — a guaranteed profit
    // for holding a minority view. The per-report comparison still decides who
    // is paid; it no longer decides whether the challenge stands.
    const settled = claimConsensusById(
      evaluateConsensus({
        taskId,
        manifestHash: task.manifestHash,
        ruleId: task.ruleId,
        producer: "proofrelay-adjudicator/1.0.0",
        reports,
        manifestClaims: manifest.claims.map((claim) => ({
          claimId: claim.claimId,
          claimText: claim.claimText,
        })),
        evaluatedAt: createdAt,
      }),
    );

    const overturned: string[] = [];
    for (const claim of claims) {
      const consensus = settled.get(claim.claimId);
      if (consensus && consensus.majorityVerdict !== null && consensus.majorityVerdict !== claim.verdict) {
        overturned.push(
          `${claim.claimId}: the task settled on ${consensus.majorityVerdict}, second pass says ${claim.verdict}`,
        );
      }
    }
    const upheld = overturned.length > 0;

    // Who was wrong, for the payout set. Safe to read `verifier.address` here:
    // loadReports discards any report that does not name the address the chain
    // recorded for it.
    const disagreements: string[] = [...overturned];
    const stillWrong = new Set<string>();
    for (const claim of claims) {
      for (const report of reports) {
        const theirs = report.claims.find((entry) => entry.claimId === claim.claimId);
        if (!theirs) continue;
        if (theirs.verdict !== claim.verdict) {
          stillWrong.add(report.verifier.address.toLowerCase());
        }
      }
    }

    const revised = [
      ...new Set(
        reports
          .map((report) => report.verifier.address)
          .filter((address) => !stillWrong.has(address.toLowerCase()))
          .map((address) => address.toLowerCase()),
      ),
    ] as Address[];

    const decision = upheld
      ? `Challenge upheld. An independent second pass overturned ${overturned.length} settled verdict(s): ${overturned.join("; ")}`
      : `Challenge rejected. An independent second pass reproduced every disputed verdict the task settled on, across ${reports.length} report(s).`;

    const report: AdjudicationReport = {
      kind: "adjudication-report",
      schemaVersion: SCHEMA_VERSION,
      taskId,
      challengeHash: dispute.evidenceHash,
      adjudicator: this.address,
      upheld,
      decision,
      claims,
      compute: traces,
      revisedRewardedVerifiers: revised,
      createdAt,
    };

    const stored = await this.deps.storage.put("adjudication-report", report);
    const reasonHash = objectHash({ decision, disagreements, upheld });

    const receipt = await this.deps.chain.send("resolveDispute", [
      taskId,
      upheld,
      stored.hash,
      stored.pointer,
      revised,
      reasonHash,
    ]);

    this.deps.log("info", upheld ? "challenge upheld" : "challenge rejected", {
      taskId,
      txHash: receipt.txHash,
      adjudicationHash: stored.hash,
      pointer: stored.pointer,
      disagreements: disagreements.length,
      rewarded: revised.length,
    });
  }

  private async loadChallenge(pointer: string, hash: Hex): Promise<ChallengeEvidence> {
    const fetched = await this.deps.storage.get(pointer);
    if (!hashesEqual(fetched.hash, hash)) {
      throw new ProofRelayError("CONTENT_HASH_MISMATCH", "the challenge evidence does not match its onchain hash", {
        detail: { expected: hash, actual: fetched.hash, pointer },
      });
    }
    return parseArtifact("challenge-evidence", JSON.parse(fetched.bytes.toString("utf8"))) as ChallengeEvidence;
  }

  private async loadManifest(pointer: string, hash: Hex): Promise<TaskManifest> {
    const fetched = await this.deps.storage.get(pointer);
    if (!hashesEqual(fetched.hash, hash)) {
      throw new ProofRelayError("CONTENT_HASH_MISMATCH", "the manifest does not match its onchain hash", {
        detail: { expected: hash, actual: fetched.hash, pointer },
      });
    }
    return parseArtifact("task-manifest", JSON.parse(fetched.bytes.toString("utf8"))) as TaskManifest;
  }

  private async loadCorpus(manifest: TaskManifest): Promise<EvidenceCorpusEntry[]> {
    const corpus: EvidenceCorpusEntry[] = [];
    for (const source of manifest.sources) {
      if (source.status !== "OK" && source.status !== "TRUNCATED") continue;
      const fetched = await this.deps.storage.get(source.snapshotPointer);
      if (!hashesEqual(fetched.hash, source.snapshotHash)) {
        // Not `continue`. Skipping a snapshot re-decides the dispute over a
        // SMALLER corpus than the verifiers saw, so a 0G availability failure —
        // or a gateway returning different bytes — could flip the verdict and
        // reallocate the bounty, with nothing in the record saying evidence went
        // missing. A dispute that cannot be re-decided over the exact bytes is
        // left to the permissionless expireDispute path instead.
        throw new ProofRelayError(
          "CONTENT_HASH_MISMATCH",
          "a snapshot in the manifest does not match its recorded hash",
          { detail: { sourceId: source.sourceId, expected: source.snapshotHash, actual: fetched.hash } },
        );
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

  /** Blocks that span the adjudication window, with margin, at the configured cadence. */
  private async windowInBlocks(): Promise<bigint> {
    const { adjudicationWindow } = await this.deps.chain.params();
    const seconds = BigInt(Math.max(adjudicationWindow, 3_600));
    return (seconds * 3n) / (2n * BigInt(this.deps.blockSeconds ?? 2));
  }

  /** Every revealed report, hash-checked. A report whose bytes do not match is not evidence. */
  private async loadReports(taskId: Hex): Promise<VerifierReport[]> {
    const verifiers = await this.deps.chain.getTaskVerifiers(taskId);
    const reports: VerifierReport[] = [];
    for (const verifier of verifiers) {
      const record = await this.deps.chain.getReport(taskId, verifier);
      if (!record.revealed) continue;
      try {
        const fetched = await this.deps.storage.get(record.reportPointer);
        if (!hashesEqual(fetched.hash, record.reportHash)) {
          this.deps.log("warn", "discarding a report whose bytes do not match its onchain hash", {
            taskId,
            verifier,
            expected: record.reportHash,
            actual: fetched.hash,
          });
          continue;
        }
        const parsed = parseArtifact(
          "verifier-report",
          JSON.parse(fetched.bytes.toString("utf8")),
        ) as VerifierReport;
        // The hash check proves the bytes are the ones this verifier committed
        // to — it does not prove the verifier told the truth about who it is.
        // `verifier.address` is a field the verifier chose, and the beneficiary
        // set is built from it: a report naming someone else's address would
        // pay someone else, or pay an address that never verified anything.
        // The loop variable is the chain's own answer, so compare with it.
        if (parsed.verifier.address.toLowerCase() !== verifier.toLowerCase()) {
          this.deps.log("warn", "discarding a report that names a different verifier than the chain", {
            taskId,
            verifier,
            claimed: parsed.verifier.address,
          });
          continue;
        }
        reports.push(parsed);
      } catch (error) {
        this.deps.log("warn", "could not load a revealed report", {
          taskId,
          verifier,
          error: String((error as Error).message).slice(0, 200),
        });
      }
    }
    return reports;
  }
}
