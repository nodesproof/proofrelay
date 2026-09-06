#!/usr/bin/env node
/**
 * Does this verifier profile's compute credential actually produce a report?
 *
 * `doctor` answers for the chain and for storage; nothing answered for compute,
 * and compute is the one dependency that fails SOFTLY. A wrong model, a drained
 * Payment Layer deposit, or a provider that spells the verdict its own way all
 * leave the worker running and the reports still arriving — just produced by the
 * offline scorer, under the model's name, with the substitution recorded only in
 * a trace nobody reads. This runs one real scoring call through the real adapter
 * and says which engine answered.
 *
 *   OK        the model answered every claim, and the verdicts are right
 *   PARTIAL   the model answered, but the driver refused it on some claim and
 *             that one fell to the offline scorer
 *   DEGRADED  the compute call failed outright; nothing reached a model
 *   WRONG     the model answered and got it wrong
 *
 *   node scripts/checks/verifier-compute.mjs           # a, b, c, d
 *   node scripts/checks/verifier-compute.mjs c d       # just these
 *   node scripts/checks/verifier-compute.mjs --list    # which profiles, no spend
 *
 * With no arguments it checks the profiles this machine actually has — a role
 * file, a key variable, or VERIFIER_PROFILE — not a fixed a/b/c/d list.
 *
 * It spends a completion per profile, so run it after changing a key or a model
 * — not on a timer.
 *
 * ONE PROFILE PER PROCESS. `loadEnv()` memoises, and which `.env.verifier-<x>`
 * it reads is decided by VERIFIER_PROFILE at first call, so a loop inside one
 * process would score every profile against whichever role file happened to
 * load first — and report the wrong key as healthy. The parent re-execs itself.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..", "..");
const requested = process.argv.slice(2).filter((arg) => arg !== "--one" && arg !== "--list");
const one = process.argv.includes("--one");
// Discovery is the part that goes wrong quietly, and confirming it must not
// cost a completion. --list answers "which verifiers do you think I have".
const listOnly = process.argv.includes("--list");

/**
 * The profiles this machine can actually run, found rather than assumed.
 *
 * This used to be the literal list ["a","b","c","d"], which is this repo's own
 * development set-up and nobody else's. A standalone operator running
 * VERIFIER_PROFILE=nodesproof got four SKIP lines about keys they had never
 * heard of and no line about the verifier they were actually running — the one
 * check built to explain a fallback, silent about the only profile present.
 *
 * A name is a candidate if a role file names it, if a key variable for it is
 * set, or if it is the profile this shell already selected. Read from the files
 * directly: loadEnv() memoises against one profile, and this runs before any
 * profile has been chosen.
 */
function discoverProfiles() {
  const names = new Set();
  const ambient = process.env.VERIFIER_PROFILE?.trim();
  if (ambient) names.add(ambient.toLowerCase());

  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const match = /^\.env\.verifier-(.+)$/.exec(entry);
    if (match && !entry.endsWith(".example")) names.add(match[1].toLowerCase());
  }

  const keyPattern = /^\s*VERIFIER_([A-Z0-9_]+)_PRIVATE_KEY\s*=\s*(.*)$/gm;
  const sources = [...entries.filter((e) => /^\.env(\..+)?$/.test(e) && !e.endsWith(".example"))];
  for (const file of sources) {
    let text = "";
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const [, key, value] of text.matchAll(keyPattern)) {
      if (value.trim()) names.add(key.toLowerCase());
    }
  }
  for (const key of Object.keys(process.env)) {
    const match = /^VERIFIER_([A-Z0-9_]+)_PRIVATE_KEY$/.exec(key);
    if (match && process.env[key]?.trim()) names.add(match[1].toLowerCase());
  }
  return [...names].sort();
}

