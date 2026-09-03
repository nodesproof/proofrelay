import {
  createPublicClient,
  createWalletClient,
  http,
  parseGwei,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Log,
} from "viem";
import { createNonceManager, privateKeyToAccount } from "viem/accounts";
import { jsonRpc } from "viem/nonce";
import { ProofRelayError, withRetry } from "@proofrelay/schemas";
import { proofRelayAbi, EVENT_TOPICS, INDEXED_EVENT_NAMES, type ProofRelayEventName } from "./abi.js";
import { KNOWN_CHAINS, galileo, networkInfo } from "./chains.js";

/**
 * Galileo rejects transactions below a 2 gwei tip with
 * `transaction gas price below minimum: gas tip cap 1`. viem's estimator
 * happily produces a 1 wei tip against this node, so every transaction floors
 * its priority fee here.
 */
export const MIN_PRIORITY_FEE = parseGwei("2");

export interface ChainClientOptions {
  chainId: number;
  rpcUrl: string;
  contract: Address;
  /** Optional signer. Read-only clients omit it. */
  privateKey?: Hex | undefined;
  confirmations?: number;
  /** How long waitForReceipt keeps retrying a lagging receipt lookup. */
  receiptTimeoutMs?: number;
}

export interface TaskOnChain {
  creator: Address;
  bounty: bigint;
  verifierCount: number;
  commitDeadline: number;
  revealDeadline: number;
  disputeWindow: number;
  consensusAt: number;
  committedCount: number;
  revealedCount: number;
  rewardBps: number;
  status: number;
  outcome: number;
  manifestHash: Hex;
  ruleId: Hex;
  resultHash: Hex;
  manifestPointer: string;
}

export interface ReportOnChain {
  verifier: Address;
  commitment: Hex;
  revealed: boolean;
  reportHash: Hex;
  reportPointer: string;
  committedAt: number;
  revealedAt: number;
}

export interface VerifierOnChain {
  registered: boolean;
  approved: boolean;
  active: boolean;
  stake: bigint;
  slashed: bigint;
  metadataHash: Hex;
  metadataPointer: string;
}

export interface DisputeOnChain {
  challenger: Address;
  bond: bigint;
  evidenceHash: Hex;
  evidencePointer: string;
  resolved: boolean;
  upheld: boolean;
  outcome: number;
  openedAt: number;
  deadline: number;
  adjudicationHash: Hex;
  adjudicationPointer: string;
}

export interface ProtocolParams {
  conflictRateBps: number;
  challengeBondBps: number;
  challengerRewardBps: number;
  adjudicatorSplitBps: number;
  verifierSlashBps: number;
  minBounty: bigint;
  minVerifierStake: bigint;
  keeperGracePeriod: number;
  adjudicationWindow: number;
  claimGracePeriod: number;
}

export class ChainClient {
  readonly chainId: number;
  readonly contract: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  readonly account: Address | null;
  private readonly confirmations: number;
  private readonly receiptTimeoutMs: number;

  constructor(options: ChainClientOptions) {
    this.chainId = options.chainId;
    this.contract = options.contract;
    this.confirmations = options.confirmations ?? 1;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 180_000;

    const chain = KNOWN_CHAINS[options.chainId as keyof typeof KNOWN_CHAINS] ?? {
      ...galileo,
      id: options.chainId,
    };
    const transport = http(options.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 30_000 });

    this.publicClient = createPublicClient({ chain, transport }) as PublicClient;

