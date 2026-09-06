import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { ProofRelayError, TaskStatus, withRetry } from "@proofrelay/schemas";
import { ChainClient, computeCommitment } from "@proofrelay/chain-client";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { ComputeAdapter } from "@proofrelay/compute-adapter";
import { buildReport } from "./pipeline.js";
import { CommitJournal, type CommitRecord } from "./journal.js";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/** Roughly twice what one claim-and-withdraw costs on Galileo at 4 gwei. */
export const DEFAULT_MIN_COLLECT_WEI = 2_000_000_000_000_000n; // 0.002 0G

export interface WorkerDeps {
  chain: ChainClient;
  storage: StorageAdapter;
  compute: ComputeAdapter;
  journal: CommitJournal;
  verifierId: string;
  evidenceDepth: number;
  supportThreshold: number;
  pollMs: number;
  /** How far back to scan for tasks on each poll. */
  lookbackBlocks?: bigint;
  /** Hold rewards until the unclaimed total reaches this, so gas never exceeds it. */
  minCollectWei?: bigint;
  log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface TaskWork {
  taskId: Hex;
  manifestHash: Hex;
  manifestPointer: string;
  status: number;
  commitDeadline: number;
  revealDeadline: number;
}

/**
 * A verifier worker: find open tasks, build a report from the snapshotted
 * sources, commit its hash, and reveal once every verifier is committed.
 *
 * Work is discovered from the chain rather than from the API on purpose. A
 * verifier that trusted the API's task list could be starved or fed by a
 * compromised API, and the threat model says the API is not trusted.
 */
export class VerifierWorker {
  private readonly deps: WorkerDeps;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * The unclaimed total the "holding rewards" line last reported.
   *
   * That branch is reached on every poll, and an idle verifier polls for hours.
   * Logging it unconditionally wrote the same sentence ~19,000 times a day —
   * 99% of the file — which does not make the state easier to see, it makes
   * every other line harder to find. Log the change, not the condition.
   */
  private lastHeldWei: bigint | null = null;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  get address(): Address {
    const account = this.deps.chain.account;
    if (!account) throw new ProofRelayError("NOT_CONFIGURED", "the verifier worker needs a signer");
    return account;
  }

