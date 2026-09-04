import type { PublicClient } from "viem";

/**
 * The pair of EIP-1559 fields every wallet write sends, computed the way the
 * backend's ChainClient computes them (packages/chain-client, feeOverrides):
 * the tip is the node's suggestion floored at the network minimum, and the
 * fee cap is twice the current base fee plus that tip.
 *
 * Both fields have to be sent. MetaMask takes a dapp's tip, but when no cap
 * comes with it the cap is filled from MetaMask's own estimate — and on 0G
 * mainnet, where the base fee sits near zero and eth_feeHistory reports empty
 * blocks as zero-tip blocks, that estimate lands under the node's minimum and
 * the transaction is refused with "transaction gas price below minimum". The
 * only way a user got past that was to edit the fee by hand. Proposing the cap
 * ourselves is what lets the wallet's default land.
 */
export interface FeePair {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function feePair(input: { suggestedTip: bigint | null; baseFeePerGas: bigint | null; floorTip: bigint }): FeePair {
  const tip = input.suggestedTip !== null && input.suggestedTip > input.floorTip ? input.suggestedTip : input.floorTip;
  const base = input.baseFeePerGas ?? 0n;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}

/** Reads the node's tip suggestion and the latest base fee; either failing falls back to the floor alone. */
export async function chainFeePair(client: PublicClient | undefined, floorTip: bigint): Promise<FeePair> {
  if (!client) return feePair({ suggestedTip: null, baseFeePerGas: null, floorTip });
  const [suggestedTip, block] = await Promise.all([
    client.estimateMaxPriorityFeePerGas().catch(() => null),
    client.getBlock({ blockTag: "latest" }).catch(() => null),
  ]);
  return feePair({ suggestedTip, baseFeePerGas: block?.baseFeePerGas ?? null, floorTip });
}
