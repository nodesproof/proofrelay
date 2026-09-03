/**
 * The chain indexer.
 *
 * One pass scans `[last_block + 1, min(last_block + batchSize, head - confirmations)]`,
 * writes every log it decodes into `chain_events`, projects the ones that were
 * new, and advances `indexer_state.last_block` — all in a single transaction.
 * That is the whole design, and the three properties it buys are worth stating
 * because each one is a bug that has to be impossible rather than unlikely:
 *
 * - **A replay is a no-op.** `chain_events` carries a unique
 *   `(chain_id, tx_hash, log_index)`; the insert is `ON CONFLICT DO NOTHING`
 *   and a log that inserted no row is not projected. Re-scanning a range
 *   therefore cannot double-count a commitment or a payout.
 * - **A crash mid-batch replays rather than skips.** The cursor advance is in
 *   the same transaction as the rows it accounts for, so either both land or
 *   neither does. There is no window where `last_block` has moved past events
 *   that were never written.
 * - **A bad batch never advances.** An error rolls the transaction back,
 *   `last_block` stays where it was, the message is recorded on
 *   `indexer_state.last_error` for `/health`, and the next tick retries the
 *   same range. Skipping a range to make an error go away would leave a task
 *   permanently missing from the read model.
 *
 * Reorgs are handled the way the architecture doc specifies — by staying
 * `confirmations` blocks behind the head — not by rewinding after the fact.
 */
import { decodeEventLog, type Log } from "viem";
import {
  proofRelayAbi,
  type ChainClient,
  type ProofRelayEventName,
} from "@proofrelay/chain-client";
import { assertIndexerStartBlock, type Config } from "@proofrelay/config";
import { ProofRelayError } from "@proofrelay/schemas";
import { one, withTransaction, type Pool, type PoolClient } from "../db.js";
import { Logger, metrics } from "../observability.js";
import { applyEvent, eventActor, eventTaskId, type EventArgs } from "./projections.js";

export interface IndexerDeps {
  config: Config;
  pool: Pool;
  chain: ChainClient;
  logger?: Logger | undefined;
}

/** The `indexer` block of `/health`, verbatim. */
export interface IndexerStatus {
  running: boolean;
  lastError: string | null;
  processedEvents: number;
  lastBlock: number | null;
  headBlock: number | null;
  lagBlocks: number | null;
}

export interface PassResult {
  from: number;
  to: number;
  head: number;
  /** Logs returned by the RPC for the range. */
  logs: number;
  /** Logs that were new to `chain_events` and therefore projected. */
  projected: number;
}

interface StateRow {
  chain_id: number;
  contract: string;
  last_block: number;
  last_error: string | null;
  processed_events: number;
}

export class Indexer {
  private readonly config: Config;
  private readonly pool: Pool;
  private readonly chain: ChainClient;
  private readonly log: Logger;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private started = false;
  private stopping = false;

  private lastError: string | null = null;
  private processedEvents = 0;
  private lastBlock: number | null = null;
  private headBlock: number | null = null;

  constructor(deps: IndexerDeps) {
    this.config = deps.config;
    this.pool = deps.pool;
    this.chain = deps.chain;
    this.log = (deps.logger ?? new Logger(deps.config.api.logLevel)).child({ component: "indexer" });
  }

  start(): void {
    if (this.started) return;
    assertIndexerStartBlock(this.config);
    this.started = true;
    this.stopping = false;
    this.log.info("indexer started", {
      startBlock: this.config.indexer.startBlock,
      pollMs: this.config.indexer.pollMs,
      batchSize: this.config.indexer.batchSize,
      confirmations: this.config.indexer.confirmations,
    });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // An in-flight pass owns a transaction; letting it finish is cheaper than
    // aborting it and re-scanning the same range on the next boot.
    await this.inFlight?.catch(() => undefined);
  }