if (!one) {
  const found = requested.length ? requested : discoverProfiles();
  if (found.length === 0) {
    console.log(
      "no verifier profile found. Set VERIFIER_PROFILE and the matching " +
        "VERIFIER_<NAME>_PRIVATE_KEY in .env, or name one: check:compute <profile>",
    );
    process.exit(1);
  }
  if (listOnly) {
    console.log(found.join("\n"));
    process.exit(0);
  }
  const profiles = found;
  let failed = 0;
  for (const profile of profiles) {
    const result = spawnSync(process.execPath, [self, "--one", profile], {
      stdio: "inherit",
      env: { ...process.env, VERIFIER_PROFILE: profile },
    });
    if (result.status !== 0) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

const name = requested[0] ?? "a";
const { loadConfig, verifierProfile } = await import("@proofrelay/config");
const { createComputeAdapter } = await import("@proofrelay/compute-adapter");

let profile;
try {
  profile = verifierProfile(name);
} catch (error) {
  console.log(`${`verifier-${name}`.padEnd(12)}SKIP      ${String(error.message)}`);
  process.exit(0);
}

// Two claims the corpus settles on its own: one the spans support, one they
// contradict. CONTRADICTED is the load-bearing half — it is the verdict models
// abbreviate to CONTRADICT, and the driver takes only the exact literal.
const now = new Date().toISOString();
const corpus = [
  {
    sourceId: "src-network",
    uri: "https://docs.0g.ai/network",
    snapshotObjectId: "local://check-network",
    contentHash: `0x${"11".repeat(32)}`,
    text:
      "0G Mainnet — Chain ID 16661, RPC https://evmrpc.0g.ai. " +
      "0G Galileo Testnet — Chain ID 16602, RPC https://evmrpc-testnet.0g.ai.",
    retrievedAt: now,
  },
  {
    sourceId: "src-storage",
    uri: "https://docs.0g.ai/storage",
    snapshotObjectId: "local://check-storage",
    contentHash: `0x${"22".repeat(32)}`,
    text:
      "Each uploaded object settles a storage fee on chain, paid by the signer " +
      "of the submission. Storage fees are denominated in 0G and scale with object size.",
    retrievedAt: now,
  },
];
const claims = [
  { claimId: "claim-001", claimText: "The 0G mainnet chain id is 16661." },
  { claimId: "claim-002", claimText: "0G Storage charges no fee for uploads." },
];
const EXPECTED = { "claim-001": "SUPPORTED", "claim-002": "CONTRADICTED" };

const config = loadConfig();
const adapter = createComputeAdapter(config.compute, {
  evidenceDepth: profile.evidenceDepth,
  supportThreshold: profile.supportThreshold,
});
const label = `${profile.id.padEnd(12)}${adapter.modelId.padEnd(34)}`;

const health = await adapter
  .health()
  .catch((error) => ({ ok: false, detail: String(error.message), latencyMs: null }));
if (!health.ok) {
  console.log(`${label}HEALTH    ${health.detail}`);
  process.exit(1);
}

const started = Date.now();
const { value, trace } = await adapter.scoreEvidence({
  claims,
  corpus,
  evidenceDepth: profile.evidenceDepth,
  supportThreshold: profile.supportThreshold,
});
const ms = Date.now() - started;

// The trace is the only place a substitution shows. `provider` reading
// `…(fallback:local)` means the whole call degraded; a per-claim degrade is
// quieter still, so the verdicts are compared too.
// Two different failures that used to look the same. `provider` reports the
// whole call; `result.degraded` reports one claim whose answer the driver
// refused — a verdict outside the accepted literals, most often a model
// writing CONTRADICT for CONTRADICTED. Before the per-claim marker existed
// that second case was invisible here and showed up only as WRONG, which
// sends you looking at the wrong thing.
const degraded = /fallback:local/.test(trace.provider ?? "");
const degradedClaims = value.filter((result) => result.degraded).map((result) => result.claimId);
const wrong = value.filter((result) => result.verdict !== EXPECTED[result.claimId]);
const status = degraded
  ? "DEGRADED"
  : degradedClaims.length
    ? "PARTIAL"
    : wrong.length
      ? "WRONG"
      : "OK";

console.log(
  `${label}${status.padEnd(10)}${ms}ms  provider=${trace.provider ?? "?"}` +
    (degradedClaims.length ? `  model answer refused for ${degradedClaims.join(", ")}` : ""),
);
console.log(
  `${" ".repeat(12)}${value.map((r) => `${r.claimId}=${r.verdict}@${r.confidence}`).join("  ")}`,
);
process.exit(status === "OK" ? 0 : 1);
