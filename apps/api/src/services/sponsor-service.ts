/**
 * The free first task.
 *
 * A stranger arriving at ProofRelay is asked for a wallet, real 0G, and an
 * escrow before they have seen a single result. `createTask` needs none of that
 * from *them*: it is `external payable` with no access control and records
 * `t.creator = msg.sender`, so a funded key can post a task on somebody else's
 * behalf with no contract change at all. This is that key, with a bound around
 * it.
 *
 * Three things this file is careful about, in the order they can go wrong:
 *
 * 1. **The quota is decided before the money moves.** A row is inserted, under a
 *    lock, before anything is broadcast. Counting only completed grants would
 *    let two concurrent requests each see "none used" and each spend.
 * 2. **The task id is predicted, then checked.** `send()` returns a receipt, not
 *    logs, so the id comes from `computeTaskId` over the sponsor's nonce — and
 *    is then read back off the chain and matched against the manifest that was
 *    just pinned. A predicted id that turns out to name a different task is a
 *    failure, never a value handed to a caller.
 * 3. **The beneficiary is not the creator, and says so.** The contract cannot
 *    record who asked; only `msg.sender`. The asker is bound into the manifest
 *    and recorded in `sponsorships`, and the response carries a warning saying
 *    exactly which rights they do not have. Quietly implying otherwise would be
 *    the wrong kind of free.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { ChainClient, ProtocolParams, TaskOnChain } from "@proofrelay/chain-client";
import { computeTaskId } from "@proofrelay/chain-client";
import type { Config } from "@proofrelay/config";
import {
  ProofRelayError,
  SponsorTaskRequest,
  SponsorTaskResponse,
  type PrepareTaskResponse,
} from "@proofrelay/schemas";
import { one, withTransaction, type Pool } from "../db.js";
import type { Logger } from "../observability.js";
import type { PrepareService } from "./prepare-service.js";

/* ── context ─────────────────────────────────────────────────────────────── */

/**
 * Everything the sponsor touches on chain, and nothing else. Structural for the
 * same reason the other two services declare their own readers: a test must be
 * able to drive this without a JSON-RPC transport, and the assert below stops
 * the real client drifting out of the shape.
 */
export interface SponsorChain {
  readonly chainId: number;
  readonly contract: Address;
  /** null when this client holds no signer — which is what disables the route. */
  readonly account: Address | null;
  creatorNonce(creator: Address): Promise<bigint>;
  balanceOf(address: Address): Promise<bigint>;
  isPaused(): Promise<boolean>;
  params(): Promise<ProtocolParams>;
  getTask(taskId: Hex): Promise<TaskOnChain>;
  send(
    functionName: string,
    args: readonly unknown[],
    options?: { value?: bigint },
  ): Promise<{ txHash: Hex; blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }>;
}

type Assert<T extends true> = T;
export type ChainClientIsSponsorChain = Assert<ChainClient extends SponsorChain ? true : false>;

export interface SponsorServiceContext {
  pool: Pool;
  chain: SponsorChain;
  prepare: PrepareService;
  config: Config;
  logger?: Logger | undefined;
  now?: (() => Date) | undefined;
}

export interface SponsorTaskArgs {
  /** The signed-in wallet. Never read from a request body — see the route. */
  beneficiary: Address;
  request: unknown;
}

/* ── quota ───────────────────────────────────────────────────────────────── */

interface Counts {
  mine: number;
  total: number;
}

/**
 * A reservation with no outcome holds its slot for `reservationTtlSec` and is
 * then ignored. Long by default, and deliberately so: a shorter window hands
 * the slot back while a transaction that has already been signed is still
 * landing, and the sponsor pays for two tasks where one was granted.
 */
const COUNT_SQL = `
  SELECT
    count(*) FILTER (WHERE lower(beneficiary) = $1)::int AS mine,
    count(*)::int                                        AS total
  FROM sponsorships
  WHERE status = 'GRANTED'
     OR (status = 'RESERVED' AND reserved_at > $2)`;

/**
 * A slot, or the reason there is none.
 *
 * The advisory lock is what makes the count mean anything: without it two
 * requests read the same total and both insert. Grants are capped in the low
 * hundreds for the life of the programme, so serialising them costs nothing
 * that matters and removes the only race that spends money.
 */
