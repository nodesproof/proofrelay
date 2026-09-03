#!/usr/bin/env node
/**
 * Audit and rotate the operator keys behind ProofRelay's roles.
 *
 *   node scripts/roles.mjs              # audit, read-only (the default)
 *   node scripts/roles.mjs separate     # mint a distinct key per role in .env
 *   node scripts/roles.mjs apply        # grant/revoke on chain to match .env
 *
 * WHY THIS EXISTS. `approve-verifiers` grants a role and never takes one back,
 * so a deployment that started with one key for everything had no way to move
 * off it: granting the successor left the predecessor holding the role too, and
 * "separated" keys that both still work are not separated at all. Revocation is
 * the half that was missing.
 *
 * WHAT ONE SHARED KEY ACTUALLY COSTS. `_requireRevealedSet` refuses to pay a
 * beneficiary that holds ADMIN, KEEPER or ADJUDICATOR, so the shared key cannot
 * name itself — but an admin can approve a second EOA it also controls, have it
 * commit and reveal, and name that one instead. No onchain check can tell two
 * keys of one principal apart. Separating the roles is what bounds it, which is
 * why Deploy.s.sol warns at deploy time and this script exists to fix it after.
 *
 * ORDER MATTERS FOR ADMIN. The contract refuses to let an admin revoke its own
 * DEFAULT_ADMIN_ROLE, because on a single-admin deployment that is a one-way
 * door: no role could be granted again, no verifier approved, no pause lifted.
 * Handing admin over is therefore always grant-then-revoke, executed by the
 * successor. `apply` will not revoke an admin unless another one already holds
 * the role onchain.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ChainClient, ROLE, networkInfo } from "@proofrelay/chain-client";
import { assertContractConfigured, describeConfig, env, loadConfig, repoRoot, resolvedFrom } from "@proofrelay/config";

const command = process.argv[2] ?? "audit";
const assumeYes = process.argv.includes("--yes") || process.argv.includes("-y");
if (!["audit", "separate", "apply"].includes(command)) {
  console.error(`unknown command "${command}" — expected audit, separate or apply`);
  process.exit(2);
}

const config = loadConfig();
const root = repoRoot();
const envPath = join(root, ".env");

/**
 * Every dotenv file in the repo, `.env.example` and friends excluded.
 *
 * A rotation has to touch all of them, not just `.env`. `.env.local` is written
 * by `npm run seed` and it WINS over `.env`, so a new key written only to `.env`
 * is shadowed by the old one and nothing actually rotates — the addresses change
 * in the file, the processes keep signing with the key they had, and the audit
 * that says "separated" is reading a value no service uses. That failure is
 * silent, which is the reason this is a list and not a path.
 */
