#!/usr/bin/env node
/**
 * One task, end to end, on the configured chain — the PRD's acceptance
 * criteria executed rather than asserted.
 *
 * prepare -> escrow -> two verifiers build reports from the same snapshots ->
 * commit -> reveal -> consensus -> finalize -> claim -> withdraw, printing the
 * transaction hash and the 0G Storage pointer at every step so a reader can
 * check each one on the explorer.
 *
 * It runs the workers in-process rather than talking to running ones, so it is
 * a self-contained proof that does not depend on what else is up.
 *
 *   node scripts/checks/full-cycle.mjs
 */
import { join } from "node:path";
import { formatEther } from "viem";
import { ChainClient, ROLE, computeTaskId, txUrl } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { createComputeAdapter } from "@proofrelay/compute-adapter";
import { evaluateConsensus } from "@proofrelay/consensus";
import {
  Outcome,
  contentHash,
  hashesEqual,
  objectHash,
  outcomeName,
  parseArtifact,
  SCHEMA_VERSION,
  statusName,
} from "@proofrelay/schemas";
import { assertContractConfigured, env, loadConfig, verifierProfile } from "@proofrelay/config";
import { buildReport } from "../../workers/verifier/dist/pipeline.js";
import { CommitJournal } from "../../workers/verifier/dist/journal.js";
import { VerifierWorker } from "../../workers/verifier/dist/worker.js";

const config = loadConfig();
assertContractConfigured(config);

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const detail = (label, value) => console.log(`    ${label.padEnd(18)} ${value}`);

/**
 * `--claim <taskId>` finishes a cycle whose dispute window had not closed yet.
 * Splitting it out is not a convenience: the window has to really elapse, and a
 * script that slept through it would be asserting that the contract enforces
 * the wait rather than observing it.
 */
if (process.argv.includes("--claim")) {
  const target = process.argv[process.argv.indexOf("--claim") + 1];
  if (!target) {
    console.error("usage: full-cycle.mjs --claim <taskId>");
    process.exit(1);
  }
  const reader = new ChainClient({
    chainId: config.chain.chainId,
    rpcUrl: config.chain.rpcUrl,
    contract: config.chain.contract,
  });
  const task = await reader.getTask(target);
  console.log(`task ${target}`);
  console.log(`status ${statusName(task.status)}  outcome ${outcomeName(task.outcome)}`);

  const closesAt = task.consensusAt + task.disputeWindow;
  const remaining = closesAt - Math.floor(Date.now() / 1000);
  if (task.status === 4 && remaining > 0) {
    console.log(`the dispute window closes in ${remaining}s; claiming now would revert`);
    process.exit(2);
  }

  for (const profileName of ["a", "b"]) {
    const profile = verifierProfile(profileName);
    const chain = new ChainClient({
      chainId: config.chain.chainId,
      rpcUrl: config.chain.rpcUrl,
      contract: config.chain.contract,
      privateKey: profile.privateKey,
      confirmations: 1,
    });
    const allocation = await chain.allocationOf(target, chain.account);
    let pendingBefore = await chain.pendingWithdrawals(chain.account);
    if (allocation === 0n && pendingBefore === 0n) {
      console.log(`  ${profile.id.padEnd(12)} ${chain.account}  nothing allocated or pending`);
      continue;
    }
    const before = await chain.balanceOf(chain.account);

    // finalizeTask sweeps every allocation into pendingWithdrawals, so a task
    // the keeper already finalized has nothing left to claim — the money is
    // waiting, not missing. Only an unfinalized task needs claimReward, which
    // auto-finalizes on the way.
    let claim = null;
    if (allocation > 0n) {
      claim = await chain.send("claimReward", [target]);
      pendingBefore = await chain.pendingWithdrawals(chain.account);
    }
    const pending = pendingBefore;
    const withdraw = await chain.send("withdraw", []);
    const after = await chain.balanceOf(chain.account);
    console.log(`  ${profile.id.padEnd(12)} ${chain.account}`);
    console.log(`    allocated  ${formatEther(allocation)} 0G`);
    if (claim) console.log(`    claim tx   ${txUrl(config.chain.chainId, claim.txHash)}`);
    else console.log(`    claim      not needed — finalizeTask already swept it to pendingWithdrawals`);
    console.log(`    withdrew   ${formatEther(pending)} 0G`);
    console.log(`    withdraw   ${txUrl(config.chain.chainId, withdraw.txHash)}`);
    console.log(`    balance    ${formatEther(before)} -> ${formatEther(after)} 0G`);
  }

  const settled = await reader.getTask(target);
  console.log(`\nfinal status ${statusName(settled.status)}  outcome ${outcomeName(settled.outcome)}`);
  process.exit(0);
}