    if (options.privateKey) {
      // A nonce manager, because one key is shared by more than one loop: the
      // keeper's settlement pass and its permissionless fallback sweep both send
      // from it, and viem otherwise reads the pending nonce per call. Two sends
      // that overlap pick the same nonce, and the second is rejected as a
      // replacement that is underpriced — a settlement lost to a race with
      // itself.
      const account = privateKeyToAccount(options.privateKey, {
        nonceManager: createNonceManager({ source: jsonRpc() }),
      });
      this.walletClient = createWalletClient({ account, chain, transport });
      this.account = account.address;
    } else {
      this.walletClient = null;
      this.account = null;
    }
  }

  get explorer(): string {
    return networkInfo(this.chainId).explorer;
  }

  /* ── reads ──────────────────────────────────────────────────────────── */

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return withRetry(
      () =>
        this.publicClient.readContract({
          address: this.contract,
          abi: proofRelayAbi,
          functionName: functionName as never,
          args: args as never,
        }) as Promise<T>,
      {
        attempts: 3,
        shouldRetry: (error) => !/revert|execution reverted/i.test(String(error)),
      },
    ).catch((error) => {
      throw new ProofRelayError("CHAIN_UNAVAILABLE", `readContract ${functionName} failed`, {
        cause: error,
        detail: { functionName, message: String((error as Error)?.message ?? error).slice(0, 300) },
      });
    });
  }

  async getTask(taskId: Hex): Promise<TaskOnChain> {
    return this.read<TaskOnChain>("getTask", [taskId]);
  }

  async getReport(taskId: Hex, verifier: Address): Promise<ReportOnChain> {
    return this.read<ReportOnChain>("getReport", [taskId, verifier]);
  }

  async getVerifier(verifier: Address): Promise<VerifierOnChain> {
    return this.read<VerifierOnChain>("getVerifier", [verifier]);
  }

  async getDispute(taskId: Hex): Promise<DisputeOnChain> {
    return this.read<DisputeOnChain>("getDispute", [taskId]);
  }

  async getTaskVerifiers(taskId: Hex): Promise<readonly Address[]> {
    return this.read<readonly Address[]>("getTaskVerifiers", [taskId]);
  }

  async allocationOf(taskId: Hex, account: Address): Promise<bigint> {
    return this.read<bigint>("allocationOf", [taskId, account]);
  }

  async pendingWithdrawals(account: Address): Promise<bigint> {
    return this.read<bigint>("pendingWithdrawals", [account]);
  }

  async creatorNonce(creator: Address): Promise<bigint> {
    return this.read<bigint>("creatorNonce", [creator]);
  }

  async totalLiabilities(): Promise<bigint> {
    return this.read<bigint>("totalLiabilities", []);
  }

  async isPaused(): Promise<boolean> {
    return this.read<boolean>("paused", []);
  }

  async hasRole(role: Hex, account: Address): Promise<boolean> {
    return this.read<boolean>("hasRole", [role, account]);
  }

  async params(): Promise<ProtocolParams> {
    const raw = (await this.read<readonly unknown[]>("params", [])) as unknown as [
      number, number, number, number, number, bigint, bigint, number, number, number,
    ];
    return {
      conflictRateBps: Number(raw[0]),
      challengeBondBps: Number(raw[1]),
      challengerRewardBps: Number(raw[2]),
      adjudicatorSplitBps: Number(raw[3]),
      verifierSlashBps: Number(raw[4]),
      minBounty: BigInt(raw[5]),
      minVerifierStake: BigInt(raw[6]),
      keeperGracePeriod: Number(raw[7]),
      adjudicationWindow: Number(raw[8]),
      claimGracePeriod: Number(raw[9]),
    };
  }

  async blockNumber(): Promise<bigint> {
    return withRetry(() => this.publicClient.getBlockNumber(), { attempts: 3 });
  }

  async blockTimestamp(blockNumber: bigint): Promise<number> {
    const block = await this.publicClient.getBlock({ blockNumber });
    return Number(block.timestamp);
  }

  async balanceOf(address: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }

  /* ── logs ───────────────────────────────────────────────────────────── */

  /**
   * All ProofRelay logs in [fromBlock, toBlock]. Fetched as one address-scoped
   * query rather than one per event: Galileo's public RPC caps concurrent
   * requests hard enough that twelve parallel filters is slower than one pass
   * plus local decoding.
   */
  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    const topics = new Set<string>(Object.values(EVENT_TOPICS));
    const logs = await withRetry(
      () =>
        this.publicClient.getLogs({
          address: this.contract,
          fromBlock,
          toBlock,
        }),
      { attempts: 4, baseDelayMs: 700 },
    );
    return logs.filter((log) => log.topics[0] && topics.has(log.topics[0]));
  }

  eventNameForTopic(topic0: string): ProofRelayEventName | null {
    for (const name of INDEXED_EVENT_NAMES) {
      if (EVENT_TOPICS[name] === topic0) return name;
    }
    return null;
  }

  /* ── writes ─────────────────────────────────────────────────────────── */

  private requireWallet(): WalletClient & { account: NonNullable<WalletClient["account"]> } {
    if (!this.walletClient?.account) {
      throw new ProofRelayError("NOT_CONFIGURED", "this ChainClient has no signer");
    }
    return this.walletClient as WalletClient & { account: NonNullable<WalletClient["account"]> };
  }

  /** Galileo's minimum tip, applied to every transaction this client sends. */
  private async feeOverrides(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [tip, block] = await Promise.all([
      this.publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n),
      this.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    const priority = tip > MIN_PRIORITY_FEE ? tip : MIN_PRIORITY_FEE;
    const base = block.baseFeePerGas ?? 0n;
    return { maxPriorityFeePerGas: priority, maxFeePerGas: base * 2n + priority };
  }

  /**
   * Asks the node whether a call would succeed, without sending it. Returns
   * null when it would go through, and the revert reason when it would not.
   *
   * A negative test written as "call it and expect a throw" is not a probe: on
   * the call that does *not* revert it settles the task it was asking about.
   * This is the shape such a test needs.
   */
  async simulate(
    functionName: string,
    args: readonly unknown[],
    options: { value?: bigint } = {},
  ): Promise<string | null> {
    const wallet = this.requireWallet();
    try {
      await this.publicClient.simulateContract({
        address: this.contract,
        abi: proofRelayAbi,
        functionName: functionName as never,
        args: args as never,
        account: wallet.account,
        value: options.value,
      });
      return null;
    } catch (error) {
      return extractRevertReason(error) ?? String((error as Error).message).slice(0, 200);
    }
  }

  async send(
    functionName: string,
    args: readonly unknown[],
    options: { value?: bigint } = {},
  ): Promise<{ txHash: Hex; blockNumber: bigint; gasUsed: bigint; status: "success" | "reverted" }> {
    const wallet = this.requireWallet();
    const fees = await this.feeOverrides();

    let txHash: Hex;
    try {
      // Estimate first and pass an explicit limit. Without one, Galileo's node
      // prices the simulation at the block gas limit, so any account holding
      // less than `blockGasLimit * gasPrice` is told it cannot afford a
      // transaction that in fact costs a fraction of that — the error reads as
      // "insufficient funds" and sends you looking in the wrong place.
      const estimated = await this.publicClient.estimateContractGas({
        address: this.contract,
        abi: proofRelayAbi,
        functionName: functionName as never,
        args: args as never,
        account: wallet.account,
        value: options.value,
      });
      const gas = (estimated * 125n) / 100n;

      const { request } = await this.publicClient.simulateContract({
        address: this.contract,
        abi: proofRelayAbi,
        functionName: functionName as never,
        args: args as never,
        account: wallet.account,
        value: options.value,
        gas,
        ...fees,
      });
      txHash = await wallet.writeContract(request as never);
    } catch (error) {
      // Only an actual revert is non-retryable. Everything else that can throw
      // here — an RPC timeout, a dropped connection, a 429, a nonce that raced
      // another sender — is transport, and calling it a revert made a momentary
      // network blip permanent: the orchestrator marks the job FAILED_FINAL on
      // attempt 1, and `jobs.idempotency_key` is a tombstone that stops the same
      // job ever being enqueued again. A task's only path to settlement dies to
      // a blip. The read path at `read()` already draws exactly this line; the
      // write path did not use it.
      if (isRevert(error)) {
        throw new ProofRelayError("CHAIN_REVERTED", `${functionName} would revert`, {
          cause: error,
          retryable: false,
          detail: { functionName, reason: extractRevertReason(error) },
        });
      }
      throw new ProofRelayError("CHAIN_UNAVAILABLE", `${functionName} could not be submitted`, {
        cause: error,
        retryable: true,
        detail: {
          functionName,
          message: String((error as Error)?.message ?? error).slice(0, 300),
        },
      });
    }

    const receipt = await this.waitForReceipt(txHash);
    if (receipt.status === "reverted") {
      throw new ProofRelayError("CHAIN_REVERTED", `${functionName} reverted onchain`, {
        retryable: false,
        detail: { functionName, txHash },
      });
    }
    return {
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      status: receipt.status,
    };
  }

  /**
   * Galileo reports a block before the receipts for its transactions are
   * queryable, which viem raises as TransactionReceiptNotFoundError. Treating
   * that as failure abandons transactions that actually succeeded, so it is
   * retried until the deadline — and only that error is.
   */
  async waitForReceipt(txHash: Hex) {
    const deadline = Date.now() + this.receiptTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: this.confirmations,
          timeout: 30_000,
          pollingInterval: 1_000,
        });
      } catch (error) {
        lastError = error;
        // "no matching receipts found: this may indicate potential data
        // corruption" is 0G mainnet's wording for the same lag Galileo reports
        // as "could not be found". It is alarming and it is not corruption: the
        // transaction lands, the receipt is queryable a moment later. Observed
        // on a mainnet transfer that had already succeeded when the wait threw.
        const notFound =
          error instanceof TransactionReceiptNotFoundError ||
          /could not be found|not be processed|receipt.*not found|no matching receipts/i.test(String(error));
        if (!notFound) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw new ProofRelayError("CHAIN_UNAVAILABLE", "timed out waiting for a receipt", {
      cause: lastError,
      detail: { txHash },
    });
  }
}

/**
 * True only when the node actually rejected the call, rather than failing to
 * answer. Viem raises a named custom error or an "execution reverted" string for
 * a real revert; a timeout, a reset socket, a rate limit or a nonce race says
 * nothing about whether the call would succeed, and retrying is the correct
 * response to all of them.
 */
export function isRevert(error: unknown): boolean {
  const text = String(
    (error as { shortMessage?: string })?.shortMessage ?? (error as Error)?.message ?? error,
  );
  if (/timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|rate limit|nonce|replacement transaction underpriced/i.test(text)) {
    return false;
  }
  return /revert|execution reverted|Error:\s*[A-Za-z]+\(\)/i.test(text);
}

export function extractRevertReason(error: unknown): string {
  const text = String((error as { shortMessage?: string })?.shortMessage ?? (error as Error)?.message ?? error);
  const custom = text.match(/Error:\s*([A-Za-z]+)\(\)/);
  if (custom?.[1]) return custom[1];
  return text.split("\n")[0]?.slice(0, 200) ?? "unknown";
}
