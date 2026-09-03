/**
 * The keeper.
 *
 * It holds the only server-side key that touches the lifecycle, so the design
 * question is not "how do we submit `finalizeConsensus`" but "what would make
 * us refuse to". The contract already refuses a beneficiary who did not reveal
 * and a duplicate in the list — `_requireRevealedSet` reverts with
 * `NotRevealer` and `DuplicateBeneficiary`. Every check in `CHECKS` below is
 * therefore deliberately redundant with the contract, and that redundancy is
 * the point: a keeper that discovers its mistake from a revert has already
 * broadcast it, paid for it, and left an operator to explain a failed
 * transaction against a task that people are watching. The checks run against
 * a *fresh read of the chain*, not against the read model, because the read
 * model is a projection and could be stale or replayed.
 *
 * Deliberately narrower than the contract in one place: `finalizeConsensus`
 * accepts Open, Committing or Revealing, but this keeper only submits from
 * Revealing. A task still in Committing when its reveal window closed had
 * verifiers who never revealed, and the honest settlement for that is
 * `expireTask` — which pays the conflict rate to whoever did reveal — not a
 * consensus the keeper synthesised.
 *
 * With `KEEPER_PRIVATE_KEY` unset the keeper is disabled and says so once. The
 * API still serves: `finalizeTask`, `expireTask` and `expireDispute` are all
 * permissionless once their deadlines pass, so nothing is trapped by a keeper
 * that never starts (threat model, "Trapping escrow").
 */
import { getAddress, type Address, type Hex } from "viem";
import { ChainClient, type ReportOnChain, type TaskOnChain } from "@proofrelay/chain-client";
import {
  ConsensusResult,
  Outcome,
  ProofRelayError,
  TaskStatus,
  hashesEqual,
  objectHash,
  type ConsensusOutcome,
} from "@proofrelay/schemas";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { Config } from "@proofrelay/config";
import { many, one, type Pool } from "../db.js";
import type { Logger } from "../observability.js";
import * as queue from "./queue.js";
import type { JobContext, JobHandler } from "./orchestrator.js";

/**
 * The only functions this key may call. `send` goes through here so a future
 * caller cannot widen the keeper into an admin by passing a different name.
 */
export const KEEPER_ACTIONS = [
  "finalizeConsensus",
  "finalizeTask",
  "expireTask",
  "expireDispute",
] as const;
export type KeeperAction = (typeof KEEPER_ACTIONS)[number];

/**
 * The share of the bounty the agreeing verifiers split on `CONSENSUS`.
 *
 * 10000 — the whole bounty — is what the live deployment's two settled tasks
 * actually recorded (`getTask(...).rewardBps == 10000`, status 7, outcome 1).
 * The remainder returns to the creator, so a smaller number here would silently
 * change the economics of every future task relative to the ones already
 * onchain.
 */
export const CONSENSUS_REWARD_BPS = 10_000;

export const OUTCOME_CODE: Record<ConsensusOutcome, number> = {
  CONSENSUS: Outcome.Consensus,
  CONFLICT: Outcome.Conflict,
  NO_QUORUM: Outcome.NoQuorum,
};

export interface FinalizeConsensusSubmission {
  taskId: Hex;
  resultHash: Hex;
  /** The contract's uint8 `Outcome`. */
  outcome: number;
  beneficiaries: Address[];
  rewardBps: number;
}

/**
 * The exact arguments a consensus artifact implies. Only a settled task names
 * beneficiaries: on `CONFLICT` the contract pays everyone who revealed at its
 * own `conflictRateBps`, and passing a list there reverts with
 * `InvalidBeneficiary` — correctly, because choosing who is paid on a conflict
 * is not the keeper's decision to make.
 */
export function submissionFor(result: ConsensusResult): FinalizeConsensusSubmission {
  const consensus = result.outcome === "CONSENSUS";
  return {
    taskId: result.taskId as Hex,
    resultHash: objectHash(result),
    outcome: OUTCOME_CODE[result.outcome],
    beneficiaries: consensus ? result.rewardedVerifiers.map((v) => getAddress(v)) : [],
    rewardBps: consensus ? CONSENSUS_REWARD_BPS : 0,
  };
}

export interface KeeperCheckFailure {
  code: string;
  message: string;
}

