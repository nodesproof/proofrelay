#!/usr/bin/env node
/**
 * Generates one key per role and writes them to .env, preserving anything that
 * is already there. Re-running is safe: an existing key is never overwritten,
 * because doing so would strand whatever that address is holding.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { repoRoot } from "@proofrelay/config";
import { networkInfo } from "@proofrelay/chain-client";

const ROLES = [
  ["PRIVATE_KEY", "ADMIN_ADDRESS", "deployer / admin — approves verifiers, sets params, pauses"],
  ["KEEPER_PRIVATE_KEY", "KEEPER_ADDRESS", "keeper — finalizeConsensus only; keep its balance small"],
  ["ADJUDICATOR_PRIVATE_KEY", "ADJUDICATOR_ADDRESS", "adjudicator — resolveDispute only"],
  ["VERIFIER_A_PRIVATE_KEY", "VERIFIER_A_ADDRESS", "verifier A"],
  ["VERIFIER_B_PRIVATE_KEY", "VERIFIER_B_ADDRESS", "verifier B"],
  ["STORAGE_PRIVATE_KEY", "STORAGE_ADDRESS", "0G Storage fees — signs an upload on every accepted prepare"],
  ["CREATOR_PRIVATE_KEY", "CREATOR_ADDRESS", "demo task creator (npm run demo)"],
];

const root = repoRoot();
const path = join(root, ".env");
if (!existsSync(path)) {
  const template = join(root, ".env.example");
  writeFileSync(path, existsSync(template) ? readFileSync(template, "utf8") : "");
  console.log("created .env from .env.example");
}

let text = readFileSync(path, "utf8");
const has = (key) => new RegExp(`^${key}=.+$`, "m").test(text);
const setKey = (key, value) => {
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${text.replace(/\n*$/, "\n")}${key}=${value}\n`;
};

console.log("");
for (const [keyVar, addrVar, description] of ROLES) {
  let privateKey;
  if (has(keyVar)) {
    privateKey = text.match(new RegExp(`^${keyVar}=(.+)$`, "m"))[1].trim();
    console.log(`  = ${keyVar.padEnd(26)} kept`);
  } else {
    privateKey = generatePrivateKey();
    setKey(keyVar, privateKey);
    console.log(`  + ${keyVar.padEnd(26)} generated`);
  }
  const address = privateKeyToAccount(privateKey).address;
  if (addrVar) setKey(addrVar, address);
  console.log(`    ${address}  ${description}`);
}
writeFileSync(path, text);

const operator = text.match(/^PRIVATE_KEY=(.+)$/m)[1].trim();
// Read from the file this script just wrote rather than from loadConfig(), which
// would resolve .env.local too — the operator funds the chain .env names, and a
// faucet line for a network that has none is the wrong instruction to print.
const chainId = Number(text.match(/^CHAIN_ID=(\d+)$/m)?.[1] ?? 16602);
const network = networkInfo(chainId);
const faucet = network.faucet;
console.log(`
Wrote ${path} (gitignored).

${faucet
  ? `Fund ONLY the operator at ${faucet} — 0.1 0G per wallet per day:`
  : `${network.name} has no faucet. Send real 0G to the operator only:`}

    ${privateKeyToAccount(operator).address}

then run \`npm run fund\` to spread gas to the other roles.`);
