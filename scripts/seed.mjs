#!/usr/bin/env node
/**
 * Posts real tasks to the configured chain so the UI has something to show.
 *
 * Nothing here is mocked: each task is a real escrow transaction, its manifest
 * and source snapshots are really uploaded to 0G Storage, and the verifier
 * workers pick them up like any other task. The three shapes exist because the
 * demo has to show all three outcomes — agreement, disagreement, and a claim
 * the sources simply do not settle.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { formatEther, parseEther } from "viem";
import { ChainClient, computeTaskId } from "@proofrelay/chain-client";
import { assertContractConfigured, describeConfig, env, loadConfig } from "@proofrelay/config";

const config = loadConfig();
assertContractConfigured(config);
console.log(describeConfig(config), "\n");

const apiUrl = env("VITE_API_URL") ?? `http://127.0.0.1:${config.api.port}`;
const creatorKey = env("CREATOR_PRIVATE_KEY") ?? env("PRIVATE_KEY");
if (!creatorKey) {
  console.error("CREATOR_PRIVATE_KEY is not set — run `npm run wallets`");
  process.exit(1);
}

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: creatorKey,
  confirmations: 1,
});

const health = await fetch(`${apiUrl}/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`the API is not answering at ${apiUrl}. Start it first: node apps/api/dist/server.js`);
  process.exit(1);
}
if (health.chainId !== config.chain.chainId) {
  console.error(`the API is on chain ${health.chainId} but this script is on ${config.chain.chainId}`);
  process.exit(1);
}

// Public 0G documentation, so the demo only ever quotes public data.
const SOURCES = [
  "https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/introduction/understanding-0g.md",
  "https://raw.githubusercontent.com/0glabs/0g-doc/main/docs/developer-hub/building-on-0g/storage/sdk.md",
];

const TASKS = [
  {
    title: "0G Storage standalone availability",
    question: "Is 0G Storage usable without a blockchain integration, per the official documentation?",
    claims: [
      "0G Storage can be used standalone without any blockchain integration.",
      "0G provides client libraries for storage in more than one language.",
    ],
    bounty: "0.002",
    note: "expected to settle on agreement",
  },
  {
    title: "0G ecosystem partner count",
    question: "Does the documentation state an exact number of ecosystem partners?",
    claims: ["The 0G ecosystem has more than 300 partners."],
    bounty: "0.002",
    note: "expected to be INSUFFICIENT_EVIDENCE — the snapshot does not state a count",
  },
  {
    title: "0G Storage release version claim",
    question: "Do the snapshots support a specific released version number for the storage SDK?",
    claims: [
      "The 0G storage SDK released version 9.9.9.",
      "0G Storage supports retrieving data by a content root hash.",
    ],
    bounty: "0.003",
    note: "expected to produce a conflict or a contradiction",
  },
];

/**
 * The API accepts 8-255 characters of [A-Za-z0-9._:-] and nothing else, and
 * these titles have spaces in them — `seed-${spec.title}` was rejected with
 * VALIDATION_FAILED before a single task could be posted.
 *
 * Derived from the title rather than from a timestamp on purpose: the key is
 * what makes a re-run idempotent, so the same task has to produce the same key.
 * A `Date.now()` key would let `npm run seed` post duplicates of everything
 * every time it is run, and on a public chain each duplicate escrows a bounty.
 */
function idempotencyKey(title) {
  const slug = `seed-${title}`.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 255).padEnd(8, "-x");
}

const created = [];
for (const spec of TASKS) {
  console.log(`preparing "${spec.title}"`);
  const prepared = await fetch(`${apiUrl}/v1/tasks/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey(spec.title) },
    body: JSON.stringify({
      creator: chain.account,
      title: spec.title,
      question: spec.question,
      claims: spec.claims,
      sources: SOURCES,
      verifierCount: 2,
      commitWindowSec: 300,
      revealWindowSec: 300,
      disputeWindowSec: 300,
      bountyWei: parseEther(spec.bounty).toString(),
    }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  });

  for (const warning of prepared.warnings ?? []) console.log(`  ! ${warning}`);
  console.log(`  manifest ${prepared.manifestHash}`);
  console.log(`  pointer  ${prepared.manifestPointer}`);

  const args = prepared.createTaskArgs;
  const nonce = await chain.creatorNonce(chain.account);
  const predicted = computeTaskId({
    chainId: config.chain.chainId,
    contract: config.chain.contract,
    creator: chain.account,
    nonce,
  });

  const receipt = await chain.send(
    "createTask",
    [
      {
        verifierCount: args.verifierCount,
        commitWindowSec: args.commitWindowSec,
        revealWindowSec: args.revealWindowSec,
        disputeWindowSec: args.disputeWindowSec,
        manifestHash: args.manifestHash,
        manifestPointer: args.manifestPointer,
        ruleId: args.ruleId,
      },
    ],
    { value: BigInt(args.valueWei) },
  );

  console.log(`  task     ${predicted}`);
  console.log(`  tx       ${receipt.txHash}  (${spec.note})\n`);
  created.push({ taskId: predicted, title: spec.title, txHash: receipt.txHash });
}

// .env.local is what makes this machine's chain and database stick across
// services. It wins over .env, which is exactly why the runbook says to look
// here first when something is on the wrong chain.
const localPath = join(config.root, ".env.local");
const existing = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
const lines = [
  "# Written by `npm run seed`. Safe to delete; regenerate by re-seeding.",
  `CHAIN_ID=${config.chain.chainId}`,
  `OG_RPC_URL=${config.chain.rpcUrl}`,
  `PROOFRELAY_ADDRESS=${config.chain.contract}`,
  `PROOFRELAY_DEPLOY_BLOCK=${config.chain.deployBlock}`,
  `INDEXER_START_BLOCK=${config.chain.deployBlock}`,
  `DATABASE_URL=${config.api.databaseUrl}`,
  `STORAGE_DRIVER=${config.storage.driver}`,
  `COMPUTE_DRIVER=${config.compute.driver}`,
];
// Preserve any key the previous file carried; regenerating them would strand
// funds. A key `.env` already defines is NOT carried over: this file wins over
// `.env`, so a stale copy here silently overrides a rotation done there — the
// addresses change, the processes keep signing with the old key, and an audit
// reading `.env` reports a separation that never happened.
const envText = existsSync(join(config.root, ".env")) ? readFileSync(join(config.root, ".env"), "utf8") : "";
for (const line of existing.split("\n")) {
  if (!/^[A-Z_]*PRIVATE_KEY=/.test(line) && !/^COMPUTE_API_KEY=/.test(line)) continue;
  const name = line.slice(0, line.indexOf("="));
  if (new RegExp(`^${name}=.+$`, "m").test(envText)) continue;
  lines.push(line);
}
writeFileSync(localPath, `${lines.join("\n")}\n`);

console.log(`seeded ${created.length} tasks; wrote ${localPath}`);
console.log(`balance left ${formatEther(await chain.balanceOf(chain.account))} 0G`);
console.log("\nThe verifier workers will pick these up on their next poll.");
