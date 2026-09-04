/**
 * Every live read and every wallet write the Evidence Ledger pages use.
 *
 * Reads are react-query hooks over lib/api.ts with the polling cadences from
 * FRONTEND_DATA_CONTRACT §3; writes are wagmi mutations against the deployed
 * ProofRelay. Nothing here fabricates a value: when the API has not answered
 * yet, `data` is undefined and the caller renders the design's loading state.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { parseEventLogs } from "viem";
import type { Hash, PublicClient } from "viem";
import { useAccount, useBlockNumber, useConfig, useConnect, useConnectors, useDisconnect, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import type { Connector } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import * as api from "@/lib/api";
import { ApiError, isApiError } from "@/lib/api";
import { PROOFRELAY_ADDRESS, proofRelayAbi } from "@/lib/contract";
import { chainFeePair } from "@/lib/fees";
import { ACTIVE_CHAIN_ID, MIN_PRIORITY_FEE_WEI, explorerTxUrl, wagmiConfig } from "@/lib/wagmi";
import type {
  ActivityListResponse,
  Address,
  ArtifactListResponse,
  Bytes32,
  HealthResponse,
  PrepareChallengeRequest,
  PrepareTaskRequest,
  PrepareTaskResponse,
  ReportFetchResponse,
  TaskDetail,
  TaskListQuery,
  TaskListResponse,
  VerifierListResponse,
  WorkspaceStats,
} from "@/lib/types";

/* ── polling cadences ────────────────────────────────────────────────────── */

/** The indexer polls the chain every 2 s with 2 confirmations, so nothing below ~4 s can produce new data. */
export const POLL_MS = {
  health: 10_000,
  activity: 10_000,
  tasks: 15_000,
  stats: 15_000,
  /** only while the task is still moving; a finalized task never polls again */
  taskDetail: 8_000,
  artifacts: 30_000,
  verifiers: 60_000,
  chainRead: 15_000,
} as const;

/* ── query keys ──────────────────────────────────────────────────────────── */

export const queryKeys = {
  health: () => ["proofrelay", "health"] as const,
  stats: () => ["proofrelay", "stats"] as const,
  tasks: (query: TaskListQuery) => ["proofrelay", "tasks", query] as const,
  task: (taskId: string | undefined) => ["proofrelay", "task", taskId ?? null] as const,
  verifiers: (query: { status?: string; q?: string }) => ["proofrelay", "verifiers", query] as const,
  artifacts: (query: { kind?: string; q?: string; limit?: number; cursor?: string; offset?: number }) => ["proofrelay", "artifacts", query] as const,
  activity: (query: { category?: string; q?: string; limit?: number; cursor?: string }) => ["proofrelay", "activity", query] as const,
  report: (reportHash: string | undefined) => ["proofrelay", "report", reportHash ?? null] as const,
} as const;

/** Retrying a 400 or a 404 just repeats the same refusal; only transport-level failures earn a retry. */
function retryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && !error.retryable) return false;
  return failureCount < 2;
}

/**
 * Contract statuses after which nothing about a task can change again.
 *
 * These are the exact strings the API puts on `rawStatus` — `statusName()` in
 * packages/schemas/src/task.ts returns TASK_STATUS_NAMES, which are upper case.
 * Spelling them any other way silently makes every task non-terminal and leaves
 * a finalized task polling forever.
 */
const TERMINAL_STATUSES = new Set(["FINALIZED", "EXPIRED", "CANCELLED"]);

export function isTerminalTask(task: { rawStatus: string } | undefined | null): boolean {
  return Boolean(task && TERMINAL_STATUSES.has(task.rawStatus));
}

/* ── read hooks ──────────────────────────────────────────────────────────── */

export function useHealth(): UseQueryResult<HealthResponse, ApiError> {
  return useQuery<HealthResponse, ApiError>({
    queryKey: queryKeys.health(),
    queryFn: ({ signal }) => api.getHealth(signal),
    refetchInterval: POLL_MS.health,
    refetchOnWindowFocus: true,
    retry: retryQuery,
  });
}