export interface KeeperCheckResult {
  ok: boolean;
  failures: KeeperCheckFailure[];
}

export interface FinalizeCheckInput {
  submission: FinalizeConsensusSubmission;
  /** Freshly read from the chain, never from the read model. */
  task: TaskOnChain;
  result: ConsensusResult;
  /** Lowercased verifier address to its onchain report. */
  reports: ReadonlyMap<string, ReportOnChain>;
  /** Chain time, not wall time — it is what `block.timestamp` will compare. */
  nowSec: number;
}

/**
 * Everything that must be true before the keeper signs. Each check is named so
 * a refusal is a code an operator can look up, and so each has its own test.
 */
export function checkFinalizeConsensus(input: FinalizeCheckInput): KeeperCheckResult {
  const { submission, task, result, reports, nowSec } = input;
  const failures: KeeperCheckFailure[] = [];
  const fail = (code: string, message: string) => failures.push({ code, message });

  if (task.status === TaskStatus.None) {
    fail("TASK_NOT_FOUND", "the chain has no such task");
    return { ok: false, failures };
  }

  if (task.status !== TaskStatus.Revealing) {
    fail("STATUS_NOT_REVEALING", `task status is ${task.status}, not Revealing`);
  }

  const everyoneRevealed =
    task.verifierCount > 0 && task.revealedCount >= task.verifierCount;
  if (!everyoneRevealed && nowSec <= task.revealDeadline) {
    fail(
      "REVEAL_NOT_CLOSED",
      `reveal deadline ${task.revealDeadline} has not passed and only ${task.revealedCount}/${task.verifierCount} revealed`,
    );
  }

  // The artifact has to account for every reveal the chain recorded. Without
  // this the keeper would happily settle a consensus computed over a SUBSET of
  // the reports — a verifier whose reveal the indexer had not caught up with is
  // simply absent from the evaluation, and the settlement pays and excludes
  // people on the strength of evidence that was never read. The chain's count is
  // the authority; the artifact is the thing being checked against it.
  // Only once the reveal set is final. While the window is open the artifact is
  // legitimately behind, and REVEAL_NOT_CLOSED already says so — adding a second
  // failure there would turn a "come back later" into a permanent refusal.
  if (everyoneRevealed || nowSec > task.revealDeadline) {
    if (result.reportHashes.length !== task.revealedCount) {
      fail(
        "ARTIFACT_INCOMPLETE",
        `the consensus artifact covers ${result.reportHashes.length} report(s) but the chain records ${task.revealedCount} reveal(s)`,
      );
    }
  }

  if (!hashesEqual(objectHash(result), submission.resultHash)) {
    fail("RESULT_HASH_MISMATCH", "the artifact does not hash to the resultHash being submitted");
  }

  if (!hashesEqual(result.taskId, submission.taskId)) {
    fail("TASK_ID_MISMATCH", "the consensus artifact names a different task");
  }

  if (!hashesEqual(result.manifestHash, task.manifestHash)) {
    fail("MANIFEST_HASH_MISMATCH", "the artifact was evaluated against a different manifest");
  }

  if (!hashesEqual(result.ruleId, task.ruleId)) {
    fail("RULE_ID_MISMATCH", "the artifact was evaluated under a different rule");
  }

  if (submission.outcome < Outcome.Consensus || submission.outcome > Outcome.NoQuorum) {
    fail("INVALID_OUTCOME", `outcome ${submission.outcome} is outside 1..3`);
  }

  if (submission.outcome !== OUTCOME_CODE[result.outcome]) {
    fail("OUTCOME_MISMATCH", `submitting ${submission.outcome} for a ${result.outcome} artifact`);
  }

  const consensus = result.outcome === "CONSENSUS";
  if (consensus && submission.beneficiaries.length === 0) {
    fail("BENEFICIARIES_EMPTY", "a consensus settlement must name at least one beneficiary");
  }
  if (!consensus && submission.beneficiaries.length > 0) {
    fail("BENEFICIARIES_NOT_ALLOWED", `a ${result.outcome} settlement must name no beneficiary`);
  }
  if (submission.beneficiaries.length > task.verifierCount) {
    fail(
      "BENEFICIARY_COUNT",
      `${submission.beneficiaries.length} beneficiaries for a task with ${task.verifierCount} verifiers`,
    );
  }

  const seen = new Set<string>();
  const rewarded = new Set(result.rewardedVerifiers.map((v) => v.toLowerCase()));
  for (const beneficiary of submission.beneficiaries) {
    const key = beneficiary.toLowerCase();
    if (seen.has(key)) {
      fail("DUPLICATE_BENEFICIARY", `${beneficiary} appears more than once`);
    }
    seen.add(key);

    const report = reports.get(key);
    if (!report || !report.revealed) {
      fail("BENEFICIARY_NOT_REVEALER", `${beneficiary} did not reveal a report for this task`);
    }
    if (!rewarded.has(key)) {
      fail("BENEFICIARY_NOT_REWARDED", `${beneficiary} is not in the artifact's rewardedVerifiers`);
    }
  }

  if (submission.rewardBps > 10_000) {
    fail("REWARD_BPS_INVALID", `rewardBps ${submission.rewardBps} exceeds 10000`);
  }
  if (!consensus && submission.rewardBps !== 0) {
    fail("REWARD_BPS_INVALID", `rewardBps must be 0 for a ${result.outcome} settlement`);
  }

  return { ok: failures.length === 0, failures };
}

