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

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: env("CREATOR_PRIVATE_KEY") ?? env("PRIVATE_KEY"),
  confirmations: 1,
});

// Claims both pipelines should agree on, so the settlement exercises the
// consensus path rather than the conflict rate.
const body = {
  // Unauthenticated callers name the creator explicitly; a browser proves it
  // with a SIWE session instead. Either way the manifest records who asked.
  creator: chain.account,
  title: "0G Storage standalone availability",
  question: "Is 0G Storage usable without a blockchain integration?",
  claims: [
    "0G Storage can be used standalone without any blockchain integration.",
    "0G Storage provides client libraries in Go and TypeScript.",
  ],
  sources: [
    {
      inlineText:
        "0G Storage can be used completely standalone without any blockchain integration.\n" +
        "Store and retrieve massive datasets with Go and TypeScript client libraries.",
      label: "https://docs.0g.ai/introduction/understanding-0g",
    },
  ],
  verifierCount: 2,
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