async function reserve(ctx: SponsorServiceContext, beneficiary: Address, now: Date): Promise<{ id: number; remaining: Counts }> {
  const { maxPerAddress, maxTotal, bountyWei, reservationTtlSec } = ctx.config.sponsor;
  const since = new Date(now.getTime() - reservationTtlSec * 1_000);
  const sponsor = ctx.chain.account as Address;

  return withTransaction(ctx.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('proofrelay.sponsorships'))");

    const counts = await one<Counts>(client, COUNT_SQL, [beneficiary.toLowerCase(), since]);
    const mine = counts?.mine ?? 0;
    const total = counts?.total ?? 0;

    // 429 for both, and the message says which bound was hit: "you have used
    // yours" and "the programme is finished" are the same status code and very
    // different things to read.
    if (total >= maxTotal) {
      throw new ProofRelayError("RATE_LIMITED", `the sponsored-task programme is fully allocated (${maxTotal} of ${maxTotal})`, {
        detail: { limit: "total", maxTotal, used: total },
      });
    }
    if (mine >= maxPerAddress) {
      throw new ProofRelayError("RATE_LIMITED", `this address has already used its ${maxPerAddress === 1 ? "sponsored task" : `${maxPerAddress} sponsored tasks`}`, {
        detail: { limit: "address", maxPerAddress, used: mine },
      });
    }

    const row = await one<{ id: number }>(
      client,
      `INSERT INTO sponsorships (beneficiary, sponsor, status, bounty_wei, reserved_at)
       VALUES ($1, $2, 'RESERVED', $3, $4) RETURNING id`,
      [beneficiary.toLowerCase(), sponsor.toLowerCase(), bountyWei.toString(), now],
    );
    if (!row) throw new ProofRelayError("INTERNAL", "the sponsorship reservation was not written");

    return {
      id: row.id,
      // What is left *after* this one, which is the number a UI should show.
      remaining: { mine: maxPerAddress - mine - 1, total: maxTotal - total - 1 },
    };
  });
}

async function settle(
  ctx: SponsorServiceContext,
  id: number,
  outcome: { status: "GRANTED"; taskId: Hex; txHash: Hex } | { status: "FAILED"; reason: string },
  now: Date,
): Promise<void> {
  await ctx.pool.query(
    `UPDATE sponsorships
        SET status = $2, task_id = $3, tx_hash = $4, reason = $5, settled_at = $6
      WHERE id = $1`,
    [
      id,
      outcome.status,
      outcome.status === "GRANTED" ? outcome.taskId : null,
      outcome.status === "GRANTED" ? outcome.txHash : null,
      outcome.status === "FAILED" ? outcome.reason.slice(0, 500) : null,
      now,
    ],
  );
}

/* ── preconditions ───────────────────────────────────────────────────────── */

/**
 * Everything that makes a grant impossible, checked before a slot is taken.
 *
 * Reserving first and discovering afterwards that the contract is paused would
 * burn a slot on a task that was never going to exist — recoverable, since the
 * row settles FAILED and frees it again, but a needless round trip through the
 * database for a condition that is knowable up front.
 */
async function assertCanSponsor(ctx: SponsorServiceContext): Promise<Address> {
  const sponsor = ctx.chain.account;
  if (!ctx.config.sponsor.enabled || !sponsor) {
    throw new ProofRelayError("NOT_CONFIGURED", "this deployment does not sponsor tasks", {
      detail: { hint: "set SPONSOR_ENABLED=1 and SPONSOR_PRIVATE_KEY" },
    });
  }

  const [paused, balance] = await Promise.all([ctx.chain.isPaused(), ctx.chain.balanceOf(sponsor)]);

  // The contract's own refusal, reported as the caller's 409 rather than as a
  // 500: a paused contract is a state, not a server fault.
  if (paused) {
    throw new ProofRelayError("CHAIN_REVERTED", "the contract is paused, so no task can be created right now", {
      statusCode: 409,
      retryable: false,
    });
  }

  // Stopping on an operator's own floor beats stopping on a failed transaction:
  // the reserve below would otherwise hand out slots the wallet cannot pay for,
  // one revert at a time.
  const needed = ctx.config.sponsor.bountyWei + ctx.config.sponsor.minBalanceWei;
  if (balance < needed) {
    throw new ProofRelayError("NOT_CONFIGURED", "the sponsor wallet is out of funds", {
      detail: { sponsor, balanceWei: balance.toString(), requiredWei: needed.toString() },
    });
  }

  return sponsor;
}

/* ── the grant ───────────────────────────────────────────────────────────── */