const creatorKey = env("CREATOR_PRIVATE_KEY") ?? env("PRIVATE_KEY");
const keeperKey = env("KEEPER_PRIVATE_KEY");
if (!creatorKey || !keeperKey) {
  console.error("CREATOR_PRIVATE_KEY (or PRIVATE_KEY) and KEEPER_PRIVATE_KEY must be set");
  process.exit(1);
}

const storage = createStorageAdapter(config.storage);
const creator = new ChainClient({ ...chainOpts(), privateKey: creatorKey, confirmations: 1 });
const keeper = new ChainClient({ ...chainOpts(), privateKey: keeperKey, confirmations: 1 });

function chainOpts() {
  return {
    chainId: config.chain.chainId,
    rpcUrl: config.chain.rpcUrl,
    contract: config.chain.contract,
  };
}

console.log(`chain ${config.chain.chainId}  contract ${config.chain.contract}`);
console.log(`storage ${config.storage.driver}  compute ${config.compute.driver}`);

/* 1 — snapshot the sources and build a manifest */

step(1, "snapshot sources and upload the manifest to 0G Storage");

const SOURCES = [
  {
    sourceId: "src-001",
    uri: "https://example.org/proofrelay/CHANGELOG.md",
    text: `# Changelog

Release v1.4.0 — August 10, 2026.
Adds streaming support and drops Node.js 18.`,
  },
  {
    sourceId: "src-002",
    uri: "https://example.org/proofrelay/README.md",
    text: `# proofrelay-demo

The current stable release is v1.4.0 and it requires Node.js 20 or newer.`,
  },
];

const manifestSources = [];
for (const source of SOURCES) {
  const snapshot = {
    kind: "source-snapshot",
    schemaVersion: SCHEMA_VERSION,
    producer: config.api.producerId,
    sourceId: source.sourceId,
    uri: source.uri,
    status: "OK",
    httpStatus: null,
    contentType: "text/plain; charset=utf-8",
    headers: { "x-proofrelay-source": "inline" },
    text: source.text,
    byteLength: Buffer.byteLength(source.text),
    contentHash: contentHash(source.text),
    truncated: false,
    error: null,
    retrievedAt: new Date().toISOString(),
  };
  const put = await storage.put("source-snapshot", snapshot);
  detail(source.sourceId, `${put.pointer}  ${put.byteLength} B`);
  manifestSources.push({
    sourceId: source.sourceId,
    uri: source.uri,
    status: "OK",
    contentHash: snapshot.contentHash,
    byteLength: snapshot.byteLength,
    snapshotHash: put.hash,
    snapshotPointer: put.pointer,
  });
}

const RULE_ID = `0x${"22".repeat(32)}`;
const WINDOW = Number(env("CYCLE_WINDOW_SEC") ?? 120);