function envFiles() {
  return readdirSync(root)
    .filter((name) => name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example")))
    .map((name) => join(root, name));
}

/**
 * Every role slot, and the key that is supposed to hold it. STORAGE is in here
 * even though it is not a contract role: it signs a 0G Storage upload on every
 * accepted prepare, which makes it the most-used key in the system, and sharing
 * it with the admin puts the admin's key on the hottest path there is.
 */
const SLOTS = [
  { name: "ADMIN", keyVar: "PRIVATE_KEY", addrVar: "ADMIN_ADDRESS", role: ROLE.ADMIN, rotatable: false,
    note: "grants roles, approves verifiers, sets params" },
  { name: "KEEPER", keyVar: "KEEPER_PRIVATE_KEY", addrVar: "KEEPER_ADDRESS", role: ROLE.KEEPER, rotatable: true,
    note: "finalizeConsensus only" },
  { name: "ADJUDICATOR", keyVar: "ADJUDICATOR_PRIVATE_KEY", addrVar: "ADJUDICATOR_ADDRESS", role: ROLE.ADJUDICATOR, rotatable: true,
    note: "resolveDispute only" },
  { name: "PAUSER", keyVar: null, addrVar: "PAUSER_ADDRESS", role: ROLE.PAUSER, rotatable: false,
    note: "pause/unpause; optional, defaults to the admin at construction" },
  { name: "STORAGE", keyVar: "STORAGE_PRIVATE_KEY", addrVar: "STORAGE_ADDRESS", role: null, rotatable: true,
    note: "pays 0G Storage fees on every upload" },
];

function addressOf(keyVar) {
  const value = env(keyVar);
  if (!value) return null;
  try {
    return privateKeyToAccount(value.startsWith("0x") ? value : `0x${value}`).address;
  } catch {
    return null;
  }
}

/** The address a slot resolves to: its own key if there is one, else the declared address. */
function resolveSlot(slot) {
  const fromKey = slot.keyVar ? addressOf(slot.keyVar) : null;
  const declared = env(slot.addrVar) ?? null;
  return { address: fromKey ?? declared, hasKey: fromKey !== null, declared };
}

const resolved = SLOTS.map((slot) => ({ ...slot, ...resolveSlot(slot) }));

/* ── audit ──────────────────────────────────────────────────────────────── */

/** Slots that resolve to the same address, keyed by address. */
function collisions() {
  const byAddress = new Map();
  for (const slot of resolved) {
    if (!slot.address) continue;
    const key = slot.address.toLowerCase();
    byAddress.set(key, [...(byAddress.get(key) ?? []), slot]);
  }
  return [...byAddress.entries()].filter(([, slots]) => slots.length > 1);
}

let problems = 0;
const fail = (message) => { problems += 1; console.log(`  FAIL  ${message}`); };
const warn = (message) => console.log(`  warn  ${message}`);
const ok = (message) => console.log(`  ok    ${message}`);

console.log(describeConfig(config), "\n");

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: command === "apply" ? env("PRIVATE_KEY") : undefined,
  confirmations: 1,
});

const deployed = !/^0x0+$/.test(config.chain.contract);

console.log("role slots");
for (const slot of resolved) {
  if (!slot.address) {
    if (slot.name === "PAUSER") ok(`${slot.name.padEnd(12)} not configured — the admin holds it from construction`);
    else warn(`${slot.name.padEnd(12)} has no key and no address`);
    continue;
  }
  const balance = await chain.balanceOf(slot.address).catch(() => null);
  const held = deployed && slot.role ? await chain.hasRole(slot.role, slot.address).catch(() => null) : null;
  const roleState = slot.role === null ? "" : held === null ? "  role unreadable" : held ? "  holds the role" : "  DOES NOT hold the role";
  const money = balance === null ? "" : `  ${formatEther(balance)} ${networkInfo(config.chain.chainId).symbol}`;
  const source = slot.keyVar && slot.hasKey ? `  [${resolvedFrom(slot.keyVar)}]` : "";
  console.log(`  ${slot.name.padEnd(12)} ${slot.address}${slot.hasKey ? "" : "  (external, no local key)"}${money}${roleState}${source}`);
  if (slot.role && held === false) fail(`${slot.name} is configured but does not hold its role — run \`npm run roles:apply\``);
  // A key read from anywhere but `.env` is a key `.env` cannot be trusted to
  // describe. Say which file actually wins before anyone edits the wrong one.
  if (slot.keyVar && slot.hasKey) {
    const from = resolvedFrom(slot.keyVar);
    if (from !== ".env" && from !== "default") {
      warn(`${slot.name}'s key comes from ${from}, which wins over .env — edit that file, not .env`);
    }
  }
}

/**
 * Every file that defines a key var, and the address each definition yields.
 *
 * Deliberately file-level rather than precedence-level. `loadEnv` resolves ONE
 * winner per process, and which one wins depends on the role that process runs
 * as — `.env.adjudicator` beats `.env` for the adjudicator and is invisible to
 * everything else. An audit that only asks "what did I load?" therefore reports
 * a separation that one process does not actually have. Asking the files
 * directly sees every copy at once.
 */
function definitionsOf(keyVar) {
  const out = [];
  for (const file of envFiles()) {
    const match = readFileSync(file, "utf8").match(new RegExp(`^${keyVar}=(.+)$`, "m"));
    if (!match) continue;
    const value = match[1].trim();
    let address = null;
    try {
      address = privateKeyToAccount(value.startsWith("0x") ? value : `0x${value}`).address;
    } catch { /* a malformed key is reported by its slot, not here */ }
    out.push({ file: file.slice(root.length + 1), value, address });
  }
  return out;
}