export function useStats(): UseQueryResult<WorkspaceStats, ApiError> {
  return useQuery<WorkspaceStats, ApiError>({
    queryKey: queryKeys.stats(),
    queryFn: ({ signal }) => api.getStats(signal),
    refetchInterval: POLL_MS.stats,
    refetchOnWindowFocus: true,
    retry: retryQuery,
  });
}

export function useTasks(query: TaskListQuery = {}): UseQueryResult<TaskListResponse, ApiError> {
  return useQuery<TaskListResponse, ApiError>({
    queryKey: queryKeys.tasks(query),
    queryFn: ({ signal }) => api.listTasks(query, signal),
    refetchInterval: POLL_MS.tasks,
    placeholderData: (previous) => previous,
    retry: retryQuery,
  });
}

/**
 * A task detail polls every 8 s while the task is mid-lifecycle and stops
 * entirely once it is finalized, expired or cancelled — nothing about it can
 * change after that, so continuing to poll would be noise.
 */
export function useTask(taskId: Bytes32 | string | undefined): UseQueryResult<TaskDetail, ApiError> {
  return useQuery<TaskDetail, ApiError>({
    queryKey: queryKeys.task(taskId),
    queryFn: ({ signal }) => api.getTask(taskId as string, signal),
    enabled: Boolean(taskId),
    refetchInterval: (query) => (isTerminalTask(query.state.data) ? false : POLL_MS.taskDetail),
    retry: retryQuery,
  });
}

export function useVerifiers(query: { status?: string; q?: string } = {}): UseQueryResult<VerifierListResponse, ApiError> {
  return useQuery<VerifierListResponse, ApiError>({
    queryKey: queryKeys.verifiers(query),
    queryFn: ({ signal }) => api.listVerifiers(query, signal),
    refetchInterval: POLL_MS.verifiers,
    placeholderData: (previous) => previous,
    retry: retryQuery,
  });
}

export function useArtifacts(query: { kind?: string; q?: string; limit?: number; cursor?: string; offset?: number } = {}): UseQueryResult<ArtifactListResponse, ApiError> {
  return useQuery<ArtifactListResponse, ApiError>({
    queryKey: queryKeys.artifacts(query),
    queryFn: ({ signal }) => api.listArtifacts(query, signal),
    refetchInterval: POLL_MS.artifacts,
    placeholderData: (previous) => previous,
    retry: retryQuery,
  });
}

export function useActivity(query: { category?: string; q?: string; limit?: number; cursor?: string } = {}): UseQueryResult<ActivityListResponse, ApiError> {
  return useQuery<ActivityListResponse, ApiError>({
    queryKey: queryKeys.activity(query),
    queryFn: ({ signal }) => api.listActivity(query, signal),
    refetchInterval: POLL_MS.activity,
    placeholderData: (previous) => previous,
    retry: retryQuery,
  });
}

/** Artifacts are content-addressed, so a fetched report is valid forever. */
export function useReport(reportHash: Bytes32 | string | undefined): UseQueryResult<ReportFetchResponse, ApiError> {
  return useQuery<ReportFetchResponse, ApiError>({
    queryKey: queryKeys.report(reportHash),
    queryFn: ({ signal }) => api.getReport(reportHash as string, signal),
    enabled: Boolean(reportHash),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: retryQuery,
  });
}

/* ── chain reads (authoritative; the UI marks these as chain-sourced) ─────── */

/** The head of the chain the wallet layer is pointed at — the real "latest block". */
export function useLatestBlock() {
  return useBlockNumber({ chainId: ACTIVE_CHAIN_ID, watch: true });
}

