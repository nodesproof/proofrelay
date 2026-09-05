#!/usr/bin/env node
/**
 * One command that answers "why is this not working".
 *
 * It checks the things that actually go wrong: a stale .env.local pointing at
 * another chain, an unfunded role wallet, a contract that is paused or absent,
 * a verifier that never got approved, storage or compute misconfigured, and a
 * database that has not been migrated.
 */
import { formatEther } from "viem";
import { ChainClient, ROLE, networkInfo } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { createComputeAdapter } from "@proofrelay/compute-adapter";
import { computeRouterFor, describeConfig, env, loadConfig, resolvedFrom } from "@proofrelay/config";
import pg from "pg";

const config = loadConfig();
let problems = 0;
const ok = (line) => console.log(`  ok    ${line}`);
const warn = (line) => console.log(`  warn  ${line}`);
const bad = (line) => {
  problems += 1;
  console.log(`  FAIL  ${line}`);
};

console.log(describeConfig(config), "\n");

console.log("configuration");
if (resolvedFrom("CHAIN_ID") === ".env.local" || resolvedFrom("PROOFRELAY_ADDRESS") === ".env.local") {
  warn(".env.local is in effect and wins over .env — check it first if the chain looks wrong");
}
if (/^0x0+$/.test(config.chain.contract)) bad("PROOFRELAY_ADDRESS is not set");
else ok(`contract ${config.chain.contract}`);
if (config.chain.chainId !== 31337 && config.indexer.startBlock <= 0) {
  bad("PROOFRELAY_DEPLOY_BLOCK is 0 on a public chain; the indexer would scan from genesis");
} else ok(`indexer starts at block ${config.indexer.startBlock}`);

console.log("\nchain");
const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
});
try {
  const actual = await chain.publicClient.getChainId();
  const head = await chain.blockNumber();
  if (actual !== config.chain.chainId) bad(`CHAIN_ID=${config.chain.chainId} but the RPC is chain ${actual}`);
  else ok(`${networkInfo(actual).name} at head ${head}`);
  // A deploy block from another network survives a CHAIN_ID switch in .env and
  // is the quiet way a testnet-to-mainnet move indexes nothing at all: the
  // start block sits ahead of the head, so the scan never reaches a log and
  // every other check still passes.
  if (BigInt(config.indexer.startBlock) > head) {
    bad(
      `PROOFRELAY_DEPLOY_BLOCK ${config.indexer.startBlock} is ahead of ${networkInfo(actual).name}'s head ${head} — ` +
        `it belongs to another network. The indexer would never see a log.`,
    );
  }
  const code = await chain.publicClient.getBytecode({ address: config.chain.contract });
  if (!code || code === "0x") bad(`no contract code at ${config.chain.contract}`);
  else ok(`contract has ${(code.length - 2) / 2} bytes of code`);
  if (await chain.isPaused()) warn("the contract is PAUSED: no new escrow, commits or challenges");
  else ok("not paused");
  const liabilities = await chain.totalLiabilities();
  const balance = await chain.balanceOf(config.chain.contract);
  if (balance < liabilities) bad(`contract balance ${formatEther(balance)} < liabilities ${formatEther(liabilities)}`);
  else ok(`escrow solvent: ${formatEther(balance)} 0G held, ${formatEther(liabilities)} 0G owed`);
} catch (error) {
  bad(`chain unreachable: ${String(error.message).slice(0, 160)}`);
}

console.log("\nrole wallets");
for (const [name, floor] of [
  ["ADMIN_ADDRESS", 0n],
  ["KEEPER_ADDRESS", 1_000_000_000_000_000n],
  ["ADJUDICATOR_ADDRESS", 1_000_000_000_000_000n],
  ["VERIFIER_A_ADDRESS", 2_000_000_000_000_000n],
  ["VERIFIER_B_ADDRESS", 2_000_000_000_000_000n],
  ["VERIFIER_C_ADDRESS", 2_000_000_000_000_000n],
  ["VERIFIER_D_ADDRESS", 2_000_000_000_000_000n],
  // One `prepare` writes up to 21 objects at a measured 0.001182 0G each, so
  // anything under a full prepare's worth is already too late — the request
  // that finds out is the one that fails. The storage health probe only catches
  // an outright empty wallet; this catches the approach to it.
  ["STORAGE_ADDRESS", 25_000_000_000_000_000n],
]) {
  const address = env(name);
  if (!address) { warn(`${name} is not set`); continue; }
  const balance = await chain.balanceOf(address).catch(() => null);
  if (balance === null) { warn(`${name} balance unreadable`); continue; }
  if (balance < floor) bad(`${name} ${address} has ${formatEther(balance)} 0G — run \`npm run fund\``);
  else ok(`${name.padEnd(20)} ${address}  ${formatEther(balance)} 0G`);
}

console.log("\nroles and approvals");
for (const [name, role] of [["KEEPER_ADDRESS", ROLE.KEEPER], ["ADJUDICATOR_ADDRESS", ROLE.ADJUDICATOR]]) {
  const address = env(name);
  if (!address) continue;
  (await chain.hasRole(role, address).catch(() => false))
    ? ok(`${name} holds its role`)
    : bad(`${name} does not hold its role — run \`npm run approve-verifiers\``);
}
for (const name of ["VERIFIER_A_ADDRESS", "VERIFIER_B_ADDRESS", "VERIFIER_C_ADDRESS", "VERIFIER_D_ADDRESS"]) {
  const address = env(name);
  if (!address) continue;
  const record = await chain.getVerifier(address).catch(() => null);
  if (!record) { warn(`${name} unreadable`); continue; }
  if (!record.registered) warn(`${name} has not registered yet — start the worker once`);
  else if (!record.approved) bad(`${name} is registered but NOT approved — run \`npm run approve-verifiers\``);
  else if (!record.active) warn(`${name} is approved but inactive`);
  else ok(`${name} registered, approved, active`);
}

console.log("\n0G Storage");
try {
  const health = await createStorageAdapter(config.storage).health();
  health.ok ? ok(`${config.storage.driver}: ${health.detail}`) : bad(`${config.storage.driver}: ${health.detail}`);
} catch (error) {
  bad(`${config.storage.driver}: ${String(error.message).slice(0, 200)}`);
}

console.log("\n0G Compute");
if (config.compute.driver === "local") {
  warn(
    `COMPUTE_DRIVER=local — the deterministic engine runs, but no 0G Compute call is made. ` +
      `For the real thing set COMPUTE_DRIVER=zerog-router and COMPUTE_API_KEY from ${computeRouterFor(config.chain.chainId).console}`,
  );
} else {
  try {
    const health = await createComputeAdapter(config.compute).health();
    health.ok ? ok(`${config.compute.driver}: ${health.detail}`) : bad(`${config.compute.driver}: ${health.detail}`);
  } catch (error) {
    bad(`${config.compute.driver}: ${String(error.message).slice(0, 240)}`);
  }
}

console.log("\ndatabase");
const client = new pg.Client({ connectionString: config.api.databaseUrl });
try {
  await client.connect();
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  const names = rows.map((r) => r.tablename);
  const required = ["tasks", "reports", "chain_events", "artifacts", "jobs", "verifiers"];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length) bad(`not migrated: missing ${missing.join(", ")} — run \`npm run migrate\``);
  else ok(`${names.length} tables present`);
  await client.end();
} catch (error) {
  bad(`database unreachable: ${String(error.message).slice(0, 160)}`);
  await client.end().catch(() => undefined);
}

console.log(problems === 0 ? "\nEverything checks out." : `\n${problems} problem(s) above.`);
process.exit(problems === 0 ? 0 : 1);
