import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type PublicClient } from "viem";

/**
 * What every wallet write goes through before the wallet sees it.
 *
 * A transaction that reverts on 0G mainnet is not cheap. When the wallet's own
 * gas estimate fails — which is what a doomed call looks like from MetaMask —
 * it falls back to a gas limit in the millions, and the chain charges most of
 * that limit on a revert. The first creator claim on mainnet, sent while the
 * dispute window was still open, burned 0.04 0G that way: 10,080,000 gas of a
 * 12,600,000 fallback limit, for a call the contract refused in its first
 * check.
 *
 * So: simulate first, and turn the contract's own error into a sentence the
 * user can act on; then estimate, and hand the wallet a bounded gas limit so
 * that even a call the state races past costs a few ten-thousandths of a 0G,
 * not a few hundredths.
 */
export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export class PreflightError extends Error {
  readonly errorName: string | undefined;
  constructor(message: string, errorName?: string) {
    super(message);
    this.name = "PreflightError";
    this.errorName = errorName;
  }
}

/** Estimate plus a fifth, so a block's worth of state drift does not turn into an out-of-gas. */
export function boundedGas(estimate: bigint): bigint {
  return (estimate * 12n) / 10n;
}

const EXPLANATIONS: Record<string, string> = {
  InvalidStatus: "The task is not in a state that allows this yet. A claim, for one, waits for the dispute window to close.",
  NothingToClaim: "Nothing is allocated to this wallet on this task.",
  NothingToWithdraw: "This wallet has no withdrawable balance yet — claim an allocation first.",
  NotAuthorized: "This wallet is not allowed to do that on this task.",
  ContractPaused: "The contract is paused; creating, committing and challenging are blocked.",
  VerifierNotActive: "This verifier is not approved and active, so it cannot commit.",
  InsufficientBond: "The bond sent does not match the exact challenge bond the task requires.",
  WindowNotElapsed: "The window this action waits for has not elapsed yet.",
  DeadlinePassed: "The deadline for this action has already passed.",
  DeadlineNotPassed: "The deadline this action waits for has not passed yet.",
  RevealNotOpen: "Reveals have not opened on this task.",
  RevealNotClosed: "Reveals are still open on this task.",
  CommitClosed: "The commit window on this task has closed.",
  AlreadyCommitted: "This verifier has already committed on this task.",
  AlreadyRevealed: "This verifier has already revealed on this task.",
  TaskNotFound: "The contract has no task with this id.",
  InvalidBounty: "The bounty is below the protocol minimum or above what the contract can hold.",
  InvalidWindow: "One of the windows is outside the range the contract accepts.",
  InvalidVerifierCount: "The verifier count is outside the range the contract accepts.",
  DisputeAlreadyResolved: "This dispute has already been resolved.",
};

export function describeRevert(errorName: string | undefined, functionName: string): string {
  if (errorName && EXPLANATIONS[errorName]) return `${EXPLANATIONS[errorName]} Nothing was sent.`;
  if (errorName) return `The contract would reject ${functionName} (${errorName}). Nothing was sent.`;
  return `The contract would reject ${functionName}. Nothing was sent.`;
}

function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return revert?.data?.errorName ?? revert?.signature ?? undefined;
}

/**
 * Simulates the call as the connected account and returns a bounded gas limit
 * for it. Throws a PreflightError — never sending anything — when the contract
 * would revert, when there is no account, or when the RPC cannot be reached to
 * simulate at all, because an unsimulated write is exactly the thing to avoid.
 */
export async function preflightWrite(client: PublicClient | undefined, account: Address | undefined, request: WriteRequest): Promise<bigint> {
  if (!client) throw new PreflightError("No RPC client for the active network, so the transaction could not be checked. Nothing was sent.");
  if (!account) throw new PreflightError("Connect a wallet before sending a transaction.");
  const call = {
    address: request.address,
    abi: request.abi,
    functionName: request.functionName,
    args: request.args ?? [],
    account,
    ...(request.value !== undefined ? { value: request.value } : {}),
  };
  try {
    await client.simulateContract(call);
  } catch (error) {
    const name = revertName(error);
    if (name || error instanceof ContractFunctionRevertedError) throw new PreflightError(describeRevert(name, request.functionName), name);
    const detail = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
    throw new PreflightError(`Could not simulate ${request.functionName}: ${detail}. Nothing was sent.`);
  }
  try {
    return boundedGas(await client.estimateContractGas(call));
  } catch (error) {
    const detail = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
    throw new PreflightError(`Could not estimate gas for ${request.functionName}: ${detail}. Nothing was sent.`);
  }
}