/** paused() gates createTask, commitReport and openChallenge — but never finalize/expire/withdraw. */
export function usePaused() {
  const query = useReadContract({
    address: PROOFRELAY_ADDRESS,
    abi: proofRelayAbi,
    functionName: "paused",
    chainId: ACTIVE_CHAIN_ID,
    query: { refetchInterval: POLL_MS.chainRead },
  });
  return { isPaused: query.data === true, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}

/** params() — minBounty, window bounds and bps constants the create form validates against. */
export function useProtocolParams() {
  return useReadContract({
    address: PROOFRELAY_ADDRESS,
    abi: proofRelayAbi,
    functionName: "params",
    chainId: ACTIVE_CHAIN_ID,
    query: { staleTime: Infinity, gcTime: Infinity },
  });
}

/** getVerifier(address) — the live approved/active/stake truth behind the directory row. */
export function useOnchainVerifier(address: Address | undefined) {
  return useReadContract({
    address: PROOFRELAY_ADDRESS,
    abi: proofRelayAbi,
    functionName: "getVerifier",
    args: address ? [address] : undefined,
    chainId: ACTIVE_CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
}

/** allocationOf(taskId, me) — non-zero is the precondition for Claim reward. */
export function useAllocation(taskId: Bytes32 | undefined, account: Address | undefined) {
  return useReadContract({
    address: PROOFRELAY_ADDRESS,
    abi: proofRelayAbi,
    functionName: "allocationOf",
    args: taskId && account ? [taskId, account] : undefined,
    chainId: ACTIVE_CHAIN_ID,
    query: { enabled: Boolean(taskId && account), refetchInterval: POLL_MS.chainRead },
  });
}

/**
 * pendingWithdrawals(me) — the balance the header shows. Undefined until the
 * read lands; the header must render its empty state rather than "0" from thin air.
 */
export function usePendingWithdrawal() {
  const { address } = useAccount();
  const query = useReadContract({
    address: PROOFRELAY_ADDRESS,
    abi: proofRelayAbi,
    functionName: "pendingWithdrawals",
    args: address ? [address] : undefined,
    chainId: ACTIVE_CHAIN_ID,
    query: { enabled: Boolean(address), refetchInterval: POLL_MS.chainRead },
  });
  return {
    address,
    wei: query.data as bigint | undefined,
    hasBalance: typeof query.data === "bigint" && query.data > 0n,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/* ── wallet ──────────────────────────────────────────────────────────────── */

export interface WalletState {
  address: Address | undefined;
  isConnected: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  /** The chain the wallet itself reports — not the chain this app wants. */
  chainId: number | undefined;
  /** Connected, but on something other than the build's chain. wagmi restores this across reloads, so it must be shown, not hidden. */
  isWrongNetwork: boolean;
  isSwitchingNetwork: boolean;
  connector: Connector | undefined;
  connectors: readonly Connector[];
  hasInjectedWallet: boolean;
  connect: (connector?: Connector) => Promise<void>;
  disconnect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  connectError: Error | null;
  switchError: Error | null;
}

export function useWallet(): WalletState {
  const account = useAccount();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending: isConnectPending, error: connectError } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const { mutateAsync: switchChainAsync, isPending: isSwitchingNetwork, error: switchError } = useSwitchChain();

  const connect = useCallback(
    async (connector?: Connector) => {
      const target = connector ?? connectors[0];
      if (!target) throw new Error("No injected wallet was detected in this browser.");
      await connectAsync({ connector: target, chainId: ACTIVE_CHAIN_ID });
    },
    [connectAsync, connectors],
  );

  const disconnect = useCallback(async () => {
    await disconnectAsync({});
  }, [disconnectAsync]);

  const switchNetwork = useCallback(async () => {
    await switchChainAsync({ chainId: ACTIVE_CHAIN_ID });
  }, [switchChainAsync]);

  return useMemo<WalletState>(
    () => ({
      address: account.address,
      isConnected: account.isConnected,
      isConnecting: account.isConnecting || isConnectPending,
      isReconnecting: account.isReconnecting,
      chainId: account.chainId,
      isWrongNetwork: account.isConnected && account.chainId !== undefined && account.chainId !== ACTIVE_CHAIN_ID,
      isSwitchingNetwork,
      connector: account.connector,
      connectors,
      hasInjectedWallet: connectors.length > 0,
      connect,
      disconnect,
      switchNetwork,
      connectError: connectError ?? null,
      switchError: switchError ?? null,
    }),
    [account.address, account.chainId, account.connector, account.isConnected, account.isConnecting, account.isReconnecting, connect, connectError, connectors, disconnect, isConnectPending, isSwitchingNetwork, switchError, switchNetwork],
  );
}

/* ── write plumbing ──────────────────────────────────────────────────────── */

/** What every write mutation resolves to once the receipt is in. */
export interface TxOutcome {
  txHash: Hash;
  blockNumber: number;
  explorerUrl: string | null;
}


/**
 * A transaction that passed estimation and then reverted on execution carries no
 * reason in its receipt — the node only reports `status: "reverted"`. Replaying
 * the same call against the parent block makes the node produce the revert data,
 * which viem decodes into the contract's own custom error or revert string. This
 * is best effort: if the replay itself cannot be made, the caller still gets the
 * plain "reverted" message rather than nothing.
 */
async function revertReason(client: PublicClient | undefined, hash: Hash, blockNumber: bigint): Promise<string | null> {
  if (!client) return null;
  try {
    const tx = await client.getTransaction({ hash });
    await client.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: blockNumber > 0n ? blockNumber - 1n : blockNumber });
    return null;
  } catch (cause) {
    const shell = cause as { shortMessage?: string; details?: string; metaMessages?: string[]; message?: string };
    const reason = shell.shortMessage || shell.details || shell.metaMessages?.[0] || shell.message;
    return typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;
  }
}

/**
 * The error a reverted write throws. `reason` is whatever the contract itself
 * said, so the UI can print the protocol's own words instead of "the transaction
 * was not confirmed".
 */
export class TransactionRevertedError extends Error {
  readonly txHash: Hash;
  readonly blockNumber: number;
  readonly explorerUrl: string | null;
  readonly reason: string | null;

  constructor(hash: Hash, blockNumber: bigint, reason: string | null) {
    super(reason ? `Transaction ${hash} reverted onchain: ${reason}` : `Transaction ${hash} reverted onchain.`);
    this.name = "TransactionRevertedError";
    this.txHash = hash;
    this.blockNumber = Number(blockNumber);
    this.explorerUrl = explorerTxUrl(hash);
    this.reason = reason;
  }
}

export function useTxRunner() {
  const config = useConfig();
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  // Both EIP-1559 fields, so the wallet proposes a fee the node will accept (see lib/fees).
  const feeOverrides = useCallback(() => chainFeePair(publicClient, MIN_PRIORITY_FEE_WEI), [publicClient]);

  /**
   * 0G answers eth_getTransactionReceipt with a not-found for a while after
   * a transaction lands, so this retries that specific gap instead of reporting
   * it as a failed write. A receipt that comes back reverted is replayed once so
   * the revert reason reaches the caller rather than being lost.
   */
  const confirm = useCallback(
    async (hash: Hash) => {
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: ACTIVE_CHAIN_ID, confirmations: 1, pollingInterval: 2_000, retryCount: 40, retryDelay: () => 2_000, timeout: 180_000 });
      if (receipt.status === "reverted") throw new TransactionRevertedError(hash, receipt.blockNumber, await revertReason(publicClient, hash, receipt.blockNumber));
      return receipt;
    },
    [config, publicClient],
  );

  return { writeContractAsync, feeOverrides, confirm };
}