const manifest = {
  kind: "task-manifest",
  schemaVersion: SCHEMA_VERSION,
  producer: config.api.producerId,
  manifestId: `cycle-${objectHash({ at: SOURCES[0].text }).slice(2, 10)}`,
  chainId: config.chain.chainId,
  creator: creator.account,
  title: "proofrelay-demo release claims",
  question: "Are the stated release facts supported by the snapshotted documentation?",
  answerText: null,
  claims: [
    { claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10.", origin: "creator" },
    { claimId: "claim-002", claimText: "The repository released version 2.0.0 on August 10, 2026.", origin: "creator" },
    { claimId: "claim-003", claimText: "The maintainers relocated their head office to Lisbon in 2026.", origin: "creator" },
  ],
  sources: manifestSources,
  extraction: null,
  policy: {
    verifierCount: 2,
    commitWindowSec: WINDOW,
    revealWindowSec: WINDOW,
    disputeWindowSec: WINDOW,
    maxEvidencePerClaim: 3,
    ruleId: RULE_ID,
  },
  safety: { publicDataOnly: true, redactions: [], warnings: [] },
  createdAt: new Date().toISOString(),
};

const manifestPut = await storage.put("task-manifest", manifest);
detail("manifest", `${manifestPut.pointer}`);
detail("manifestHash", manifestPut.hash);

/* 2 — escrow */

step(2, "create the task and escrow the bounty");

const bounty = BigInt(env("CYCLE_BOUNTY_WEI") ?? 1_000_000_000_000_000n);
const nonce = await creator.creatorNonce(creator.account);
const taskId = computeTaskId({
  chainId: config.chain.chainId,
  contract: config.chain.contract,
  creator: creator.account,
  nonce,
});

const createReceipt = await creator.send(
  "createTask",
  [
    {
      verifierCount: 2,
      commitWindowSec: WINDOW,
      revealWindowSec: WINDOW,
      disputeWindowSec: WINDOW,
      manifestHash: manifestPut.hash,
      manifestPointer: manifestPut.pointer,
      ruleId: RULE_ID,
    },
  ],
  { value: bounty },
);
detail("taskId", taskId);
detail("bounty", `${formatEther(bounty)} 0G`);
detail("tx", txUrl(config.chain.chainId, createReceipt.txHash) ?? createReceipt.txHash);

const created = await creator.getTask(taskId);
if (created.status === 0) throw new Error("createTask did not produce the predicted taskId");
detail("status", statusName(created.status));

/* 3 — two verifiers, two configurations */

step(3, "two independent verifiers build reports from the same snapshots");

const workers = [];
for (const profileName of ["a", "b"]) {
  const profile = verifierProfile(profileName);
  const chain = new ChainClient({ ...chainOpts(), privateKey: profile.privateKey, confirmations: 1 });
  const record = await chain.getVerifier(chain.account);
  if (!record.approved || !record.active) {
    console.error(`\n${chain.account} is not an approved, active verifier. Run \`npm run approve-verifiers\`.`);
    process.exit(1);
  }
  workers.push(
    new VerifierWorker({
      chain,
      storage,
      compute: createComputeAdapter(config.compute, {
        evidenceDepth: profile.evidenceDepth,
        supportThreshold: profile.supportThreshold,
      }),
      journal: new CommitJournal(join(config.root, ".proofrelay", "cycle"), `${profile.id}-cycle`),
      verifierId: profile.id,
      evidenceDepth: profile.evidenceDepth,
      supportThreshold: profile.supportThreshold,
      pollMs: 1_000,
      log: (level, message, fields = {}) => {
        if (level === "info") detail(fields.verifierId ?? "worker", message);
        else console.log(`    ! ${message} ${JSON.stringify(fields)}`);
      },
    }),
  );
}

// Commit phase. Every worker must commit before any can reveal — that is the
// property that makes the two answers independent.
for (const worker of workers) await worker.tick();

const afterCommit = await creator.getTask(taskId);
detail("committed", `${afterCommit.committedCount}/${afterCommit.verifierCount}`);
if (afterCommit.committedCount < 2) throw new Error("not every verifier committed");

step(4, "reveal — no report pointer was readable until every commitment landed");
for (const worker of workers) await worker.tick();

const afterReveal = await creator.getTask(taskId);
detail("revealed", `${afterReveal.revealedCount}/${afterReveal.verifierCount}`);
detail("status", statusName(afterReveal.status));
if (afterReveal.revealedCount < 2) throw new Error("not every verifier revealed");

/* 5 — consensus */

step(5, "evaluate consensus over the revealed reports");

const verifiers = await creator.getTaskVerifiers(taskId);
const reports = [];
const reportHashes = [];
for (const verifier of verifiers) {
  const record = await creator.getReport(taskId, verifier);
  const fetched = await storage.get(record.reportPointer);
  if (!hashesEqual(fetched.hash, record.reportHash)) {
    throw new Error(`report hash mismatch for ${verifier}`);
  }
  const report = parseArtifact("verifier-report", JSON.parse(fetched.bytes.toString("utf8")));
  detail(report.verifier.verifierId, `${record.reportPointer}  ${report.verifier.modelId}  [hash OK]`);
  reports.push(report);
  reportHashes.push(record.reportHash);
}

const result = evaluateConsensus({
  taskId,
  manifestHash: manifestPut.hash,
  ruleId: RULE_ID,
  producer: config.api.producerId,
  reports,
  manifestClaims: manifest.claims.map((c) => ({ claimId: c.claimId, claimText: c.claimText })),
  reportHashes,
  evaluatedAt: new Date().toISOString(),
});
for (const claim of result.claims) {
  detail(claim.claimId, `${claim.agreed ? "AGREED" : "SPLIT "}  ${claim.majorityVerdict}`);
}
detail("outcome", `${result.outcome}  ${result.agreementBps} bps`);

const resultPut = await storage.put("consensus-result", result);
detail("consensus", resultPut.pointer);

/* 6 — settle */

step(6, "keeper finalizes; every amount is derived by the contract");

if (!(await keeper.hasRole(ROLE.KEEPER, keeper.account))) {
  console.error(`${keeper.account} does not hold KEEPER_ROLE. Run \`npm run approve-verifiers\`.`);
  process.exit(1);
}

const consensus = result.outcome === "CONSENSUS";
const outcomeCode = consensus ? Outcome.Consensus : result.outcome === "CONFLICT" ? Outcome.Conflict : Outcome.NoQuorum;
// Conflict and NoQuorum take no beneficiaries: the contract applies its own
// conflict rate to everyone who revealed.
const beneficiaries = consensus ? result.rewardedVerifiers : [];
const rewardBps = consensus ? 10_000 : 0;

const finalizeReceipt = await keeper.send("finalizeConsensus", [
  taskId,
  resultPut.hash,
  outcomeCode,
  beneficiaries,
  rewardBps,
]);
detail("tx", txUrl(config.chain.chainId, finalizeReceipt.txHash) ?? finalizeReceipt.txHash);

const settled = await creator.getTask(taskId);
detail("status", statusName(settled.status));
detail("outcome", outcomeName(settled.outcome));

for (const verifier of verifiers) {
  const allocation = await creator.allocationOf(taskId, verifier);
  detail(verifier, `allocated ${formatEther(allocation)} 0G`);
}

/* 7 — the dispute window has to close before anyone is paid */

step(7, "claim after the dispute window");
const now = Math.floor(Date.now() / 1000);
const disputeEnds = settled.consensusAt + settled.disputeWindow;
if (now < disputeEnds) {
  detail("dispute window", `closes in ${disputeEnds - now}s — claiming would revert, as designed`);
  detail("next", `node scripts/checks/full-cycle.mjs --claim ${taskId}`);
} else {
  for (const [index, verifier] of verifiers.entries()) {
    const worker = workers[index];
    const { claimed, withdrawnWei } = await worker.collect([taskId]);
    detail(verifier, `claimed ${claimed.length}, withdrew ${formatEther(withdrawnWei)} 0G`);
  }
}

console.log(`\nExplorer: ${txUrl(config.chain.chainId, createReceipt.txHash)}`);
console.log(`Task:     ${taskId}`);