  status(): IndexerStatus {
    const lag =
      this.headBlock !== null && this.lastBlock !== null ? Math.max(0, this.headBlock - this.lastBlock) : null;
    return {
      running: this.started && !this.stopping,
      lastError: this.lastError,
      processedEvents: this.processedEvents,
      lastBlock: this.lastBlock,
      headBlock: this.headBlock,
      lagBlocks: lag,
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      // setTimeout rather than setInterval: a pass that outruns the poll
      // interval must not overlap itself and scan the same range twice.
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
        this.schedule(this.config.indexer.pollMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      await this.recordFailure(error);
    }
  }

  /**
   * One pass. Exposed so `POST /v1/tasks/:taskId/sync` and the tests can force
   * a scan without waiting for the timer.
   */
  async runOnce(): Promise<PassResult | null> {
    const state = await this.loadState();
    const head = Number(await this.chain.blockNumber());
    this.headBlock = head;

    const safeHead = head - this.config.indexer.confirmations;
    const from = state.last_block + 1;
    this.lastBlock = state.last_block;
    this.publishLag();

    if (from > safeHead) return null;

    const to = Math.min(from + this.config.indexer.batchSize - 1, safeHead);
    const logs = await this.chain.getLogs(BigInt(from), BigInt(to));
    const blockTimes = await this.blockTimes(logs);

    const result = await withTransaction(this.pool, async (db) => {
      let projected = 0;
      for (const log of logs) {
        if (await this.ingest(db, log, blockTimes)) projected += 1;
      }
      await db.query(
        `UPDATE indexer_state
            SET last_block = $1, processed_events = processed_events + $2, last_error = NULL, updated_at = now()
          WHERE id = 1`,
        [to, projected],
      );
      return { from, to, head, logs: logs.length, projected } satisfies PassResult;
    });

    this.lastBlock = to;
    this.lastError = null;
    this.processedEvents = state.processed_events + result.projected;
    this.publishLag();
    if (result.projected > 0) {
      this.log.info("indexed", { from, to, logs: result.logs, projected: result.projected });
    }
    return result;
  }

  /**
   * Returns true when the log was new. A log already in `chain_events` is not
   * projected again — that single check is what makes a re-scan free.
   */
  private async ingest(db: PoolClient, log: Log, blockTimes: Map<string, Date>): Promise<boolean> {
    const decoded = this.decode(log);
    if (!decoded) return false;

    const blockNumber = Number(log.blockNumber ?? 0n);
    const blockTime = blockTimes.get(String(log.blockNumber)) ?? new Date();
    const txHash = String(log.transactionHash ?? "").toLowerCase();
    const logIndex = Number(log.logIndex ?? 0);
    const taskId = eventTaskId(decoded.name, decoded.args);

    const inserted = await db.query(
      `INSERT INTO chain_events (chain_id, tx_hash, log_index, block_number, block_time, event_name, task_id, actor, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
      [
        this.config.chain.chainId,
        txHash,
        logIndex,
        blockNumber,
        blockTime,
        decoded.name,
        taskId,
        eventActor(decoded.name, decoded.args),
        JSON.stringify(jsonSafe(decoded.args)),
      ],
    );
    if (inserted.rowCount !== 1) return false;

    await applyEvent(
      {
        db,
        chain: this.chain,
        chainId: this.config.chain.chainId,
        blockNumber,
        blockTime,
        txHash,
        logIndex,
        logger: this.log,
      },
      decoded.name,
      decoded.args,
    );
    return true;
  }

  private decode(log: Log): { name: ProofRelayEventName; args: EventArgs } | null {
    try {
      const decoded = decodeEventLog({
        abi: proofRelayAbi,
        data: log.data,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      return {
        name: decoded.eventName as ProofRelayEventName,
        args: (decoded.args ?? {}) as EventArgs,
      };
    } catch (error) {
      // getLogs already filters to our topics, so this is a signature we know
      // the topic of but cannot decode — worth a line, not worth a stall.
      this.log.warn("undecodable log", {
        txHash: String(log.transactionHash ?? ""),
        topic0: log.topics[0] ?? null,
        errorCode: "INTERNAL",
        detail: String((error as Error).message).slice(0, 200),
      });
      return null;
    }
  }

  /** One `eth_getBlockByNumber` per distinct block in the batch, not per log. */
  private async blockTimes(logs: Log[]): Promise<Map<string, Date>> {
    const times = new Map<string, Date>();
    for (const log of logs) {
      const key = String(log.blockNumber);
      if (log.blockNumber === null || times.has(key)) continue;
      const seconds = await this.chain.blockTimestamp(log.blockNumber);
      times.set(key, new Date(seconds * 1000));
    }
    return times;
  }

  private async loadState(): Promise<StateRow> {
    // last_block holds the highest block fully scanned, so the first pass of a
    // fresh read model resumes at exactly config.indexer.startBlock.
    const floor = Math.max(this.config.indexer.startBlock - 1, 0);
    await this.pool.query(
      `INSERT INTO indexer_state (id, chain_id, contract, last_block)
       VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [this.config.chain.chainId, this.config.chain.contract.toLowerCase(), floor],
    );
    const state = await one<StateRow>(this.pool, "SELECT * FROM indexer_state WHERE id = 1");
    if (!state) throw new ProofRelayError("INTERNAL", "indexer_state row is missing after upsert");

    // A read model carrying another deployment's rows would silently mix two
    // chains' tasks into one list. Refuse rather than reconcile.
    if (
      Number(state.chain_id) !== this.config.chain.chainId ||
      state.contract.toLowerCase() !== this.config.chain.contract.toLowerCase()
    ) {
      throw new ProofRelayError(
        "NOT_CONFIGURED",
        `this database was indexed for ${state.contract} on chain ${state.chain_id}, ` +
          `but the process is configured for ${this.config.chain.contract} on chain ${this.config.chain.chainId}. ` +
          "Point DATABASE_URL at the right database, or truncate the read model and DELETE FROM indexer_state.",
        { retryable: false },
      );
    }
    return state;
  }

  private publishLag(): void {
    if (this.headBlock === null || this.lastBlock === null) return;
    metrics.chainSyncLag.set(Math.max(0, this.headBlock - this.lastBlock));
  }

  private async recordFailure(error: unknown): Promise<void> {
    const code = error instanceof ProofRelayError ? error.code : "INTERNAL";
    const message = `${code}: ${String((error as Error)?.message ?? error)}`.slice(0, 500);
    this.lastError = message;
    this.log.error("indexer pass failed", { errorCode: code, detail: message });
    // Best effort: if the database is what failed, the message has nowhere to
    // go, and status() still carries it for /health.
    await this.pool
      .query("UPDATE indexer_state SET last_error = $1, updated_at = now() WHERE id = 1", [message])
      .catch(() => undefined);
  }
}

/** bigints are not JSON; they are the amounts, so they become decimal strings. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(entry);
    }
    return out;
  }
  return value;
}