function outcome(hash: Hash, blockNumber: bigint): TxOutcome {
  return { txHash: hash, blockNumber: Number(blockNumber), explorerUrl: explorerTxUrl(hash) };
}

/* ── write hooks ─────────────────────────────────────────────────────────── */

export interface CreateTaskResult extends TxOutcome {
  taskId: Bytes32;
  prepared: PrepareTaskResponse;
  /** true when the post-receipt indexer nudge succeeded; the task list may lag briefly when it did not */
  synced: boolean;
}

/**
 * The full create path: POST /v1/tasks/prepare (which snapshots the sources and
 * uploads the manifest), then createTask with exactly the tuple and value the
 * API returned, then the receipt, then the taskId out of the TaskCreated log.
 */
/**
 * Refuses to sign a preparation that does not describe the task that was asked
 * for. Not a substitute for recomputing the manifest hash from its bytes — that
 * needs the canonical serialiser the API uses — but it catches the substitutions
 * that actually move value or meaning.
 */
function assertPreparedMatchesInput(input: PrepareTaskRequest, prepared: PrepareTaskResponse): void {
  const args = prepared.createTaskArgs;
  const manifest = (prepared.manifest ?? {}) as {
    title?: unknown;
    question?: unknown;
    claims?: { claimText?: unknown }[];
  };

  const mismatch = (what: string): never => {
    throw new Error(
      `The API returned a manifest that does not match what you entered (${what}). Nothing was signed.`,
    );
  };

  if (args.manifestHash !== prepared.manifestHash) mismatch("manifest hash");
  if (args.manifestPointer !== prepared.manifestPointer) mismatch("manifest pointer");
  if (args.valueWei !== input.bountyWei) mismatch("bounty");
  if (input.verifierCount !== undefined && args.verifierCount !== input.verifierCount) {
    mismatch("verifier count");
  }
  if (manifest.title !== input.title) mismatch("title");
  if (manifest.question !== input.question) mismatch("question");

  const returned = (manifest.claims ?? []).map((claim) => String(claim?.claimText ?? ""));
  if (returned.length !== input.claims.length) mismatch("claim count");
  for (let i = 0; i < input.claims.length; i += 1) {
    if (returned[i] !== input.claims[i]) mismatch(`claim ${i + 1}`);
  }
}

