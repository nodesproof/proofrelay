import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundedGas, describeRevert, revertNameFrom } from "./preflight";

describe("boundedGas", () => {
  it("adds a fifth to the estimate and rounds down", () => {
    expect(boundedGas(91_298n)).toBe(109_557n);
    expect(boundedGas(0n)).toBe(0n);
  });
});

describe("describeRevert", () => {
  it("explains the contract's own errors in a sentence and says nothing was sent", () => {
    expect(describeRevert("InvalidStatus", "claimReward")).toMatch(/dispute window to close.*Nothing was sent/);
    expect(describeRevert("NothingToWithdraw", "withdraw")).toMatch(/claim an allocation first/);
  });
  it("still names an error it has no sentence for", () => {
    expect(describeRevert("SomethingNew", "openChallenge")).toBe("The contract would reject openChallenge (SomethingNew). Nothing was sent.");
    expect(describeRevert(undefined, "withdraw")).toBe("The contract would reject withdraw. Nothing was sent.");
  });
});

describe("revertNameFrom", () => {
  it("finds the decoded error name however deep viem wrapped it, without instanceof", () => {
    const wrapped = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", data: { errorName: "NothingToClaim" } } };
    expect(revertNameFrom(wrapped)).toBe("NothingToClaim");
  });
  it("falls back to the reason line viem prints when no data was decoded", () => {
    const bare = { name: "ContractFunctionRevertedError", reason: "InvalidStatus()" };
    expect(revertNameFrom(bare)).toBe("InvalidStatus");
    const messageOnly = { message: 'The contract function "claimReward" reverted with the following reason:\nInvalidStatus()\n\nContract Call:' };
    expect(revertNameFrom(messageOnly)).toBe("InvalidStatus");
  });
  it("gives nothing for an error that is not a revert", () => {
    expect(revertNameFrom(new Error("fetch failed"))).toBeUndefined();
  });
});

describe("no wallet write skips the preflight", () => {
  // The claim that burned 0.04 0G was a write the wallet was handed without a
  // simulation. Every writeContractAsync call must be preceded by one, in
  // whichever file it lives.
  it("every writeContractAsync call has a preflight and a bounded gas limit beside it", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
    const writers = files.map((f) => ({ file: f, src: readFileSync(join(root, f), "utf8") })).filter(({ src }) => src.includes("writeContractAsync({"));
    expect(writers.length).toBeGreaterThan(1);
    for (const { file, src } of writers) {
      const writes = src.match(/writeContractAsync\(\{/g)?.length ?? 0;
      const preflights = src.match(/\bpreflight\(/g)?.length ?? 0;
      const bounded = src.match(/\bgas,?\s*\}\)/g)?.length ?? 0;
      expect({ file, writes, preflights, bounded }).toEqual({ file, writes, preflights: writes, bounded: writes });
    }
  });
});