/* ── the runner ──────────────────────────────────────────────────────────── */

/**
 * Only the surface the keeper uses, so a test can hand it a fake without
 * standing up an RPC. Anything not listed here is unreachable from this file.
 */
export type KeeperChain = Pick<
  ChainClient,
  | "chainId"
  | "contract"
  | "account"
  | "getTask"
  | "getReport"
  | "getDispute"
  | "getTaskVerifiers"
  | "params"
  | "send"
  | "blockNumber"
  | "blockTimestamp"
  | "balanceOf"
  | "totalLiabilities"
>;

export interface KeeperDeps {
  pool: Pool;
  config: Config;
  storage: StorageAdapter;
  logger: Logger;
  /** Built from KEEPER_PRIVATE_KEY when absent. */
  chain?: KeeperChain;
  now?: () => Date;
  maxTxPerTick?: number;
  minBalanceWei?: bigint;
}

export interface KeeperSkip {
  submitted: false;
  reason: string;
  failures: KeeperCheckFailure[];
}

export interface KeeperSubmitted {
  submitted: true;
  action: KeeperAction;
  txHash: Hex;
  blockNumber: bigint;
}

export type KeeperOutcome = KeeperSkip | KeeperSubmitted;

export interface KeeperTick {
  disabled: boolean;
  finalized: number;
  expired: number;
  disputesExpired: number;
  skipped: number;
}

interface CandidateRow {
  task_id: string;
}

export class Keeper {
  readonly enabled: boolean;
  readonly address: Address | null;
  private readonly deps: KeeperDeps;
  private readonly chain: KeeperChain | null;
  private readonly now: () => Date;
  private readonly maxTxPerTick: number;
  private readonly minBalanceWei: bigint;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private announcedDisabled = false;

  constructor(deps: KeeperDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.maxTxPerTick = deps.maxTxPerTick ?? Number(process.env.KEEPER_MAX_TX_PER_TICK ?? 2);
    this.minBalanceWei =
      deps.minBalanceWei ?? BigInt(process.env.KEEPER_MIN_BALANCE_WEI ?? "20000000000000000");

    const privateKey = deps.config.orchestrator.keeperPrivateKey;
    if (deps.chain) {
      this.chain = deps.chain;
    } else if (privateKey) {
      this.chain = new ChainClient({
        chainId: deps.config.chain.chainId,
        rpcUrl: deps.config.chain.rpcUrl,
        contract: deps.config.chain.contract,
        privateKey,
        confirmations: deps.config.chain.confirmations,
      });
    } else {
      this.chain = null;
    }

    this.enabled = this.chain !== null;
    this.address = this.chain?.account ?? null;
    if (!this.enabled) this.announceDisabled();
  }

  private announceDisabled(): void {
    if (this.announcedDisabled) return;
    this.announcedDisabled = true;
    this.deps.logger.warn(
      "keeper disabled: KEEPER_PRIVATE_KEY is unset. " +
        "The API serves normally; finalizeTask, expireTask and expireDispute stay permissionless " +
        "once their deadlines pass, so no task and no escrow is trapped.",
      { errorCode: "NOT_CONFIGURED" },
    );
  }