export function useCreateTask() {
  const { writeContractAsync, feeOverrides, confirm } = useTxRunner();
  const queryClient = useQueryClient();
  const { address } = useAccount();

  return useMutation<CreateTaskResult, Error, PrepareTaskRequest>({
    mutationKey: ["proofrelay", "createTask"],
    mutationFn: async (input) => {
      // The API resolves the acting address from the session first and from the
      // body second. This client holds no session, so the body is the only
      // channel — without it every prepare is a 401 and no task can be created
      // from the web app at all.
      const creator = input.creator ?? address;
      if (!creator) throw new Error("Connect a wallet before creating a task.");

      const prepared = await api.prepareTask({ ...input, creator });
      // The threat model says a compromised API is "detectable at signing time",
      // and that is only true if something actually checks. The wallet is about
      // to commit a manifest hash and escrow a bounty on the API's word: an API
      // that swapped a claim, dropped a source, or raised the bounty would be
      // signed for without a murmur. Compare what came back against what was
      // typed, before the wallet is asked for anything.
      assertPreparedMatchesInput(input, prepared);
      const args = prepared.createTaskArgs;
      const fees = await feeOverrides();

      const hash = await writeContractAsync({
        address: PROOFRELAY_ADDRESS,
        abi: proofRelayAbi,
        functionName: "createTask",
        args: [
          {
            verifierCount: args.verifierCount,
            commitWindowSec: args.commitWindowSec,
            revealWindowSec: args.revealWindowSec,
            disputeWindowSec: args.disputeWindowSec,
            manifestHash: args.manifestHash,
            manifestPointer: args.manifestPointer,
            ruleId: args.ruleId,
          },
        ],
        value: BigInt(args.valueWei),
        chainId: ACTIVE_CHAIN_ID,
        ...fees,
      });

      const receipt = await confirm(hash);
      const events = parseEventLogs({ abi: proofRelayAbi, eventName: "TaskCreated", logs: receipt.logs });
      const created = events.find((event) => event.address.toLowerCase() === PROOFRELAY_ADDRESS.toLowerCase());
      if (!created) throw new Error("createTask confirmed but emitted no TaskCreated log — refusing to guess a task id.");
      const taskId = created.args.taskId as Bytes32;

      let synced = false;
      try {
        await api.syncTask(taskId);
        synced = true;
      } catch {
        /* the indexer will pick it up on its own pass; the task list just lags a little */
      }

      return { ...outcome(hash, receipt.blockNumber), taskId, prepared, synced };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "tasks"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats() });
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "activity"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.task(result.taskId) });
    },
  });
}

