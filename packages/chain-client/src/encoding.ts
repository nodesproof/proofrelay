import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

/**
 * Id and commitment encodings, pinned against the deployed contract.
 *
 * Both are cross-checked in encoding.test.ts against real on-chain values: the
 * four live tasks and the six live commitments reproduce exactly. A drift here
 * would make the client predict the wrong task, or make a verifier's reveal
 * revert with CommitmentMismatch after the report was already uploaded, so
 * these are the two encodings worth pinning with real data rather than a
 * round-trip test against ourselves.
 */

/** keccak256(abi.encode(chainId, contract, creator, creatorNonce)). */
export function computeTaskId(args: {
  chainId: number | bigint;
  contract: Address;
  creator: Address;
  nonce: number | bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, address, uint256"), [
      BigInt(args.chainId),
      args.contract,
      args.creator,
      BigInt(args.nonce),
    ]),
  );
}

/** keccak256(abi.encode(taskId, verifier, reportHash, salt)). */
export function computeCommitment(args: {
  taskId: Hex;
  verifier: Address;
  reportHash: Hex;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, address, bytes32, bytes32"), [
      args.taskId,
      args.verifier,
      args.reportHash,
      args.salt,
    ]),
  );
}

/**
 * A verifier's salt. Derived rather than random so a worker that crashes
 * between uploading its report and revealing can recompute the same commitment
 * instead of stranding its own reveal.
 */
/**
 * Removed. A commitment's salt must be random, not derived.
 *
 * This produced `keccak(secret, taskId, reportHash)` from a "secret" the verifier
 * worker built out of its own address and profile id — both public — so anyone
 * could recompute the salt and test a guessed reportHash against the commitment
 * on chain. Against a deterministic pipeline that is a reproduction rather than a
 * guess, and a second verifier could read the first one's report before reveal.
 * The worker now draws 32 random bytes and journals them; see
 * workers/verifier/src/journal.ts for why persisting beats recomputing.
 */

export const ROLE = {
  KEEPER: keccak256(new TextEncoder().encode("PROOFRELAY_KEEPER")),
  ADJUDICATOR: keccak256(new TextEncoder().encode("PROOFRELAY_ADJUDICATOR")),
  PAUSER: keccak256(new TextEncoder().encode("PROOFRELAY_PAUSER")),
  ADMIN: `0x${"0".repeat(64)}` as Hex,
} as const;
