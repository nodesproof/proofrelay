#!/usr/bin/env node
/**
 * Replays a settled task from the live chain.
 *
 * Fetches the manifest and both verifier reports from 0G Storage by the
 * pointers the contract stores, hash-checks every one of them, re-runs the
 * consensus engine over exactly those reports, and compares the outcome with
 * what the keeper actually submitted onchain.
 *
 * This is the "Reproducibility" acceptance criterion in the PRD, executed
 * against real data rather than a fixture: same snapshot, same pipeline, same
 * answer.
 *
 *   node scripts/checks/replay-live-task.mjs [taskId]
 */
import { ChainClient } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { evaluateConsensus } from "@proofrelay/consensus";
import { hashesEqual, objectHash, outcomeName, parseArtifact, statusName } from "@proofrelay/schemas";
import { assertContractConfigured, loadConfig } from "@proofrelay/config";

const config = loadConfig();
assertContractConfigured(config);

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
});
const storage = createStorageAdapter(config.storage);

const taskId = process.argv[2] ?? "0xf5b3b3ea97fc38ce0520df37f52c5326f09b132af610e65ed39b14523f3b2db2";
const task = await chain.getTask(taskId);
if (task.status === 0) {
  console.error(`no such task on chain ${config.chain.chainId}: ${taskId}`);
  process.exit(1);
}

console.log(`task     ${taskId}`);
console.log(`status   ${statusName(task.status)}  outcome ${outcomeName(task.outcome)}  rewardBps ${task.rewardBps}`);
console.log(`bounty   ${task.bounty} wei`);

const manifestBytes = await storage.get(task.manifestPointer);
if (!hashesEqual(manifestBytes.hash, task.manifestHash)) {
  console.error(`manifest hash mismatch: chain ${task.manifestHash}, storage ${manifestBytes.hash}`);
  process.exit(1);
}
const manifest = parseArtifact("task-manifest", JSON.parse(manifestBytes.bytes.toString("utf8")));
console.log(`manifest "${manifest.title}" — ${manifest.claims.length} claims, ${manifest.sources.length} sources  [hash OK]`);

const verifiers = await chain.getTaskVerifiers(taskId);
const reports = [];
const reportHashes = [];
for (const verifier of verifiers) {
  const record = await chain.getReport(taskId, verifier);
  if (!record.revealed) {
    console.log(`report   ${verifier}  not revealed`);
    continue;
  }
  const fetched = await storage.get(record.reportPointer);
  const matches = hashesEqual(fetched.hash, record.reportHash);
  const body = JSON.parse(fetched.bytes.toString("utf8"));
  console.log(
    `report   ${verifier}  ${matches ? "hash OK" : "HASH MISMATCH"}  ` +
      `${body.verifier?.modelId ?? "?"}  ${body.claims?.length ?? 0} claims`,
  );
  if (!matches) continue;
  reports.push(parseArtifact("verifier-report", body));
  reportHashes.push(record.reportHash);
}

if (reports.length === 0) {
  console.error("nothing revealed to replay");
  process.exit(1);
}

const replayed = evaluateConsensus({
  taskId,
  manifestHash: task.manifestHash,
  ruleId: task.ruleId,
  producer: config.api.producerId,
  reports,
  manifestClaims: manifest.claims.map((claim) => ({ claimId: claim.claimId, claimText: claim.claimText })),
  reportHashes,
  evaluatedAt: new Date(0).toISOString(),
});

console.log("");
console.log(`replayed outcome   ${replayed.outcome}   agreement ${replayed.agreementBps} bps`);
for (const claim of replayed.claims) {
  const marks = claim.verdicts.map((v) => `${v.verifier.slice(0, 6)}=${v.verdict}@${v.confidence}`).join("  ");
  console.log(`  ${claim.claimId}  ${claim.agreed ? "AGREED " : "SPLIT  "} ${claim.majorityVerdict}`);
  console.log(`    ${marks}`);
  if (!claim.agreed) console.log(`    ${claim.reason}`);
}
for (const conflict of replayed.conflicts) console.log(`  conflict: ${conflict}`);

const onchain = outcomeName(task.outcome);
const expected = replayed.outcome === "CONSENSUS" ? "CONSENSUS" : replayed.outcome === "CONFLICT" ? "CONFLICT" : "NO_QUORUM";
console.log("");
console.log(`onchain outcome    ${onchain}`);
console.log(
  onchain === expected
    ? "MATCH — replaying the stored snapshots reproduces the settlement the chain recorded."
    : `DIFFERS — the chain settled ${onchain} but a replay says ${expected}.`,
);
console.log(`replayed result hash ${objectHash(replayed)}`);
process.exit(onchain === expected ? 0 : 2);
