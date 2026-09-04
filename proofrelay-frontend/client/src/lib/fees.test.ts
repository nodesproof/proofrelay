import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { feePair } from "./fees";

const GWEI = 1_000_000_000n;

describe("feePair", () => {
  it("floors the tip at the network minimum and caps at twice the base fee plus the tip", () => {
    expect(feePair({ suggestedTip: 1n * GWEI, baseFeePerGas: 7n, floorTip: 4n * GWEI })).toEqual({
      maxPriorityFeePerGas: 4n * GWEI,
      maxFeePerGas: 14n + 4n * GWEI,
    });
  });

  it("keeps a node suggestion that is above the floor", () => {
    const pair = feePair({ suggestedTip: 6n * GWEI, baseFeePerGas: 7n, floorTip: 4n * GWEI });
    expect(pair.maxPriorityFeePerGas).toBe(6n * GWEI);
    expect(pair.maxFeePerGas).toBe(14n + 6n * GWEI);
  });

  it("never proposes a cap below the tip, even when the node reports no base fee", () => {
    const pair = feePair({ suggestedTip: null, baseFeePerGas: null, floorTip: 4n * GWEI });
    expect(pair.maxPriorityFeePerGas).toBe(4n * GWEI);
    expect(pair.maxFeePerGas).toBe(4n * GWEI);
  });
});

describe("every wallet write carries both EIP-1559 fields", () => {
  // MetaMask honours a dapp's tip but, without a fee cap beside it, fills the cap
  // from its own estimate — which on 0G mainnet lands under the node's minimum.
  // Scan every client file, not one hook: the registration write lives in a page.
  it("spreads the fee pair into each writeContractAsync call, wherever it is", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
    const writers = files
      .map((f) => ({ file: f, src: readFileSync(join(root, f), "utf8") }))
      .filter(({ src }) => src.includes("writeContractAsync({"));
    expect(writers.length).toBeGreaterThan(1);
    for (const { file, src } of writers) {
      const writes = src.match(/writeContractAsync\(\{/g)?.length ?? 0;
      const spreads = src.match(/\.\.\.(fees\b|\(await feeOverrides\(\)\))/g)?.length ?? 0;
      expect({ file, writes, spreads }).toEqual({ file, writes, spreads: writes });
      expect(src, file).not.toMatch(/^\s*maxPriorityFeePerGas,\s*$/m);
    }
  });
});
