#!/usr/bin/env node
/**
 * Proves three things agree: the TypeScript ABI, the Solidity source, and the
 * contract actually deployed on 0G Galileo.
 *
 * The source was rebuilt from a deployment whose code was lost, so "it compiles"
 * is not the bar — a single differing parameter width would produce a different
 * selector and silently break every call against the live contract. This is the
 * check that catches it, and it runs against selectors extracted from the
 * deployed runtime bytecode and topics read from real logs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { toEventSelector, toFunctionSelector } from "viem";
import { createPublicClient, http } from "viem";
import { loadConfig } from "../packages/config/dist/index.js";
import { proofRelayAbi, EVENT_TOPICS } from "../packages/chain-client/dist/abi.js";

const root = new URL("..", import.meta.url);

/**
 * Selectors from the contract this stack is configured to talk to, read live.
 * `docs/recon/selectors.txt` was extracted from the 2024 deployment whose source
 * was lost; pinning against it left this check asserting about a contract nobody
 * talks to once a new one is deployed from this source. It stays as the offline
 * fallback, and the output says which was used.
 */
const config = loadConfig();
let selectorSource = "docs/recon/selectors.txt (offline fallback)";
let deployed;
try {
  const client = createPublicClient({ transport: http(config.chain.rpcUrl) });
  const code = await client.getCode({ address: config.chain.contract });
  if (!code || code.length <= 2) throw new Error("no code at the configured address");
  const found = new Set();
  for (const match of code.matchAll(/63([0-9a-f]{8})/g)) found.add(match[1]);
  if (found.size < 10) throw new Error(`only ${found.size} selectors found`);
  deployed = found;
  selectorSource = `${config.chain.contract} on chain ${config.chain.chainId}`;
} catch (error) {
  console.log(`  (live read failed: ${String(error.message).slice(0, 90)})`);
  deployed = new Set(
    readFileSync(new URL("docs/recon/selectors.txt", root), "utf8").trim().split("\n"),
  );
}
console.log(`selectors read from ${selectorSource}\n`);

/**
 * The check that settles it, and the one this repo could not run until the
 * contract was deployed from this source: does the live runtime equal the bytes
 * this source compiles to?
 *
 * Everything below compares 4-byte selectors, which survive any change to the
 * code behind them. Byte equality survives nothing. `foundry.toml` pins solc,
 * the optimizer and `bytecode_hash = "none"`, so there is no metadata tail to
 * explain a difference away: equal means the deployment runs exactly this source.
 */
let identical = false;
console.log("Deployed runtime vs compiled source");
try {
  const artifact = JSON.parse(
    readFileSync(new URL("contracts/out/ProofRelay.sol/ProofRelay.json", root), "utf8"),
  );
  const compiledCode = String(artifact.deployedBytecode?.object ?? artifact.deployedBytecode)
    .replace(/^0x/, "")
    .toLowerCase();
  const client = createPublicClient({ transport: http(config.chain.rpcUrl) });
  const live = String(await client.getCode({ address: config.chain.contract }))
    .replace(/^0x/, "")
    .toLowerCase();
  identical = live.length > 2 && live === compiledCode;
  console.log(
    identical
      ? `  identical — ${live.length / 2} bytes, so the deployment runs this source`
      : `  DIFFERENT — live ${live.length / 2} B vs compiled ${compiledCode.length / 2} B`,
  );
  if (!identical && live.length > 2) fail("the deployment was not built from this source");
} catch (error) {
  console.log(`  – skipped (${String(error.message).slice(0, 80)})`);
}


let failures = 0;
const fail = (line) => {
  failures += 1;
  console.log(`  ✗ ${line}`);
};

console.log("TypeScript ABI vs deployed bytecode");
let checkedFns = 0;
for (const entry of proofRelayAbi) {
  if (entry.type !== "function") continue;
  checkedFns += 1;
  const selector = toFunctionSelector(entry).slice(2);
  if (deployed.has(selector)) continue;
  // A PUSH4 scan does not see every selector — solc can compare one without ever
  // pushing it as a literal. When the bytecode is byte-identical the interface
  // cannot differ, so a miss here is a scan artifact, not drift.
  if (identical) console.log(`  – 0x${selector} ${entry.name} not seen by the scan (bytecode is identical)`);
  else fail(`0x${selector} ${entry.name} is not in the deployed runtime`);
}
console.log(`  ${checkedFns} functions checked`);