console.log("\nkey copies across env files");
const shadowed = [];
for (const slot of resolved) {
  if (!slot.keyVar) continue;
  const defs = definitionsOf(slot.keyVar);
  if (defs.length <= 1) continue;
  const distinct = new Set(defs.map((d) => d.address));
  if (distinct.size === 1) {
    warn(`${slot.keyVar} is duplicated in ${defs.map((d) => d.file).join(" and ")} — same key, but one copy too many`);
    continue;
  }
  shadowed.push({ slot, defs });
  fail(
    `${slot.keyVar} differs between files: ${defs.map((d) => `${d.file}=${d.address ?? "unparseable"}`).join(", ")}\n` +
      `        A process running as that role loads the one with the higher precedence, not the one in .env.\n` +
      `        Fix: node scripts/roles.mjs separate`,
  );
}
if (shadowed.length === 0 && resolved.every((s) => !s.keyVar || definitionsOf(s.keyVar).length <= 1)) {
  ok("each key is defined in exactly one file");
}

console.log("\nkey separation");
const shared = collisions();
if (shared.length === 0) {
  ok("every role slot has its own key");
} else {
  for (const [address, slots] of shared) {
    fail(
      `${slots.length} slots share one key ${address}: ${slots.map((s) => s.name).join(", ")}\n` +
        `        A leak of it does everything those roles can do at once. ` +
        `${slots.some((s) => s.rotatable) ? "Fix: node scripts/roles.mjs separate" : "Fix: point them at distinct addresses."}`,
    );
  }
}

/* ── stale holders ──────────────────────────────────────────────────────── */

/**
 * Every address ever granted a role, from the RoleGranted log, re-checked
 * against hasRole. There is no RoleRevoked event by design, so a revocation is
 * only observable this way — and a holder nobody configured any more is exactly
 * what a half-finished rotation leaves behind.
 */
async function currentHolders() {
  if (!deployed) return [];
  const head = await chain.blockNumber();
  const start = BigInt(Math.max(config.indexer.startBlock, 0));
  const span = 40_000n;
  const seen = new Map();
  for (let from = start; from <= head; from += span) {
    const to = from + span - 1n > head ? head : from + span - 1n;
    const logs = await chain.getLogs(from, to);
    for (const log of logs) {
      if (chain.eventNameForTopic(log.topics[0] ?? "") !== "RoleGranted") continue;
      const role = log.topics[1];
      const account = `0x${(log.topics[2] ?? "").slice(-40)}`;
      if (!role || account.length !== 42) continue;
      seen.set(`${role}:${account.toLowerCase()}`, { role, account });
    }
  }
  const holders = [];
  for (const { role, account } of seen.values()) {
    if (await chain.hasRole(role, account)) holders.push({ role, account });
  }
  return holders;
}

const ROLE_NAME = Object.fromEntries(Object.entries(ROLE).map(([name, hash]) => [hash.toLowerCase(), name]));
const stale = [];

if (deployed) {
  console.log("\nonchain holders");
  const holders = await currentHolders();
  for (const { role, account } of holders) {
    const name = ROLE_NAME[role.toLowerCase()] ?? role;
    const slot = resolved.find((s) => s.role?.toLowerCase() === role.toLowerCase());
    const isConfigured = slot?.address && slot.address.toLowerCase() === account.toLowerCase();
    // The admin also holds PAUSER from construction; that is the contract's own
    // design, not drift, so it is not reported as a stale grant.
    const adminsPauser =
      name === "PAUSER" && resolved.find((s) => s.name === "ADMIN")?.address?.toLowerCase() === account.toLowerCase();
    if (isConfigured || adminsPauser) {
      ok(`${name.padEnd(12)} ${account}${adminsPauser && !isConfigured ? "  (admin, from construction)" : ""}`);
    } else {
      stale.push({ role, name, account });
      fail(`${name.padEnd(12)} ${account} holds the role but is not the configured ${slot?.addrVar ?? name}`);
    }
  }
  if (holders.length === 0) warn("no RoleGranted logs found in the indexed range");
}

/* ── separate ───────────────────────────────────────────────────────────── */