export function createSponsorService(ctx: SponsorServiceContext) {
  /**
   * One `createTask` from the sponsor key at a time.
   *
   * `send()` returns a receipt and no logs, so the task id is derived from the
   * sponsor's nonce — and two overlapping grants would read the same nonce and
   * predict the same id for two different tasks. The check after the receipt
   * catches that, but catching it means one caller's task is orphaned; not
   * racing means neither is. Only the nonce read and the broadcast are inside:
   * `prepare` spends its time fetching sources and uploading to 0G Storage, and
   * queueing that would make sponsored tasks wait on each other for no reason.
   */
  let sending: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = sending.then(fn, fn);
    sending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async sponsorTask(args: SponsorTaskArgs): Promise<SponsorTaskResponse> {
      const now = ctx.now?.() ?? new Date();
      const { bountyWei } = ctx.config.sponsor;
      const beneficiary = getAddress(args.beneficiary);
      const sponsor = await assertCanSponsor(ctx);

      // Parsed before a slot is taken: a request that cannot become a task
      // should not consume one, and this is the cheapest place to find out.
      const request = SponsorTaskRequest.parse(args.request ?? {});

      const params = await ctx.chain.params();
      if (bountyWei < params.minBounty) {
        throw new ProofRelayError("NOT_CONFIGURED", "the sponsored bounty is below the contract's minimum", {
          detail: { bountyWei: bountyWei.toString(), minBountyWei: params.minBounty.toString() },
        });
      }

      const { id, remaining } = await reserve(ctx, beneficiary, now);

      try {
        /**
         * The manifest names the *beneficiary*, not the sponsor.
         *
         * The manifest is the permanent, content-addressed record of who asked
         * for this verification, and the chain cannot hold that — it only ever
         * sees `msg.sender`. Naming the sponsor there would erase the one place
         * the real asker survives.
         *
         * The consequence is that `prepared.predictedTaskId` is meaningless
         * here: it is computed from the beneficiary's nonce, and the
         * beneficiary sends nothing. It is deliberately not read below.
         */
        const prepared: PrepareTaskResponse = await ctx.prepare.prepareTask({
          creator: beneficiary,
          request: { ...request, bountyWei: bountyWei.toString() },
        });

        const chainArgs = prepared.createTaskArgs;
        const { taskId, receipt } = await serialize(async () => {
          const nonce = await ctx.chain.creatorNonce(sponsor);
          const predicted = computeTaskId({
            chainId: ctx.chain.chainId,
            contract: ctx.chain.contract,
            creator: sponsor,
            nonce,
          });
          const sent = await ctx.chain.send(
            "createTask",
            [
              {
                verifierCount: chainArgs.verifierCount,
                commitWindowSec: chainArgs.commitWindowSec,
                revealWindowSec: chainArgs.revealWindowSec,
                disputeWindowSec: chainArgs.disputeWindowSec,
                manifestHash: chainArgs.manifestHash,
                manifestPointer: chainArgs.manifestPointer,
                ruleId: chainArgs.ruleId,
              },
            ],
            { value: bountyWei },
          );
          return { taskId: predicted, receipt: sent };
        });

        // The prediction, checked against the chain. A nonce that moved under
        // us produces an id that names some other task — or none — and handing
        // that back as "your task" would be worse than failing.
        const onchain = await ctx.chain.getTask(taskId);
        if (
          onchain.creator.toLowerCase() !== sponsor.toLowerCase() ||
          onchain.manifestHash.toLowerCase() !== prepared.manifestHash.toLowerCase()
        ) {
          throw new ProofRelayError("CHAIN_UNAVAILABLE", "the sponsored task was created but could not be identified", {
            retryable: false,
            detail: { predicted: taskId, txHash: receipt.txHash, manifestHash: prepared.manifestHash },
          });
        }

        await settle(ctx, id, { status: "GRANTED", taskId, txHash: receipt.txHash }, ctx.now?.() ?? new Date());
        ctx.logger?.info("task sponsored", {
          taskId,
          beneficiary,
          sponsor,
          bountyWei: bountyWei.toString(),
          txHash: receipt.txHash,
          remainingTotal: remaining.total,
        });

        return SponsorTaskResponse.parse({
          taskId,
          manifestHash: prepared.manifestHash,
          manifestPointer: prepared.manifestPointer,
          bountyWei: bountyWei.toString(),
          sponsor,
          beneficiary,
          tx: {
            txHash: receipt.txHash,
            blockNumber: Number(receipt.blockNumber),
            explorerUrl: `${ctx.config.chain.explorer}/tx/${receipt.txHash}`,
          },
          warnings: [
            ...prepared.warnings,
            // Said plainly rather than buried in documentation. Someone who
            // needs to cancel this task, or claim its refund if it expires,
            // has to know now that they cannot.
            `This task was created and escrowed by ${sponsor}, so the contract records that address as its creator — not ${beneficiary}. Cancelling it, reclaiming the bounty on expiry, and challenging it as its creator all belong to the sponsor. The manifest records ${beneficiary} as the wallet that asked for it.`,
          ],
          remaining: { forBeneficiary: remaining.mine, total: remaining.total },
        });
      } catch (error) {
        // The slot goes back. A reservation that outlives its attempt would
        // hold a grant nobody received until reservationTtlSec expired it.
        await settle(
          ctx,
          id,
          { status: "FAILED", reason: String((error as Error)?.message ?? error) },
          ctx.now?.() ?? new Date(),
        ).catch(() => undefined);
        throw error;
      }
    },
  };
}

export type SponsorService = ReturnType<typeof createSponsorService>;
