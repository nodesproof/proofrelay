import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeCommitment, computeTaskId } from "./encoding.js";
import { proofRelayAbi, EVENT_TOPICS } from "./abi.js";
import { toEventSelector, toFunctionSelector } from "viem";

const CONTRACT = "0xc1E353cb44eA09729143f06Af97E51FB952b33D7";
const CHAIN_ID = 16602;
const root = new URL("../../../", import.meta.url);
const logs = JSON.parse(readFileSync(new URL("docs/recon/logs.json", root), "utf8"));
const txs = JSON.parse(readFileSync(new URL("docs/recon/txs.json", root), "utf8"));

/**
 * Architecture doc §15 lists "cross-check: taskId and commitment encodings
 * pinned against the TypeScript client" as required coverage. These pin against
 * the real chain rather than against ourselves: the fixtures are the actual
 * logs and calldata of the four tasks and six commitments that exist on Galileo.
 */
describe("encodings against live Galileo data", () => {
  const created = logs
    .filter((l: any) => l.topics[0] === EVENT_TOPICS.TaskCreated)
    .sort(
      (a: any, b: any) =>
        Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(a.logIndex) - Number(b.logIndex),
    );

  it("has fixtures", () => {
    expect(created.length).toBeGreaterThan(0);
  });

  it("reproduces every live taskId from creator + nonce", () => {
    created.forEach((log: any, index: number) => {
      const creator = `0x${log.topics[2].slice(-40)}` as `0x${string}`;
      expect(
        computeTaskId({ chainId: CHAIN_ID, contract: CONTRACT, creator, nonce: index }),
      ).toBe(log.topics[1]);
    });
  });

  it("reproduces every live commitment from its reveal", () => {
    const commitments = new Map<string, string>();
    for (const log of logs) {
      if (log.topics[0] !== EVENT_TOPICS.ReportCommitted) continue;
      commitments.set(`${log.topics[1]}:0x${log.topics[2].slice(-40)}`.toLowerCase(), log.data);
    }
    let checked = 0;
    for (const tx of txs) {
      if (!tx.input.startsWith("0x8d1bba6a")) continue;
      const words = tx.input.slice(10).match(/.{64}/g) as string[];
      const taskId = `0x${words[0]}` as `0x${string}`;
      const reportHash = `0x${words[1]}` as `0x${string}`;
      const salt = `0x${words[3]}` as `0x${string}`;
      const key = `${taskId}:${tx.from}`.toLowerCase();
      const expected = commitments.get(key);
      if (!expected) continue;
      expect(computeCommitment({ taskId, verifier: tx.from, reportHash, salt })).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("ABI matches the deployed bytecode", () => {
  const deployed = new Set(
    readFileSync(new URL("docs/recon/selectors.txt", root), "utf8").trim().split("\n"),
  );

  it("every function selector is present in the deployed runtime", () => {
    const missing = proofRelayAbi
      .filter((e) => e.type === "function")
      .map((e) => ({ name: (e as { name: string }).name, sel: toFunctionSelector(e as never).slice(2) }))
      .filter((e) => !deployed.has(e.sel));
    expect(missing).toEqual([]);
  });

  it("every event topic matches the one seen in real logs", () => {
    for (const [name, topic] of Object.entries(EVENT_TOPICS)) {
      const entry = proofRelayAbi.find((e) => e.type === "event" && (e as { name: string }).name === name);
      expect(entry, `${name} missing from abi`).toBeDefined();
      expect(toEventSelector(entry as never), name).toBe(topic);
    }
  });
});