if (command === "separate") {
  if (shared.length === 0 && shadowed.length === 0) {
    console.log("\nnothing to separate — every slot already has its own key, in one file.");
    process.exit(0);
  }
  if (!existsSync(envPath)) {
    console.error(`\n${envPath} does not exist — run \`npm run wallets\` first`);
    process.exit(1);
  }
  const files = envFiles();
  const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

  /**
   * Set the value in `.env`, and in every other dotenv file that already
   * mentions the key. Files that never mentioned it are left alone: adding a
   * signing key to a role file that did not ask for one would hand it to a
   * process that has no business holding it.
   */
  const setKey = (key, value) => {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const touched = [];
    for (const [file, text] of contents) {
      const defines = pattern.test(text);
      if (!defines && file !== envPath) continue;
      contents.set(
        file,
        defines ? text.replace(pattern, `${key}=${value}`) : `${text.replace(/\n*$/, "\n")}${key}=${value}\n`,
      );
      touched.push(file.slice(root.length + 1));
    }
    return touched;
  };

  console.log("\nseparating");
  const rotated = [];
  // Counted apart from the audit's findings on purpose: the audit fails because
  // the keys are wrong, which is the reason this command was run. Only a problem
  // that makes the WRITE unsafe may block the write.
  let blocked = 0;

  // Reconciling before rotating, and in that order. A shadow is not a shared
  // key — the addresses already differ — so minting a third key would strand
  // whatever was funded for the second. `.env` is the authority: it is the file
  // `npm run wallets` writes and the only one meant to be edited by hand.
  for (const { slot, defs } of shadowed) {
    const canonical = defs.find((d) => d.file === ".env");
    if (!canonical) {
      blocked += 1;
      fail(`${slot.keyVar} is not defined in .env, so there is no authoritative copy to propagate`);
      continue;
    }
    for (const def of defs) {
      if (def.file === ".env") continue;
      console.log(`  ~ ${slot.name.padEnd(12)} ${def.file} held ${def.address}; replaced with .env's ${canonical.address}`);
    }
    setKey(slot.keyVar, canonical.value);
  }
  for (const [, slots] of shared) {
    // The first slot keeps the key. ADMIN keeps it whenever it is in the group:
    // it is the address that holds the balance and DEFAULT_ADMIN_ROLE, and a
    // fresh admin key would have to be granted the role by the old one anyway.
    const keeps = slots.find((s) => !s.rotatable) ?? slots[0];
    for (const slot of slots) {
      if (slot === keeps || !slot.rotatable || !slot.keyVar) {
        console.log(`  = ${slot.name.padEnd(12)} keeps ${slot.address}`);
        continue;
      }
      if (resolvedFrom(slot.keyVar) === "environment") {
        blocked += 1;
        fail(`${slot.name}'s key is exported in the environment; no file rotation can override it. Unset ${slot.keyVar} and re-run.`);
        continue;
      }
      const privateKey = generatePrivateKey();
      const address = privateKeyToAccount(privateKey).address;
      const touched = setKey(slot.keyVar, privateKey);
      if (slot.addrVar) setKey(slot.addrVar, address);
      rotated.push({ ...slot, address });
      console.log(`  + ${slot.name.padEnd(12)} new key  ${address}   [${touched.join(", ")}]`);
    }
  }
  if (blocked > 0) {
    console.error("\nrefusing to write: the problems above are not ones this command can repair");
    process.exit(1);
  }
  for (const [file, text] of contents) writeFileSync(file, text);
  console.log(`\nWrote ${[...contents.keys()].map((f) => f.slice(root.length + 1)).join(", ")}.`);
  if (rotated.length === 0) {
    // Reconciliation only: no address changed, so nothing needs funding and no
    // role needs granting. Saying otherwise sends an operator to spend gas on a
    // transaction the chain would reject as a no-op.
    console.log("No new key was minted — the files were only made to agree. Restart whatever");
    console.log("reads a file that changed:\n");
    console.log("    pm2 restart proofrelay-api proofrelay-adjudicator");
  } else {
    console.log("The old key keeps its balance and its admin role; the new");
    console.log("ones are empty and hold nothing yet. Next, in this order:\n");
    console.log("    npm run fund              # gas for the new addresses");
    console.log("    npm run roles:apply       # grant the roles, revoke the old ones");
    console.log("    pm2 restart proofrelay-api proofrelay-adjudicator   # they hold these keys");
  }
  if (rotated.some((slot) => slot.name === "STORAGE")) {
    console.log("\nSTORAGE moved too. It pays a fee per upload, not just gas, so give it more");
    console.log("than the gas floor or the next prepare fails with an unfunded storage wallet.");
  }
  process.exit(0);
}

