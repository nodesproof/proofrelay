#!/usr/bin/env node
/**
 * Posts one task through the API's own prepare endpoint and the creator's
 * wallet, then leaves. The running verifiers, orchestrator and keeper are what
 * carry it the rest of the way — which is the point: this proves the deployed
 * system settles a task, not that a script can.
 */
import { parseEther } from "viem";
import { ChainClient, computeTaskId, txUrl } from "@proofrelay/chain-client";
import { assertContractConfigured, env, loadConfig } from "@proofrelay/config";

const config = loadConfig();
assertContractConfigured(config);
const apiUrl = env("VITE_API_URL") ?? `http://127.0.0.1:${config.api.port}`;
const windowSec = Number(env("TASK_WINDOW_SEC") ?? 120);
// Slots, not a target: commitReport reverts once committedCount reaches this,
// and reveal opens as soon as every slot is filled. Set it to the number of
// verifiers you actually want in the task — 2 is the contract MIN_VERIFIERS,
// and a deployment running four leaves two of them locked out at that default.
const verifierCount = Number(env("TASK_VERIFIER_COUNT") ?? 2);

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: env("CREATOR_PRIVATE_KEY") ?? env("PRIVATE_KEY"),
  confirmations: 1,
});

/**
 * A real page, fetched and snapshotted by the API — not text pasted inline.
 *
 * `sources` accepts a URL string, `{uri}`, or `{inlineText, label}`. This used
 * to use the third form with a docs.0g.ai label, which reads like a citation and
 * is not one: the fetch and snapshot path is skipped entirely, so the test
 * proves nothing about the part most likely to break, and the report cites a URL
 * whose content nobody can check against what was actually scored.
 *
 * semver.org because it is short, stable, normative, and — unlike everything
 * else this repo tests with — not about 0G. A verification market that only ever
 * verifies its own chain's documentation has not been tested on anything.
 *
 * Two claims, and the second is deliberately FALSE: the page assigns that rule
 * to MINOR, not MAJOR. That is the more useful shape. All four verifiers return
 * CONTRADICTED and the task still settles CONSENSUS, so this exercises
 * refutation and settlement in one run rather than only agreement. It also
 * guards a real regression: the offline scorer used to answer this SUPPORTED,
 * because the claim overlaps the source almost word for word.
 */
/**
 * The task's subject, from a file when one is named.
 *
 * The body below was the only task this script could post, so every run
 * re-verified the same two sentences about Semantic Versioning — which stops
 * testing anything once it has passed. A file with `title`, `question`,
 * `claims` and `sources` replaces it:
 *
 *   TASK_FILE=scripts/checks/tasks/rfc2119.json npm run check:post-task
 *
 * Windows, verifier count, bounty and creator still come from the environment
 * and the wallet, so a subject file stays a subject file.
 */
const subject = await (async () => {
  const file = env("TASK_FILE");
  if (!file) return null;
  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  for (const key of ["title", "question", "claims", "sources"]) {
    if (!parsed[key]) throw new Error(`${file} has no ${key}`);
  }
  return parsed;
})();

const body = {
  // Unauthenticated callers name the creator explicitly; a browser proves it
  // with a SIWE session instead. Either way the manifest records who asked.
  creator: chain.account,
  title: "Semantic Versioning increment rules",
  question: "Under Semantic Versioning 2.0.0, which version component is incremented for which kind of change?",
  claims: [
    "Under Semantic Versioning, the PATCH version is incremented when you make backward compatible bug fixes.",
    "Under Semantic Versioning, the MAJOR version is incremented when you add functionality in a backward compatible manner.",
  ],
  sources: ["https://semver.org/"],
  ...(subject
    ? {
        title: subject.title,
        question: subject.question,
        claims: subject.claims,
        sources: subject.sources,
      }
    : {}),
  verifierCount,
  commitWindowSec: windowSec,
  revealWindowSec: windowSec,
  disputeWindowSec: windowSec,
  bountyWei: parseEther("0.001").toString(),
};

const prepared = await fetch(`${apiUrl}/v1/tasks/prepare`, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": `post-task-${Date.now()}` },
  body: JSON.stringify(body),
}).then(async (r) => {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
});

for (const warning of prepared.warnings ?? []) console.log(`! ${warning}`);
console.log("subject  ", body.title);
console.log("manifest ", prepared.manifestHash);
console.log("pointer  ", prepared.manifestPointer);

const args = prepared.createTaskArgs;
const nonce = await chain.creatorNonce(chain.account);
const taskId = computeTaskId({
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

console.log("taskId   ", taskId);
console.log("tx       ", txUrl(config.chain.chainId, receipt.txHash));
console.log("\nThe running workers will pick it up. Watch with:");
console.log(`  curl -s ${apiUrl}/v1/tasks/${taskId} | python3 -m json.tool | head -40`);
