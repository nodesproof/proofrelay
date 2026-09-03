#!/usr/bin/env node
/**
 * Runs one indexer pass against the live chain and prints what it found.
 * Useful on its own, and the fastest way to tell whether the read model is
 * behind because the indexer is broken or because the chain is quiet.
 */
import { Indexer } from "../../apps/api/dist/indexer/indexer.js";
import { ArtifactSync } from "../../apps/api/dist/indexer/artifact-sync.js";
import { createPool } from "../../apps/api/dist/db.js";
import { Logger } from "../../apps/api/dist/observability.js";
import { ChainClient } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { assertContractConfigured, assertIndexerStartBlock, describeConfig, loadConfig } from "@proofrelay/config";

const config = loadConfig();
assertContractConfigured(config);
assertIndexerStartBlock(config);
console.log(describeConfig(config), "\n");

const pool = createPool(config);
const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
});
const logger = new Logger(config.api.logLevel);
const indexer = new Indexer({ config, pool, chain, logger });
const artifacts = new ArtifactSync({ pool, storage: createStorageAdapter(config.storage), logger });

const deadline = Date.now() + Number(process.env.INDEX_FOR_MS ?? 120_000);
let passes = 0;
while (Date.now() < deadline) {
  const pass = await indexer.runOnce();
  passes += 1;
  const status = indexer.status();
  console.log(
    `pass ${passes}  block ${status.lastBlock}/${status.headBlock}  lag ${status.lagBlocks}  ` +
      `events ${status.processedEvents} (+${pass?.projected ?? 0} new)` +
      `${status.lastError ? `  error ${status.lastError}` : ""}`,
  );
  // Caught up: the pass consumed the whole range and found nothing new. Waiting
  // a poll interval here rather than spinning is the difference between one
  // request every two seconds and two hundred thousand of them.
  if ((pass?.projected ?? 0) === 0 && (status.lagBlocks ?? 0) <= config.indexer.confirmations) break;
  await new Promise((resolve) => setTimeout(resolve, config.indexer.pollMs));
}

console.log("\nfetching artifacts from 0G Storage and verifying their hashes");
for (let round = 0; round < 20; round += 1) {
  const result = await artifacts.runOnce();
  if (!result || (result.claimed ?? 0) === 0) break;
  console.log(
    `  claimed ${result.claimed}  verified ${result.verified}  ` +
      `mismatched ${result.mismatched ?? 0}  failed ${result.failed ?? 0}`,
  );
}

for (const [table, label] of [
  ["tasks", "tasks"],
  ["reports", "reports"],
  ["chain_events", "chain events"],
  ["artifacts", "artifacts"],
  ["verifiers", "verifiers"],
  ["consensus_results", "consensus results"],
  ["disputes", "disputes"],
]) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  console.log(`  ${String(rows[0].n).padStart(4)}  ${label}`);
}

const { rows } = await pool.query(
  `SELECT task_id, sequence, status, outcome, title, bounty, manifest_verified
     FROM tasks ORDER BY sequence`,
);
console.log("");
for (const row of rows) {
  console.log(
    `  PR-${1000 + Number(row.sequence)}  status ${row.status} outcome ${row.outcome}  ` +
      `${row.bounty} wei  manifest ${row.manifest_verified ? "verified" : "unverified"}  ` +
      `${row.title ?? "(title not yet fetched)"}`,
  );
}

await pool.end();