export interface OpenChallengeInput extends PrepareChallengeRequest {
  taskId: Bytes32;
}

export interface OpenChallengeResult extends TxOutcome {
  taskId: Bytes32;
  bondWei: string;
  evidenceHash: Bytes32;
  evidencePointer: string;
}

/** Challenge a consensus: the API pins the evidence artifact and prices the bond, the wallet posts it. */
export function useOpenChallenge() {
  const { writeContractAsync, feeOverrides, confirm } = useTxRunner();
  const queryClient = useQueryClient();
  const { address } = useAccount();

  return useMutation<OpenChallengeResult, Error, OpenChallengeInput>({
    mutationKey: ["proofrelay", "openChallenge"],
    mutationFn: async ({ taskId, ...body }) => {
      const challenger = body.challenger ?? address;
      if (!challenger) throw new Error("Connect a wallet before opening a challenge.");

      const prepared = await api.prepareChallenge(taskId, { ...body, challenger });
      const fees = await feeOverrides();

      const hash = await writeContractAsync({
        address: PROOFRELAY_ADDRESS,
        abi: proofRelayAbi,
        functionName: "openChallenge",
        args: [taskId, prepared.evidenceHash, prepared.evidencePointer],
        value: BigInt(prepared.bondWei),
        chainId: ACTIVE_CHAIN_ID,
        ...fees,
      });

      const receipt = await confirm(hash);
      return { ...outcome(hash, receipt.blockNumber), taskId, bondWei: prepared.bondWei, evidenceHash: prepared.evidenceHash, evidencePointer: prepared.evidencePointer };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(result.taskId) });
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "tasks"] });
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "activity"] });
    },
  });
}

export interface ClaimRewardResult extends TxOutcome {
  taskId: Bytes32;
}

/** claimReward(taskId) — moves an allocation into pendingWithdrawals, finalizing the task if it still needs it. */
export function useClaimReward() {
  const { writeContractAsync, feeOverrides, confirm } = useTxRunner();
  const queryClient = useQueryClient();

  return useMutation<ClaimRewardResult, Error, Bytes32>({
    mutationKey: ["proofrelay", "claimReward"],
    mutationFn: async (taskId) => {
      const fees = await feeOverrides();
      const hash = await writeContractAsync({
        address: PROOFRELAY_ADDRESS,
        abi: proofRelayAbi,
        functionName: "claimReward",
        args: [taskId],
        chainId: ACTIVE_CHAIN_ID,
        ...fees,
      });
      const receipt = await confirm(hash);
      return { ...outcome(hash, receipt.blockNumber), taskId };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(result.taskId) });
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "tasks"] });
      queryClient.invalidateQueries({ queryKey: ["readContract"] });
    },
  });
}

/** withdraw() — sweeps pendingWithdrawals(me) to the wallet. Allowed even while the contract is paused. */
export function useWithdraw() {
  const { writeContractAsync, feeOverrides, confirm } = useTxRunner();
  const queryClient = useQueryClient();

  return useMutation<TxOutcome, Error, void>({
    mutationKey: ["proofrelay", "withdraw"],
    mutationFn: async () => {
      const fees = await feeOverrides();
      const hash = await writeContractAsync({
        address: PROOFRELAY_ADDRESS,
        abi: proofRelayAbi,
        functionName: "withdraw",
        args: [],
        chainId: ACTIVE_CHAIN_ID,
        ...fees,
      });
      const receipt = await confirm(hash);
      return outcome(hash, receipt.blockNumber);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["readContract"] });
      queryClient.invalidateQueries({ queryKey: ["proofrelay", "activity"] });
    },
  });
}

/** Re-exported so a page can build its own query without importing wagmi directly. */
export { wagmiConfig, ACTIVE_CHAIN_ID };