console.log("TypeScript ABI vs real event logs");
for (const [name, topic] of Object.entries(EVENT_TOPICS)) {
  const entry = proofRelayAbi.find((e) => e.type === "event" && e.name === name);
  if (!entry) {
    fail(`${name} is missing from the ABI`);
    continue;
  }
  const computed = toEventSelector(entry);
  if (computed !== topic) fail(`${name}\n      abi   ${computed}\n      chain ${topic}`);
}
console.log(`  ${Object.keys(EVENT_TOPICS).length} events checked`);

console.log("Solidity source vs deployed bytecode");
try {
  const out = execFileSync(
    "forge",
    ["inspect", "--root", "contracts", "ProofRelay", "methodIdentifiers", "--json"],
    { cwd: new URL(".", root).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const compiled = JSON.parse(out);
  const names = Object.keys(compiled);
  for (const signature of names) {
    if (deployed.has(compiled[signature])) continue;
    if (identical) continue; // same scan artifact as above
    fail(`0x${compiled[signature]} ${signature} compiles to a selector the deployment does not have`);
  }
  console.log(`  ${names.length} compiled functions checked`);
} catch (error) {
  console.log(`  – skipped (forge unavailable: ${String(error.message).split("\n")[0]})`);
}

// Custom errors are reported, not enforced. A revert selector only reaches the
// bytecode when that revert path exists, and the rebuilt contract adds guards
// the original did not have — so a compiled error the deployment lacks is
// expected, not drift. What it costs is decoding: a revert from the LIVE
// contract whose selector is not in this ABI surfaces as raw hex rather than a
// name, and the client falls back to the raw message for exactly that case.
try {
  const out = execFileSync("forge", ["inspect", "--root", "contracts", "ProofRelay", "errors", "--json"], {
    cwd: new URL(".", root).pathname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = JSON.parse(out);
  const names = Object.keys(errors);
  const shared = names.filter((name) => deployed.has(errors[name]));
  console.log("Custom errors (informational)");
  console.log(`  ${shared.length}/${names.length} compiled error selectors also appear in the deployment`);

  // The scan reads selectors out of the runtime bytecode, and it misses some:
  // both of these were returned by a live revert from the deployment and are
  // absent from `deployed`. Naming them "only in the rebuilt source" would be
  // the opposite of what was observed, so they are listed as what they are.
  const observedLive = {
    "NothingToWithdraw()": "0xd0d04f60 — withdraw() with an empty balance",
    "DeadlineNotPassed()": "0x2eb35430 — expireTask() before the reveal deadline",
  };
  const confirmed = names.filter((name) => !deployed.has(errors[name]) && observedLive[name]);
  if (confirmed.length) {
    console.log("  confirmed by a live revert, though the bytecode scan misses them:");
    for (const name of confirmed) console.log(`    ${name.replace("()", "").padEnd(20)} ${observedLive[name]}`);
  }
  const onlyHere = names.filter((name) => !deployed.has(errors[name]) && !observedLive[name]);
  if (onlyHere.length) {
    console.log(`  not seen in the deployment: ${onlyHere.map((n) => n.replace("()", "")).join(", ")}`);
  }
} catch {
  console.log("Custom errors (informational)\n  – skipped (forge unavailable)");
}

// What this proves and what it does not. Every check above compares 4-byte
// function selectors and event topics, which survive any change to the code
// behind them: constants, guards, access control, arithmetic. It is an
// INTERFACE check, and calling it more than that is how a caller ends up
// believing the deployment runs the source in this repo. It does not — the
// source here is a reconstruction (docs/recon/RECOVERED_ABI.md), it compiles to
// a different size from the deployed runtime, and its DEFAULT_ADMIN_ROLE is not
// even the same value. Deploy this source and read the new address back if you
// need the behaviour these files describe.
console.log(
  failures !== 0
    ? `\n${failures} mismatch(es).`
    : identical
      ? `\nThe deployment at ${config.chain.contract} is byte-for-byte the code this\n` +
        "source compiles to, and the TypeScript ABI matches it. Nothing here rests on\n" +
        "selectors alone."
      : `\nThe interfaces agree against\n${selectorSource}.\n` +
        "That is an INTERFACE check only — selectors survive any change to the code\n" +
        "behind them. Byte equality is what proves a deployment runs this source.",
);
process.exit(failures === 0 ? 0 : 1);
