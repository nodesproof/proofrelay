#!/usr/bin/env node
/**
 * Proves the whole integrity chain against live data: read the manifest pointer
 * the contract stores, fetch those bytes from 0G Storage, canonicalise, hash,
 * and compare with the manifestHash the contract stores.
 */
import { loadConfig } from "@proofrelay/config";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { ChainClient } from "@proofrelay/chain-client";
import { objectHash, canonicalBytes, parseArtifact } from "@proofrelay/schemas";

const config = loadConfig();
const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
});
const storage = createStorageAdapter(config.storage);

const taskId = process.argv[2] ?? "0xf5b3b3ea97fc38ce0520df37f52c5326f09b132af610e65ed39b14523f3b2db2";
const task = await chain.getTask(taskId);
console.log("task        ", taskId);
console.log("manifestHash", task.manifestHash);
console.log("pointer     ", task.manifestPointer);

const fetched = await storage.get(task.manifestPointer);
const body = JSON.parse(fetched.bytes.toString("utf8"));
const recomputed = objectHash(body);

console.log("bytes       ", fetched.bytes.length, "source:", fetched.source);
console.log("recomputed  ", recomputed);
console.log("MATCH       ", recomputed.toLowerCase() === task.manifestHash.toLowerCase() ? "yes" : "NO");
console.log("canonical rt", canonicalBytes(body).equals(fetched.bytes) ? "byte-identical" : "DIFFERS");
const parsed = parseArtifact("task-manifest", body);
console.log("schema      ", `valid — "${parsed.title}", ${parsed.claims.length} claims, ${parsed.sources.length} sources`);

const verifiers = await chain.getTaskVerifiers(taskId);
for (const verifier of verifiers) {
  const report = await chain.getReport(taskId, verifier);
  if (!report.revealed) { console.log("report      ", verifier, "not revealed"); continue; }
  const got = await storage.get(report.reportPointer);
  const hash = objectHash(JSON.parse(got.bytes.toString("utf8")));
  console.log(
    "report      ", verifier,
    hash.toLowerCase() === report.reportHash.toLowerCase() ? "hash OK" : "HASH MISMATCH",
    `${got.bytes.length}B`,
  );
}