/* ── apply ──────────────────────────────────────────────────────────────── */

if (command === "apply") {
  if (!deployed) {
    console.error("\nPROOFRELAY_ADDRESS is not set — there is no deployment to change");
    process.exit(1);
  }
  assertContractConfigured(config);
  if (!chain.account) {
    console.error("\nPRIVATE_KEY is not set — apply signs as the admin");
    process.exit(1);
  }
  if (!(await chain.hasRole(ROLE.ADMIN, chain.account))) {
    console.error(`\n${chain.account} does not hold DEFAULT_ADMIN_ROLE on ${config.chain.contract}.`);
    console.error("If admin has already moved to a multisig, run these calls from it instead.");
    process.exit(1);
  }

  const pending = [];
  for (const slot of resolved.filter((s) => s.role && s.address)) {
    if (slot.name === "PAUSER" && !env("PAUSER_ADDRESS")) continue;
    if (await chain.hasRole(slot.role, slot.address)) continue;
    pending.push(slot);
  }

  // An admin that is about to be revoked must not be the only one left. The
  // contract blocks revoking your own admin role, but it cannot stop you
  // revoking the last *other* admin, and this does.
  const revocations = [];
  for (const entry of stale) {
    if (entry.name === "ADMIN") {
      const others = resolved.find((s) => s.name === "ADMIN");
      const successorHolds = others?.address ? await chain.hasRole(ROLE.ADMIN, others.address) : false;
      if (!successorHolds) {
        warn(`refusing to revoke ADMIN from ${entry.account}: no other address holds DEFAULT_ADMIN_ROLE yet`);
        continue;
      }
      if (entry.account.toLowerCase() === chain.account.toLowerCase()) {
        warn(`ADMIN ${entry.account} is the signer; the contract refuses self-revocation — run this from the successor`);
        continue;
      }
    }
    revocations.push(entry);
  }

  console.log("\nplanned changes");
  for (const slot of pending) console.log(`  grant   ${slot.name.padEnd(12)} -> ${slot.address}`);
  for (const entry of revocations) console.log(`  REVOKE  ${entry.name.padEnd(12)} <- ${entry.account}`);
  if (pending.length === 0 && revocations.length === 0) {
    console.log("  (none — the chain already matches .env)");
    process.exit(problems > 0 ? 1 : 0);
  }

  // A revocation cannot be undone by the address losing it, and on a network
  // with no faucet a mistake is not cheap to unwind. Same gate as deploy.sh.
  const needsConfirm = revocations.length > 0 || networkInfo(config.chain.chainId).faucet === null;
  if (needsConfirm && !assumeYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nType the chain id (${config.chain.chainId}) to apply: `);
    rl.close();
    if (answer.trim() !== String(config.chain.chainId)) {
      console.error("aborted");
      process.exit(1);
    }
  }

  console.log("");
  // Grants first, always. A revocation that lands before its replacement grant
  // leaves the role unheld, and for KEEPER that means no task can be finalized
  // until the next transaction confirms.
  for (const slot of pending) {
    const receipt = await chain.send("grantRole", [slot.role, slot.address]);
    console.log(`  + ${slot.name.padEnd(12)} ${slot.address} granted   ${receipt.txHash}`);
  }
  for (const entry of revocations) {
    const receipt = await chain.send("revokeRole", [entry.role, entry.account]);
    console.log(`  - ${entry.name.padEnd(12)} ${entry.account} revoked   ${receipt.txHash}`);
  }
  console.log("\nRe-run `npm run roles` to confirm, and restart anything holding a changed key.");
  process.exit(0);
}

console.log(problems === 0 ? "\nno problems." : `\n${problems} problem(s) above.`);
process.exit(problems > 0 ? 1 : 0);