  /** The orchestrator's FINALIZATION handler. */
  finalizationHandler(): JobHandler {
    return async (context: JobContext) => {
      const raw = (context.job.taskId ?? context.job.payload.taskId) as string | undefined;
      // Shape-checked and lowercased before anything looks it up. `tasks.task_id`
      // and `consensus_results.task_id` are stored lowercase, so a checksummed
      // id would find no artifact and be reported as "nothing has been
      // evaluated" — a refusal that reads like a missing artifact rather than
      // like the malformed job it is.
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.trim())) {
        throw new ProofRelayError("VALIDATION_FAILED", "FINALIZATION job carries no taskId", {
          retryable: false,
          detail: { jobId: context.job.id, taskId: raw ?? null },
        });
      }
      const taskId = raw.trim().toLowerCase();
      if (!this.enabled) {
        this.announceDisabled();
        throw new ProofRelayError(
          "NOT_CONFIGURED",
          "the keeper is disabled (KEEPER_PRIVATE_KEY unset); this task settles through the permissionless expireTask path",
          { retryable: false, detail: { taskId } },
        );
      }

      const outcome = await this.finalizeConsensusFor(taskId as Hex);
      if (!outcome.submitted) {
        // A refusal is not a crash. Retryable when the only complaint is that
        // the reveal window is still open — that resolves with time; anything
        // else is a disagreement between the artifact and the chain, and a
        // human needs to look at it.
        // Both of these mean "the evidence is not settled yet", not "this can
        // never work": an artifact that covers fewer reports than the chain
        // records is recomputed on the next pass with the reveals it missed.
        const waiting = outcome.failures.every(
          (f) => f.code === "REVEAL_NOT_CLOSED" || f.code === "ARTIFACT_INCOMPLETE",
        );
        throw new ProofRelayError(
          waiting ? "CHAIN_UNAVAILABLE" : "CHAIN_REVERTED",
          `keeper refused to finalize: ${outcome.reason}`,
          {
            retryable: waiting,
            detail: { taskId, failures: outcome.failures },
          },
        );
      }
      context.logger.info("finalizeConsensus submitted", {
        taskId,
        txHash: outcome.txHash,
      });
    };
  }

  /**
   * Re-read the chain, re-read the artifact, check, then submit.
   *
   * Nothing here trusts the job payload: the payload names a task, and every
   * other value is fetched again. A payload that has drifted from the chain is
   * exactly the situation the checks exist for.
   */
  async finalizeConsensusFor(taskId: Hex): Promise<KeeperOutcome> {
    const chain = this.requireChain();
    const stored = await one<{ result_hash: string; result_pointer: string | null; body: unknown }>(
      this.deps.pool,
      "SELECT result_hash, result_pointer, body FROM consensus_results WHERE task_id = $1",
      [taskId],
    );
    if (!stored) {
      return skip("no consensus artifact has been evaluated for this task", [
        { code: "RESULT_MISSING", message: "consensus_results has no row for this task" },
      ]);
    }

    const body = stored.body ?? (await this.fetchResult(stored.result_pointer, stored.result_hash));

    // Re-hashed whichever way it arrived. The cached body is a copy of an
    // artifact whose hash is about to go onchain, and a keeper that trusted the
    // copy would publish a resultHash addressing bytes nobody can fetch.
    if (!hashesEqual(objectHash(body), stored.result_hash)) {
      throw new ProofRelayError("CONTENT_HASH_MISMATCH", "the stored consensus result does not match its hash", {
        retryable: false,
        detail: { taskId, resultHash: stored.result_hash },
      });
    }

    const result = ConsensusResult.parse(body);
    const submission = submissionFor(result);

    const [task, nowSec] = await Promise.all([chain.getTask(taskId), this.chainNowSec()]);
    const reports = await this.readReports(taskId, submission.beneficiaries);

    const check = checkFinalizeConsensus({ submission, task, result, reports, nowSec });
    if (!check.ok) {
      this.deps.logger.warn("keeper refused finalizeConsensus", {
        taskId,
        errorCode: check.failures[0]?.code ?? "UNKNOWN",
        failures: check.failures,
      });
      return skip(check.failures.map((f) => f.message).join("; "), check.failures);
    }

    return this.submit("finalizeConsensus", taskId, [
      submission.taskId,
      submission.resultHash,
      submission.outcome,
      submission.beneficiaries,
      submission.rewardBps,
    ]);
  }

  private fetchResult(pointer: string | null, resultHash: string): Promise<unknown> {
    return this.deps.storage.getJson(pointer ?? resultHash).catch((error: unknown) => {
      throw new ProofRelayError("STORAGE_UNAVAILABLE", "could not fetch the consensus artifact", {
        cause: error,
        detail: { pointer, resultHash },
      });
    });
  }

  /**
   * The reveal state of every address the submission is about to pay. Read one
   * by one from the chain rather than from `reports` — the read model records
   * what the indexer saw, and "did this address reveal" is the single fact the
   * contract will re-check and revert on.
   */
  private async readReports(
    taskId: Hex,
    beneficiaries: readonly Address[],
  ): Promise<Map<string, ReportOnChain>> {
    const chain = this.requireChain();
    const reports = new Map<string, ReportOnChain>();
    for (const beneficiary of beneficiaries) {
      const report = await chain.getReport(taskId, beneficiary);
      reports.set(beneficiary.toLowerCase(), report);
    }
    return reports;
  }

  /**
   * The permissionless fallbacks. They need no keeper role, so running them
   * here is a convenience rather than a privilege — anyone can call them, and
   * the runbook tells an operator exactly that.
   */
  async runFallbacks(budget: number): Promise<{ expired: number; finalized: number; disputes: number }> {
    const chain = this.requireChain();
    const nowSec = await this.chainNowSec();
    const now = this.now();
    // Read rather than hardcoded: the expiry fallback must open exactly when the
    // contract will accept it, and `keeperGracePeriod` is a deployment parameter.
    const protocol = await chain.params();
    let remaining = budget;
    const counts = { expired: 0, finalized: 0, disputes: 0 };

    // Consensus whose dispute window closed: finalizeTask.
    for (const row of await this.candidates(
      `SELECT task_id FROM tasks
        WHERE status = $1 AND dispute_deadline IS NOT NULL AND dispute_deadline < $2
        ORDER BY dispute_deadline LIMIT $3`,
      [TaskStatus.Consensus, now, remaining],
    )) {
      if (remaining <= 0) break;
      const task = await chain.getTask(row.task_id as Hex);
      if (task.status !== TaskStatus.Consensus) continue;
      if (nowSec <= task.consensusAt + task.disputeWindow) continue;
      const outcome = await this.submit("finalizeTask", row.task_id as Hex, [row.task_id]);
      if (outcome.submitted) {
        counts.finalized += 1;
        remaining -= 1;
      }
    }

    // Reveal window gone: expireTask — but never on a task this keeper is about
    // to settle properly. Expiry pays the revealers `conflictRateBps` (half) and
    // writes the terminal `Expired` status, which forecloses the dispute window;
    // consensus pays them in full and leaves the window open. So a task that
    // already has a consensus artifact, or a live job that is producing one, is
    // excluded — this is a fallback for a task nobody classified, not a race
    // against our own settlement.
    for (const row of await this.candidates(
      `SELECT task_id FROM tasks t
        WHERE status = ANY($1::smallint[]) AND reveal_deadline IS NOT NULL AND reveal_deadline < $2
          AND NOT EXISTS (SELECT 1 FROM consensus_results c WHERE c.task_id = t.task_id)
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
             WHERE j.idempotency_key = 'consensus:' || t.task_id AND j.status <> 'FAILED_FINAL'
          )
        ORDER BY reveal_deadline LIMIT $3`,
      [[TaskStatus.Open, TaskStatus.Committing, TaskStatus.Revealing], now, remaining],
    )) {
      if (remaining <= 0) break;
      const task = await chain.getTask(row.task_id as Hex);
      const live =
        task.status === TaskStatus.Open ||
        task.status === TaskStatus.Committing ||
        task.status === TaskStatus.Revealing;
      if (!live) continue;
      // The contract opens expireTask at `revealDeadline + keeperGracePeriod`,
      // read from the chain so this cannot drift from what it will accept.
      if (nowSec <= task.revealDeadline + protocol.keeperGracePeriod) continue;
      const outcome = await this.submit("expireTask", row.task_id as Hex, [row.task_id]);
      if (outcome.submitted) {
        counts.expired += 1;
        remaining -= 1;
      }
    }

    // A challenge nobody adjudicated: expireDispute returns the bond.
    for (const row of await this.candidates(
      `SELECT t.task_id FROM tasks t
         JOIN disputes d ON d.task_id = t.task_id
        WHERE t.status = $1 AND d.resolved = FALSE AND d.deadline IS NOT NULL AND d.deadline < $2
        ORDER BY d.deadline LIMIT $3`,
      [TaskStatus.Disputed, now, remaining],
    )) {
      if (remaining <= 0) break;
      const task = await chain.getTask(row.task_id as Hex);
      if (task.status !== TaskStatus.Disputed) continue;
      const dispute = await chain.getDispute(row.task_id as Hex);
      if (dispute.resolved || nowSec <= dispute.deadline) continue;
      const outcome = await this.submit("expireDispute", row.task_id as Hex, [row.task_id]);
      if (outcome.submitted) {
        counts.disputes += 1;
        remaining -= 1;
      }
    }

    return counts;
  }

  private candidates(sql: string, values: unknown[]): Promise<CandidateRow[]> {
    const limit = values[values.length - 1];
    if (typeof limit === "number" && limit <= 0) return Promise.resolve([]);
    return many<CandidateRow>(this.deps.pool, sql, values);
  }

  async tick(): Promise<KeeperTick> {
    if (!this.enabled) {
      this.announceDisabled();
      return { disabled: true, finalized: 0, expired: 0, disputesExpired: 0, skipped: 0 };
    }

    const chain = this.requireChain();
    if (this.address) {
      const balance = await chain.balanceOf(this.address);
      if (balance < this.minBalanceWei) {
        this.deps.logger.error("keeper balance below the floor; not submitting", {
          errorCode: "NOT_CONFIGURED",
          address: this.address,
          balanceWei: balance.toString(),
          minBalanceWei: this.minBalanceWei.toString(),
        });
        return { disabled: false, finalized: 0, expired: 0, disputesExpired: 0, skipped: 1 };
      }
    }

    const fallbacks = await this.runFallbacks(this.maxTxPerTick);
    return {
      disabled: false,
      finalized: fallbacks.finalized,
      expired: fallbacks.expired,
      disputesExpired: fallbacks.disputes,
      skipped: 0,
    };
  }

  start(pollMs = Number(process.env.KEEPER_POLL_MS ?? 5_000)): void {
    if (!this.enabled || this.timer) {
      if (!this.enabled) this.announceDisabled();
      return;
    }
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.tick();
      } catch (error) {
        this.deps.logger.error("keeper tick failed", {
          errorCode: error instanceof ProofRelayError ? error.code : "INTERNAL",
          detail: String((error as Error)?.message ?? error).slice(0, 300),
        });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** Chain time. `block.timestamp` is what every deadline is compared against. */
  private async chainNowSec(): Promise<number> {
    const chain = this.requireChain();
    try {
      return await chain.blockTimestamp(await chain.blockNumber());
    } catch {
      return Math.floor(this.now().getTime() / 1_000);
    }
  }

  private async submit(
    action: KeeperAction,
    taskId: Hex,
    args: readonly unknown[],
  ): Promise<KeeperOutcome> {
    if (!KEEPER_ACTIONS.includes(action)) {
      throw new ProofRelayError("UNAUTHORIZED", `${action} is not a keeper action`, {
        retryable: false,
      });
    }
    const chain = this.requireChain();
    const receipt = await chain.send(action, args);
    this.deps.logger.info("keeper transaction confirmed", {
      taskId,
      txHash: receipt.txHash,
      action,
      gasUsed: receipt.gasUsed.toString(),
    });
    return {
      submitted: true,
      action,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
    };
  }

  private requireChain(): KeeperChain {
    if (!this.chain) {
      throw new ProofRelayError("NOT_CONFIGURED", "the keeper has no signer", { retryable: false });
    }
    return this.chain;
  }
}

function skip(reason: string, failures: KeeperCheckFailure[]): KeeperSkip {
  return { submitted: false, reason, failures };
}

/** Enqueue a FINALIZATION job; the orchestrator hands it back to the keeper. */
export async function enqueueFinalization(
  pool: Pool,
  taskId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await queue.enqueue(pool, { jobType: "FINALIZATION", taskId, payload: { taskId, ...payload } });
}