  async start(): Promise<void> {
    this.running = true;
    // Registration failing must not take the process down. `registerVerifier` is
    // a chain write, so a cold RPC or a momentary outage threw straight out of
    // start() — and under a supervisor that is a crash-loop that never reaches
    // the poll loop, so the worker cannot even report why. Log it and carry on:
    // the next tick retries, and commitReport refuses an unregistered verifier
    // anyway, so nothing unsafe proceeds.
    try {
      await this.ensureRegistered();
    } catch (error) {
      this.deps.log("error", "could not register on startup; will retry on the next tick", {
        verifierId: this.deps.verifierId,
        error: String((error as Error).message).slice(0, 300),
      });
    }
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (error) {
        this.deps.log("error", "verifier tick failed", {
          verifierId: this.deps.verifierId,
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

  /**
   * Self-registration. Approval is a separate admin action — the MVP's sybil
   * defence is an allow-list — so an unapproved worker is inert. Saying that
   * here makes it legible in the logs instead of surfacing later as a
   * mysterious VerifierNotActive revert.
   */
  async ensureRegistered(): Promise<void> {
    const record = await this.deps.chain.getVerifier(this.address);
    if (!record.registered) {
      const metadata = {
        kind: "verifier-metadata",
        verifierId: this.deps.verifierId,
        address: this.address,
        modelId: this.deps.compute.modelId,
        pipelineVersion: this.deps.compute.pipelineVersion,
        evidenceDepth: this.deps.evidenceDepth,
        supportThreshold: this.deps.supportThreshold,
      };
      const stored = await this.deps.storage.put("verifier-report", metadata);
      const receipt = await this.deps.chain.send("registerVerifier", [stored.hash, stored.pointer]);
      this.deps.log("info", "registered verifier", {
        verifierId: this.deps.verifierId,
        txHash: receipt.txHash,
        pointer: stored.pointer,
      });
    }
    const after = await this.deps.chain.getVerifier(this.address);
    if (!after.approved) {
      this.deps.log(
        "warn",
        "registered but not approved; commits will revert until an admin runs setVerifierApproval",
        { verifierId: this.deps.verifierId, address: this.address },
      );
    }
  }

  /**
   * One task's failure must not starve the others. Building a report takes long
   * enough — snapshots fetched, evidence scored, the report uploaded — that the
   * task can be cancelled or settled out from under it, and `commitReport` then
   * reverts. That is a race the chain cannot be asked to prevent; what it must
   * not do is stop the verifier from working on everything else in the batch,
   * which is exactly what it did until this loop caught per task.
   */
  async tick(): Promise<void> {
    const { work: live, settled } = await this.findWork();
    for (const work of live) {
      try {
        await this.advance(work);
      } catch (error) {
        this.deps.log("warn", "skipping a task this tick", {
          taskId: work.taskId,
          verifierId: this.deps.verifierId,
          errorCode: (error as { code?: string }).code ?? "INTERNAL",
          error: String((error as Error).message).slice(0, 200),
        });
      }
    }

    // Earnings do not collect themselves. `collect` skips a task this verifier
    // has no allocation on, and holds off until the total is worth the two
    // transactions it takes — see minCollectWei.
    if (settled.length) {
      try {
        await this.collect(settled);
      } catch (error) {
        this.deps.log("warn", "could not collect rewards this tick", {
          verifierId: this.deps.verifierId,
          error: String((error as Error).message).slice(0, 200),
        });
      }
    }
  }

  /**
   * Live work, and the settled tasks seen in the same scan.
   *
   * The settled ones used to be dropped here — the journal entry removed and the
   * id forgotten — which is where a verifier's earnings went to die: the reward
   * is allocated on the task and stays there until someone pulls it, and nothing
   * in the running loop ever did.
   */
  private async findWork(): Promise<{ work: TaskWork[]; settled: Hex[] }> {
    const head = await this.deps.chain.blockNumber();
    const lookback = this.deps.lookbackBlocks ?? 20_000n;
    const from = head > lookback ? head - lookback : 0n;
    const logs = await this.deps.chain.getLogs(from, head);

    const taskIds = new Set<string>();
    for (const log of logs) {
      const topic0 = log.topics[0];
      const taskId = log.topics[1];
      if (topic0 && taskId && this.deps.chain.eventNameForTopic(topic0) === "TaskCreated") {
        taskIds.add(taskId.toLowerCase());
      }
    }
    // A commitment outlives the lookback window: a task committed to hours ago
    // still needs its reveal.
    for (const record of await this.deps.journal.pending()) taskIds.add(record.taskId.toLowerCase());

    const work: TaskWork[] = [];
    const settled: Hex[] = [];
    for (const taskId of taskIds) {
      const task = await this.deps.chain.getTask(taskId as Hex);
      const live =
        task.status === TaskStatus.Open ||
        task.status === TaskStatus.Committing ||
        task.status === TaskStatus.Revealing;
      if (!live) {
        settled.push(taskId as Hex);
        await this.deps.journal.remove(taskId as Hex);
        continue;
      }
      work.push({
        taskId: taskId as Hex,
        manifestHash: task.manifestHash,
        manifestPointer: task.manifestPointer,
        status: task.status,
        commitDeadline: task.commitDeadline,
        revealDeadline: task.revealDeadline,
      });
    }
    return { work, settled };
  }

  /**
   * Chain time, falling back to the host clock.
   *
   * `commitDeadline` and `revealDeadline` are `block.timestamp` values, and the
   * contract compares them against `block.timestamp` — so judging them against
   * this machine's clock decided on a different number than the chain will. A
   * host running fast skips a commit window that is still open; a host running
   * slow lets the worker believe it can still reveal and then delete the salt
   * when the reveal reverts. The salt is not recoverable, so the cost of being
   * wrong here is a forfeited task.
   */
  private async nowSec(): Promise<number> {
    if (this.deps.now) return Math.floor(this.deps.now().getTime() / 1000);
    try {
      return await this.deps.chain.blockTimestamp(await this.deps.chain.blockNumber());
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  private async advance(work: TaskWork): Promise<void> {
    const report = await this.deps.chain.getReport(work.taskId, this.address);
    const now = await this.nowSec();

    if (report.commitment === ZERO_HASH) {
      if (now >= work.commitDeadline) return;
      await this.commit(work);
      return;
    }
    if (report.revealed) {
      await this.deps.journal.remove(work.taskId);
      return;
    }
    if (now >= work.revealDeadline) {
      this.deps.log("warn", "missed the reveal window; this verifier earns nothing on this task", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
      });
      await this.deps.journal.remove(work.taskId);
      return;
    }
    await this.reveal(work, report.commitment);
  }

  private async commit(work: TaskWork): Promise<void> {
    // A journalled commitment is never rebuilt. `chain.send` can throw after the
    // transaction is already in the mempool — waiting for a receipt on a
    // congested public chain times out routinely — and rebuilding would produce
    // a new report (its bytes carry their own build timestamp), a new hash, and
    // a new salt. Committing that reverts AlreadyCommitted, and the journal now
    // holds a salt for a commitment the chain does not have: the task can never
    // be revealed and the honest work is forfeit. Re-sending the same commitment
    // is idempotent — it either lands or reverts AlreadyCommitted, and both mean
    // the one we can reveal is on chain.
    const existing = await this.deps.journal.get(work.taskId);
    if (existing) {
      await this.resend(work, existing);
      return;
    }

    const record = await this.deps.chain.getVerifier(this.address);
    if (!record.approved || !record.active) {
      this.deps.log("warn", "skipping a task: this verifier is not approved and active", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
      });
      return;
    }

    const now = this.deps.now ?? (() => new Date());
    const { report, reportHash } = await buildReport({
      taskId: work.taskId,
      manifestHash: work.manifestHash,
      manifestPointer: work.manifestPointer,
      verifier: { address: this.address, verifierId: this.deps.verifierId },
      storage: this.deps.storage,
      compute: this.deps.compute,
      evidenceDepth: this.deps.evidenceDepth,
      supportThreshold: this.deps.supportThreshold,
      now,
    });

    // Say out loud when the model was not what answered.
    //
    // The compute adapter has no logger, so until now a failed router call was
    // recorded in the report trace and nowhere else: the worker carried on,
    // committed, revealed and was paid, and the only way to discover it was to
    // open the artifact. On mainnet task 0xa11e3223… (2026-09-05) that is
    // exactly what happened — a transient compute failure, no log line, and a
    // wrong verdict published under the model's name.
    const degradedClaims = report.claims.filter((claim) => claim.degraded).map((claim) => claim.claimId);
    const wholeCall = report.compute.some((trace) => /fallback:local/.test(trace.provider));
    if (wholeCall || degradedClaims.length > 0) {
      this.deps.log("warn", wholeCall ? "compute failed; the whole report was scored offline" : "some claims were scored offline", {
        verifierId: this.deps.verifierId,
        taskId: work.taskId,
        modelId: report.verifier.modelId,
        provider: report.compute.map((trace) => trace.provider).join(", "),
        // The reason the driver kept. Without it this line said a verifier had
        // fallen back and left the operator to guess between a dead key, an
        // unroutable model and a refused response — three unrelated fixes.
        reason: report.compute.map((trace) => trace.degradedReason).filter(Boolean).join("; ") || null,
        degradedClaims,
        // Neither counts toward consensus nor earns a share, so this is lost
        // revenue as well as lost signal.
        of: report.claims.length,
      });
    }

    // Upload before committing: a commitment to a report nobody can fetch is
    // worthless, and the upload is the step most likely to fail.
    const stored = await withRetry(() => this.deps.storage.put("verifier-report", report), { attempts: 3 });
    if (stored.hash.toLowerCase() !== reportHash.toLowerCase()) {
      throw new ProofRelayError("CONTENT_HASH_MISMATCH", "the stored report does not hash to the computed hash", {
        detail: { computed: reportHash, stored: stored.hash },
      });
    }

    // Random, not derived. The salt is the only thing hiding a commitment:
    // `commitment = keccak(taskId, verifier, reportHash, salt)`, and taskId and
    // verifier are both public. A salt derived from the worker's address and its
    // profile id was public too, which let anyone TEST a guess — build a
    // candidate report, compute its hash, recompute the salt, and compare
    // against the commitment on chain. Against a deterministic pipeline whose
    // evidenceDepth and supportThreshold are published in the verifier's own 0G
    // Storage metadata, that is not a guess, it is a reproduction: a second
    // verifier could read the first one's answer before reveal and copy it,
    // which is the one thing commit-reveal exists to prevent.
    //
    // Nothing is lost by making it random. Recovery across a restart never came
    // from recomputing the salt — CommitJournal persists it precisely because a
    // rebuilt report would carry a new timestamp and hash differently.
    const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
    const commitment = computeCommitment({ taskId: work.taskId, verifier: this.address, reportHash, salt });

    // Journalled before the transaction, not after. A commitment that landed
    // onchain while the process died is recoverable; a journal entry for a
    // transaction that never landed is harmless — the next tick sees no
    // commitment onchain and rebuilds.
    await this.deps.journal.put({
      taskId: work.taskId,
      reportHash,
      pointer: stored.pointer,
      salt,
      createdAt: report.createdAt,
      committedAt: new Date().toISOString(),
      txHash: "",
    });

    const receipt = await this.deps.chain.send("commitReport", [work.taskId, commitment]);
    await this.deps.journal.put({
      taskId: work.taskId,
      reportHash,
      pointer: stored.pointer,
      salt,
      createdAt: report.createdAt,
      committedAt: new Date().toISOString(),
      txHash: receipt.txHash,
    });

    this.deps.log("info", "committed report", {
      taskId: work.taskId,
      verifierId: this.deps.verifierId,
      txHash: receipt.txHash,
      reportHash,
      pointer: stored.pointer,
      claims: report.claims.length,
      supported: report.summary.supported,
      contradicted: report.summary.contradicted,
      insufficient: report.summary.insufficient,
      computeProvider: report.compute[0]?.provider ?? null,
    });
  }

  /**
   * Re-sends a commitment we already journalled, without rebuilding the report.
   * AlreadyCommitted is the success case: it means the earlier attempt landed.
   */
  private async resend(work: TaskWork, record: CommitRecord): Promise<void> {
    const commitment = computeCommitment({
      taskId: work.taskId,
      verifier: this.address,
      reportHash: record.reportHash,
      salt: record.salt,
    });
    try {
      const receipt = await this.deps.chain.send("commitReport", [work.taskId, commitment]);
      await this.deps.journal.put({ ...record, txHash: receipt.txHash });
      this.deps.log("info", "re-sent a journalled commitment", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
        txHash: receipt.txHash,
      });
    } catch (error) {
      if (/AlreadyCommitted/i.test(String((error as Error).message))) {
        this.deps.log("info", "the journalled commitment was already onchain", {
          taskId: work.taskId,
          verifierId: this.deps.verifierId,
        });
        return;
      }
      throw error;
    }
  }

  private async reveal(work: TaskWork, onchainCommitment: Hex): Promise<void> {
    const journalled = await this.deps.journal.get(work.taskId);
    if (!journalled) {
      // The commitment is onchain but this worker no longer knows what it
      // promised. Rebuilding would produce a report with a fresh timestamp and
      // a different hash, so the reveal would revert. Say so plainly.
      this.deps.log("error", "committed to this task but the commit journal entry is gone; cannot reveal", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
        commitment: onchainCommitment,
      });
      return;
    }

    const expected = computeCommitment({
      taskId: work.taskId,
      verifier: this.address,
      reportHash: journalled.reportHash,
      salt: journalled.salt,
    });
    if (expected.toLowerCase() !== onchainCommitment.toLowerCase()) {
      this.deps.log("error", "the journalled commitment does not match the chain; refusing to reveal", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
        journalled: expected,
        onchain: onchainCommitment,
      });
      return;
    }

    try {
      const receipt = await this.deps.chain.send("revealReport", [
        work.taskId,
        journalled.reportHash,
        journalled.pointer,
        journalled.salt,
      ]);
      await this.deps.journal.remove(work.taskId);
      this.deps.log("info", "revealed report", {
        taskId: work.taskId,
        verifierId: this.deps.verifierId,
        txHash: receipt.txHash,
        reportHash: journalled.reportHash,
      });
    } catch (error) {
      // revealReport reverts while any commit slot is still open and the commit
      // window is running. That is the anti-copying rule working, not a failure.
      const reason = (error as ProofRelayError).detail?.reason;
      if (typeof reason === "string" && /TooEarly|CommitWindow|NotOpen|RevealNotOpen/i.test(reason)) {
        this.deps.log("info", "reveal not open yet; waiting for the remaining commitments", {
          taskId: work.taskId,
          verifierId: this.deps.verifierId,
        });
        return;
      }
      throw error;
    }
  }

  /**
   * Claim what this verifier has earned on the given tasks, then withdraw.
   *
   * Held back until it is worth doing. Payouts are pull-based, so collecting
   * costs one `claimReward` per task plus one `withdraw` — on Galileo that is
   * around 0.0009 0G at 4 gwei, which is more than a single minimum-bounty task
   * pays a verifier. Claiming eagerly would mean spending more gas than the
   * reward is worth, every time. So nothing moves until the unclaimed total
   * clears `minCollectWei`, and then it moves in one batch: N claims and a
   * single withdraw amortised over all of them.
   *
   * Set `VERIFIER_MIN_COLLECT_WEI=0` to collect eagerly regardless.
   */
  async collect(taskIds: Hex[]): Promise<{ claimed: Hex[]; withdrawnWei: bigint }> {
    const claimable: Hex[] = [];
    let total = 0n;
    for (const taskId of taskIds) {
      const allocation = await this.deps.chain.allocationOf(taskId, this.address);
      if (allocation === 0n) continue;
      claimable.push(taskId);
      total += allocation;
    }

    const pending = await this.deps.chain.pendingWithdrawals(this.address);
    const floor = this.deps.minCollectWei ?? DEFAULT_MIN_COLLECT_WEI;
    if (total + pending === 0n) return { claimed: [], withdrawnWei: 0n };
    if (total + pending < floor) {
      const held = total + pending;
      if (held !== this.lastHeldWei) {
        this.lastHeldWei = held;
        this.deps.log("info", "holding rewards until they cover the gas to collect them", {
          verifierId: this.deps.verifierId,
          unclaimedWei: held.toString(),
          floorWei: floor.toString(),
          tasks: claimable.length,
        });
      }
      return { claimed: [], withdrawnWei: 0n };
    }
    // Past the floor: the next hold is a new fact worth reporting again.
    this.lastHeldWei = null;

    const claimed: Hex[] = [];
    for (const taskId of claimable) {
      try {
        await this.deps.chain.send("claimReward", [taskId]);
        claimed.push(taskId);
      } catch (error) {
        this.deps.log("warn", "claimReward failed", {
          taskId,
          verifierId: this.deps.verifierId,
          error: String((error as Error).message).slice(0, 200),
        });
      }
    }

    const withdrawable = await this.deps.chain.pendingWithdrawals(this.address);
    if (withdrawable > 0n) {
      const receipt = await this.deps.chain.send("withdraw", []);
      this.deps.log("info", "collected rewards", {
        verifierId: this.deps.verifierId,
        claimedTasks: claimed.length,
        withdrawnWei: withdrawable.toString(),
        txHash: receipt.txHash,
      });
    }
    return { claimed, withdrawnWei: withdrawable };
  }
}
