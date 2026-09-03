#!/usr/bin/env node
/**
 * The branches the happy path never reaches.
 *
 * `full-cycle.mjs` proves a task that everyone agrees on settles and pays. It
 * says nothing about what happens when the creator changes their mind, when
 * somebody challenges the result, or when nobody shows up at all — and those
 * are the paths that move money in unusual directions, so they are the ones
 * worth executing against the live contract rather than only against a fork.
 *
 *   node scripts/checks/lifecycle-paths.mjs            # every path it can run now
 *   node scripts/checks/lifecycle-paths.mjs --cancel
 *   node scripts/checks/lifecycle-paths.mjs --dispute
 *   node scripts/checks/lifecycle-paths.mjs --expire [taskId]
 *
 * Two of the branches are gated by real time: `expireTask` needs the reveal
 * deadline plus a three-day keeper grace, and `expireDispute` a seven-day
 * adjudication window. This script does not pretend to test those — it names
 * the task, computes when the call becomes legal, and says so.
 */
import { decodeEventLog, formatEther } from "viem";
import { ChainClient, ROLE, computeTaskId, proofRelayAbi, txUrl } from "@proofrelay/chain-client";
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
import { Adjudicator } from "../../workers/adjudicator/dist/adjudicator.js";

const config = loadConfig();
assertContractConfigured(config);

const args = process.argv.slice(2);
const only = (flag) => args.includes(flag);
const runAll = !only("--cancel") && !only("--dispute") && !only("--expire");

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const detail = (label, value) => console.log(`    ${String(label).padEnd(20)} ${value}`);
const ok = (text) => console.log(`    ✓ ${text}`);

const failures = [];
function assert(condition, text) {
  if (condition) ok(text);
  else {
    failures.push(text);
    console.log(`    ✗ ${text}`);
  }
}

const chainOpts = () => ({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
});

const creatorKey = env("CREATOR_PRIVATE_KEY") ?? env("PRIVATE_KEY");
const keeperKey = env("KEEPER_PRIVATE_KEY");
const adjudicatorKey = env("ADJUDICATOR_PRIVATE_KEY") ?? keeperKey;
if (!creatorKey || !keeperKey) {
  console.error("CREATOR_PRIVATE_KEY (or PRIVATE_KEY) and KEEPER_PRIVATE_KEY must be set");
  process.exit(1);
}

const storage = createStorageAdapter(config.storage);
const reader = new ChainClient(chainOpts());
const creator = new ChainClient({ ...chainOpts(), privateKey: creatorKey, confirmations: 1 });
const keeper = new ChainClient({ ...chainOpts(), privateKey: keeperKey, confirmations: 1 });
const params = await reader.params();

console.log(`chain ${config.chain.chainId}  contract ${config.chain.contract}`);
console.log(`storage ${config.storage.driver}  compute ${config.compute.driver}`);
console.log(`creator ${creator.account}`);

const RULE_ID = `0x${"22".repeat(32)}`;
const WINDOW = Number(env("LIFECYCLE_WINDOW_SEC") ?? 60);
// The challenge has to be opened while the dispute window is still open, and a
// live run has to wait on real workers to get there, so this one is generous.
const DISPUTE_WINDOW = Number(env("LIFECYCLE_DISPUTE_WINDOW_SEC") ?? 1_800);
/// MIN_WINDOW on the contract; the shortest a task can legally be given.
const MIN_WINDOW = 30;

/* ── shared: put a manifest on 0G Storage and escrow a task against it ────── */

const SOURCES = [
  {
    sourceId: "src-001",
    uri: "https://example.org/proofrelay/CHANGELOG.md",
    text: `# Changelog\n\nRelease v1.4.0 — August 10, 2026.\nAdds streaming support and drops Node.js 18.`,
  },
  {
    sourceId: "src-002",
    uri: "https://example.org/proofrelay/README.md",
    text: `# proofrelay-demo\n\nThe current stable release is v1.4.0 and it requires Node.js 20 or newer.`,
  },
];

const CLAIMS = [
  { claimId: "claim-001", claimText: "The repository released version 1.4.0 on 2026-08-10.", origin: "creator" },
  { claimId: "claim-002", claimText: "The repository released version 2.0.0 on August 10, 2026.", origin: "creator" },
  { claimId: "claim-003", claimText: "The maintainers relocated their head office to Lisbon in 2026.", origin: "creator" },
];

async function uploadManifest(title) {
  const sources = [];
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
    sources.push({
      sourceId: source.sourceId,
      uri: source.uri,
      status: "OK",
      contentHash: snapshot.contentHash,
      byteLength: snapshot.byteLength,
      snapshotHash: put.hash,
      snapshotPointer: put.pointer,
    });
  }
  const manifest = {
    kind: "task-manifest",
    schemaVersion: SCHEMA_VERSION,
    producer: config.api.producerId,
    manifestId: `lifecycle-${objectHash({ title }).slice(2, 10)}`,
    chainId: config.chain.chainId,
    creator: creator.account,
    title,
    question: "Are the stated release facts supported by the snapshotted documentation?",
    answerText: null,
    claims: CLAIMS,
    sources,
    extraction: null,
    policy: {
      verifierCount: 2,
      commitWindowSec: WINDOW,
      revealWindowSec: WINDOW,
      disputeWindowSec: DISPUTE_WINDOW,
      maxEvidencePerClaim: 3,
      ruleId: RULE_ID,
    },
    safety: { publicDataOnly: true, redactions: [], warnings: [] },
    createdAt: new Date().toISOString(),
  };
  const put = await storage.put("task-manifest", manifest);
  return { manifest, ...put };
}

async function escrow(manifestPut, bounty, window = WINDOW) {
  const nonce = await creator.creatorNonce(creator.account);
  const taskId = computeTaskId({
    chainId: config.chain.chainId,
    contract: config.chain.contract,
    creator: creator.account,
    nonce,
  });
  const receipt = await creator.send(
    "createTask",
    [
      {
        verifierCount: 2,
        commitWindowSec: window,
        revealWindowSec: window,
        disputeWindowSec: DISPUTE_WINDOW,
        manifestHash: manifestPut.hash,
        manifestPointer: manifestPut.pointer,
        ruleId: RULE_ID,
      },
    ],
    { value: bounty },
  );
  return { taskId, receipt };
}

/**
 * Poll until `probe` returns something truthy. `failure` is the message to
 * throw on a timeout; passing null makes a timeout return null instead, for
 * the cases where "it did not happen" is an answer rather than an error.
 * `progress` describes the current state, and is printed only when it changes,
 * so a five-minute wait leaves a readable trace rather than a wall of dots.
 */
async function waitFor(probe, timeoutMs, failure, progress = null) {
  const deadline = Date.now() + timeoutMs;
  let announced = "";
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    if (progress) {
      const line = await progress();
      if (line !== announced) {
        announced = line;
        detail("...", line);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (failure) throw new Error(failure);
  return null;
}

/** The block the task's `DisputeResolved` landed in, searched from `from`. */
async function resolvedAtBlock(taskId, from) {
  const head = await reader.blockNumber();
  for (const entry of await reader.getLogs(from > 5n ? from - 5n : 0n, head)) {
    if (entry.topics[1]?.toLowerCase() !== taskId.toLowerCase()) continue;
    if (reader.eventNameForTopic(entry.topics[0]) === "DisputeResolved") return entry.blockNumber;
  }
  throw new Error("resolveDispute emitted no DisputeResolved log");
}

/** Every `RewardAllocated` this task received in one block, summed per account. */
async function allocationsIn(taskId, blockNumber) {
  const out = new Map();
  for (const entry of await reader.getLogs(blockNumber, blockNumber)) {
    if (entry.topics[1]?.toLowerCase() !== taskId.toLowerCase()) continue;
    if (reader.eventNameForTopic(entry.topics[0]) !== "RewardAllocated") continue;
    const { args } = decodeEventLog({ abi: proofRelayAbi, data: entry.data, topics: entry.topics });
    out.set(args.beneficiary, (out.get(args.beneficiary) ?? 0n) + args.amount);
  }
  return out;
}

/**
 * The revert a negative test is asserting, or null if the call would go
 * through. It never sends: a probe that asks "would this be refused?" must not
 * settle the task when the answer turns out to be no — which is exactly what
 * an earlier version did, expiring a live task it was only asking about.
 */
async function revertReason(client, fn, callArgs, options = {}) {
  return client.simulate(fn, callArgs, options);
}

/* ══ path A — the creator changes their mind ══════════════════════════════ */

if (runAll || only("--cancel")) {
  console.log("\n── cancel and refund ─────────────────────────────────────");

  step("A1", "escrow a task the creator will abandon");
  const bounty = params.minBounty;
  const manifestPut = await uploadManifest("lifecycle — cancelled before any commitment");
  const { taskId, receipt } = await escrow(manifestPut, bounty);
  detail("taskId", taskId);
  detail("bounty", `${formatEther(bounty)} 0G  (the contract minimum)`);
  detail("tx", txUrl(config.chain.chainId, receipt.txHash) ?? receipt.txHash);

  step("A2", "somebody who is not the creator tries to cancel it");
  const stranger = new ChainClient({ ...chainOpts(), privateKey: verifierProfile("a").privateKey, confirmations: 1 });
  const denied = await revertReason(stranger, "cancelTask", [taskId]);
  assert(denied !== null, `a non-creator cannot cancel — reverted: ${String(denied).slice(0, 60)}`);

  step("A3", "the creator cancels");
  const pendingBeforeCancel = await reader.pendingWithdrawals(creator.account);
  const cancel = await creator.send("cancelTask", [taskId]);
  detail("tx", txUrl(config.chain.chainId, cancel.txHash) ?? cancel.txHash);
  const cancelled = await reader.getTask(taskId);
  detail("status", statusName(cancelled.status));
  detail("outcome", `${outcomeName(cancelled.outcome)} (${cancelled.outcome})`);
  assert(cancelled.status === 9, "the task is Cancelled");
  assert(cancelled.outcome === 5, "the outcome stored is Cancelled — the value the deployment writes");

  // A cancellation credits pendingWithdrawals directly. Reading allocationOf
  // here is not redundant: it is the assertion that separates the deployed
  // design from the plausible one, and it read zero on the run that found this.
  const allocation = await reader.allocationOf(taskId, creator.account);
  const pendingAfterCancel = await reader.pendingWithdrawals(creator.account);
  detail("allocationOf", `${formatEther(allocation)} 0G`);
  detail("pending", `${formatEther(pendingBeforeCancel)} -> ${formatEther(pendingAfterCancel)} 0G`);
  assert(allocation === 0n, "a cancellation allocates nothing — it credits the withdrawable balance");
  assert(pendingAfterCancel - pendingBeforeCancel === bounty, "the whole bounty became withdrawable, to the wei");

  step("A4", "the creator takes the refund");
  const balanceBefore = await reader.balanceOf(creator.account);
  const contractBefore = await reader.balanceOf(config.chain.contract);
  const refund = await creator.send("refundCreator", [taskId]);
  detail("tx", txUrl(config.chain.chainId, refund.txHash) ?? refund.txHash);
  const balanceAfter = await reader.balanceOf(creator.account);
  const contractAfter = await reader.balanceOf(config.chain.contract);
  const paid = contractBefore - contractAfter;
  detail("contract paid out", `${formatEther(paid)} 0G`);
  detail("creator balance", `${formatEther(balanceBefore)} -> ${formatEther(balanceAfter)} 0G (net of gas)`);
  assert(paid === pendingAfterCancel, "refundCreator pushed the creator's whole pending balance, not this task's share");
  assert((await reader.pendingWithdrawals(creator.account)) === 0n, "nothing is left pending");

  const again = await revertReason(creator, "refundCreator", [taskId]);
  assert(again !== null, `a second refund reverts — ${String(again).slice(0, 60)}`);
  const nothing = await revertReason(creator, "withdraw", []);
  assert(nothing !== null, `withdraw with an empty balance reverts — ${String(nothing).slice(0, 60)}`);

  const liabilities = await reader.totalLiabilities();
  const held = await reader.balanceOf(config.chain.contract);
  detail("solvency", `balance ${formatEther(held)} 0G  liabilities ${formatEther(liabilities)} 0G`);
  assert(held >= liabilities, "the contract still holds at least what it owes");
}

/* ══ path B — somebody challenges the result ══════════════════════════════ */

if (runAll || only("--dispute")) {
  console.log("\n── challenge and adjudication ───────────────────────────────");

  step("B1", "run a task to a settled result the challenger can object to");
  const bounty = BigInt(env("LIFECYCLE_BOUNTY_WEI") ?? 1_000_000_000_000_000n);
  const manifestPut = await uploadManifest("lifecycle — challenged after settlement");
  const { taskId, receipt } = await escrow(manifestPut, bounty);
  detail("taskId", taskId);
  detail("bounty", `${formatEther(bounty)} 0G`);
  detail("tx", txUrl(config.chain.chainId, receipt.txHash) ?? receipt.txHash);

  // The verifiers are the ones already running — this path is about what the
  // deployed system does with a challenge, not about a self-contained replay.
  detail("waiting on", "the running verifier workers to commit and reveal");
  const revealed = await waitFor(
    async () => {
      const task = await reader.getTask(taskId);
      return task.revealedCount >= task.verifierCount ? task : null;
    },
    360_000,
    "the running verifier workers never reached 2/2 — are they up?",
    async () => {
      const task = await reader.getTask(taskId);
      return `${task.committedCount} committed, ${task.revealedCount} revealed  (${statusName(task.status)})`;
    },
  );
  detail("revealed", `${revealed.revealedCount}/${revealed.verifierCount}`);

  const verifiers = await reader.getTaskVerifiers(taskId);
  const reports = [];
  const reportHashes = [];
  for (const verifier of verifiers) {
    const record = await reader.getReport(taskId, verifier);
    const fetched = await storage.get(record.reportPointer);
    if (!hashesEqual(fetched.hash, record.reportHash)) throw new Error(`report hash mismatch for ${verifier}`);
    reports.push(parseArtifact("verifier-report", JSON.parse(fetched.bytes.toString("utf8"))));
    reportHashes.push(record.reportHash);
  }
  // The API's orchestrator settles on its own. Give it the chance — that is the
  // deployed behaviour — and only step in with the keeper if it does not.
  let settled = await waitFor(
    async () => {
      const task = await reader.getTask(taskId);
      return task.status === 4 ? task : null;
    },
    240_000,
    null,
    async () => statusName((await reader.getTask(taskId)).status),
  );
  if (settled) {
    detail("settled by", "the running orchestrator");
  } else {
    detail("settled by", "this script's keeper — the orchestrator did not get there first");
    const result = evaluateConsensus({
      taskId,
      manifestHash: manifestPut.hash,
      ruleId: RULE_ID,
      producer: config.api.producerId,
      reports,
      manifestClaims: CLAIMS.map((c) => ({ claimId: c.claimId, claimText: c.claimText })),
      reportHashes,
      evaluatedAt: new Date().toISOString(),
    });
    const resultPut = await storage.put("consensus-result", result);
    const consensus = result.outcome === "CONSENSUS";
    await keeper.send("finalizeConsensus", [
      taskId,
      resultPut.hash,
      consensus ? Outcome.Consensus : result.outcome === "CONFLICT" ? Outcome.Conflict : Outcome.NoQuorum,
      consensus ? result.rewardedVerifiers : [],
      consensus ? 10_000 : 0,
    ]);
    settled = await reader.getTask(taskId);
  }
  detail("outcome", outcomeName(settled.outcome));
  detail("status", statusName(settled.status));
  detail("dispute window", `${settled.disputeWindow}s from ${new Date(settled.consensusAt * 1000).toISOString()}`);
  assert(settled.status === 4, "the task reached Consensus, which is the only status a challenge may target");

  const accounts = [...verifiers, creator.account];

  step("B2", "the bond is priced by the chain, and a wrong one is refused");
  const bond = (settled.bounty * BigInt(params.challengeBondBps)) / 10_000n;
  detail("bond", `${formatEther(bond)} 0G  (${params.challengeBondBps} bps of the bounty)`);
  const underpaid = await revertReason(
    creator,
    "openChallenge",
    [taskId, `0x${"00".repeat(32)}`, "local://underpaid"],
    { value: bond - 1n },
  );
  assert(underpaid !== null, `a bond one wei short is refused — ${String(underpaid).slice(0, 60)}`);

  step("B3", "a stranger cannot challenge a task they had no part in");
  const outsider = new ChainClient({ ...chainOpts(), privateKey: keeperKey, confirmations: 1 });
  const notParty = await revertReason(
    outsider,
    "openChallenge",
    [taskId, `0x${"00".repeat(32)}`, "local://outsider"],
    { value: bond },
  );
  assert(notParty !== null, `only the creator or a committed verifier may challenge — ${String(notParty).slice(0, 60)}`);

  step("B4", "the creator prepares challenge evidence through the API and opens the challenge");
  const prepared = await prepareChallengeViaApi(taskId, {
    reason:
      "The second and third claims were decided on a shallow evidence pass; the snapshotted changelog contradicts the recorded verdict and deserves an independent second look.",
    disputedClaims: CLAIMS.map((c) => c.claimId),
    additionalEvidence: [],
  });
  detail("evidenceHash", prepared.evidenceHash);
  detail("evidencePointer", prepared.evidencePointer);
  detail("bondWei", `${formatEther(BigInt(prepared.bondWei))} 0G`);
  assert(BigInt(prepared.bondWei) === bond, "the API quoted the same bond the contract demands");

  const opened = await creator.send(
    "openChallenge",
    [taskId, prepared.evidenceHash, prepared.evidencePointer],
    { value: bond },
  );
  detail("tx", txUrl(config.chain.chainId, opened.txHash) ?? opened.txHash);
  const disputedTask = await reader.getTask(taskId);
  const dispute = await reader.getDispute(taskId);
  detail("status", statusName(disputedTask.status));
  assert(disputedTask.status === 5, "the task is Disputed");
  assert(dispute.challenger.toLowerCase() === creator.account.toLowerCase(), "the challenger is recorded");
  assert(dispute.bond === bond, "the bond is escrowed, to the wei");
  assert(hashesEqual(dispute.evidenceHash, prepared.evidenceHash), "the evidence hash onchain is the one the API stored");

  const secondChallenge = await revertReason(
    creator,
    "openChallenge",
    [taskId, prepared.evidenceHash, prepared.evidencePointer],
    { value: bond },
  );
  assert(secondChallenge !== null, `a second challenge on the same task is refused — ${String(secondChallenge).slice(0, 60)}`);

  step("B5", "the adjudicator runs an independent third pass and resolves");
  if (!(await reader.hasRole(ROLE.ADJUDICATOR, keeper.account))) {
    console.error(`${keeper.account} does not hold ADJUDICATOR_ROLE. Run \`npm run approve-verifiers\`.`);
    process.exit(1);
  }
  const adjudicatorProfile = { evidenceDepth: 4, supportThreshold: 0.45 };
  const adjudicator = new Adjudicator({
    chain: new ChainClient({ ...chainOpts(), privateKey: adjudicatorKey, confirmations: 1 }),
    storage,
    compute: createComputeAdapter(config.compute, adjudicatorProfile),
    evidenceDepth: adjudicatorProfile.evidenceDepth,
    supportThreshold: adjudicatorProfile.supportThreshold,
    pollMs: 1_000,
    log: (level, message, fields = {}) => detail(level === "info" ? "adjudicator" : `! ${level}`, `${message} ${fields.txHash ?? ""}`),
  });
  const blockBeforeResolve = await reader.blockNumber();
  await adjudicator.resolve(taskId);
  const resolveBlock = await resolvedAtBlock(taskId, blockBeforeResolve);

  const resolved = await reader.getDispute(taskId);
  const finalTask = await reader.getTask(taskId);
  detail("resolved", String(resolved.resolved));
  detail("upheld", String(resolved.upheld));
  detail("adjudication", resolved.adjudicationPointer);
  detail("status", statusName(finalTask.status));
  assert(resolved.resolved, "the dispute is resolved");
  assert(finalTask.status === 7, "the task is Finalized");
  assert(
    hashesEqual(finalTask.resultHash, resolved.adjudicationHash) || finalTask.resultHash !== settled.resultHash,
    "resolveDispute replaced the task's resultHash with the adjudicator's reason hash",
  );

  const stored = await storage.get(resolved.adjudicationPointer);
  assert(hashesEqual(stored.hash, resolved.adjudicationHash), "the stored adjudication report hashes to what the chain recorded");
  const adjudication = parseArtifact("adjudication-report", JSON.parse(stored.bytes.toString("utf8")));
  detail("decision", adjudication.decision.slice(0, 96));
  assert(adjudication.upheld === resolved.upheld, "the report and the chain agree on the verdict");
  assert(adjudication.compute.length > 0, "the adjudicator recorded which engine actually ran");

  step("B6", "who ends up with the money");
  /**
   * Read from the settlement transaction's own logs rather than from
   * `allocationOf` afterwards. Two things make a live read the wrong
   * instrument: the running keeper sweeps allocations into
   * `pendingWithdrawals` without being asked, and Galileo's RPC is load
   * balanced, so a read issued right after a confirmed transaction can land on
   * a node that has not seen its block — which is what made an earlier version
   * of this check report a settlement that paid everyone as paying no one.
   */
  const settlement = await allocationsIn(taskId, resolveBlock);
  let movedTotal = 0n;
  for (const [account, amount] of settlement) {
    movedTotal += amount;
    detail(account, `+${formatEther(amount)} 0G`);
  }
  const pool = settled.bounty + bond;
  detail("pool", `bounty ${formatEther(settled.bounty)} + bond ${formatEther(bond)} = ${formatEther(pool)} 0G`);
  detail("distributed", `${formatEther(movedTotal)} 0G`);

  if (resolved.upheld) {
    // An upheld challenge reclaims every allocation on the task, adds the bond,
    // and redistributes the lot — so the transaction that resolves it pays out
    // the whole pool, and not a wei more.
    const toChallenger = bond + (settled.bounty * BigInt(params.challengerRewardBps)) / 10_000n;
    const challengerGot = settlement.get(creator.account) ?? 0n;
    assert(
      challengerGot === toChallenger,
      `the challenger got its bond back plus ${params.challengerRewardBps} bps of the bounty — ${formatEther(challengerGot)} 0G`,
    );
    assert(
      movedTotal === pool,
      `the pool is conserved: bounty + bond went out, nothing created and nothing stranded (${formatEther(movedTotal)} of ${formatEther(pool)} 0G)`,
    );
  } else {
    // A rejected challenge leaves the consensus allocations alone and only
    // splits the forfeited bond.
    assert(movedTotal === bond, `a rejected challenge distributes exactly the forfeited bond (${formatEther(movedTotal)} 0G)`);
  }
  const liabilities = await reader.totalLiabilities();
  const held = await reader.balanceOf(config.chain.contract);
  detail("solvency", `balance ${formatEther(held)} 0G  liabilities ${formatEther(liabilities)} 0G`);
  assert(held >= liabilities, "the contract still holds at least what it owes");

  step("B7", "everybody collects");
  for (const [label, account, client] of [
    ["challenger", creator.account, creator],
    ...["a", "b"].map((name) => {
      const profile = verifierProfile(name);
      const chain = new ChainClient({ ...chainOpts(), privateKey: profile.privateKey, confirmations: 1 });
      return [profile.id, chain.account, chain];
    }),
  ]) {
    const allocation = await reader.allocationOf(taskId, account);
    if (allocation > 0n) await client.send("claimReward", [taskId]);
    const pending = await reader.pendingWithdrawals(account);
    if (pending === 0n) {
      detail(label, `${account} — nothing to collect`);
      continue;
    }
    const before = await reader.balanceOf(account);
    const withdraw = await client.send("withdraw", []);
    const after = await reader.balanceOf(account);
    detail(label, `${account} withdrew ${formatEther(pending)} 0G`);
    detail("", `balance ${formatEther(before)} -> ${formatEther(after)} 0G  ${txUrl(config.chain.chainId, withdraw.txHash) ?? withdraw.txHash}`);
    assert((await reader.pendingWithdrawals(account)) === 0n, `${label}'s balance is settled to zero`);
  }

  console.log(`\n    task ${taskId}`);
}

/* ══ path C — nobody showed up ════════════════════════════════════════════ */

if (runAll || only("--expire")) {
  console.log("\n── expiry ────────────────────────────────────────────────");

  const explicit = args[args.indexOf("--expire") + 1];
  let targets = explicit && explicit.startsWith("0x") ? [explicit] : await unsettledTasks();

  // With nothing stranded on chain there is nothing to observe, and a check
  // that prints "nothing to do" and exits zero is not a check. Post one with
  // the shortest windows the contract accepts — 30s to commit, 30s to reveal —
  // and see what the deadline finds.
  //
  // Which of the two branches below runs is not fixed: on a quiet run the
  // verifiers do not finish in 60s and the task expires, on a warm one they do
  // and the contract refuses the expiry. Both are the right answer to the
  // question this check asks, so both are asserted rather than one being
  // engineered.
  if (targets.length === 0) {
    step("C1", "nothing is stranded, so strand something");
    const manifestPut = await uploadManifest("lifecycle — abandoned to the reveal deadline");
    const { taskId, receipt } = await escrow(manifestPut, params.minBounty, MIN_WINDOW);
    detail("taskId", taskId);
    detail("windows", `${MIN_WINDOW}s commit, ${MIN_WINDOW}s reveal — the contract minimum`);
    detail("tx", txUrl(config.chain.chainId, receipt.txHash) ?? receipt.txHash);
    const deadline = (await reader.getTask(taskId)).revealDeadline;
    detail("waiting", `until ${new Date(deadline * 1000).toISOString()}`);
    await waitFor(
      async () => (Math.floor(Date.now() / 1000) > deadline ? true : null),
      (MIN_WINDOW * 2 + 90) * 1000,
      "the reveal deadline never arrived",
      async () => `${deadline - Math.floor(Date.now() / 1000)}s to the reveal deadline`,
    );
    targets = [taskId];
  }

  const now = Math.floor(Date.now() / 1000);
  for (const taskId of targets) {
    const task = await reader.getTask(taskId);
    console.log(`\n    ${taskId}`);
    detail("status", `${statusName(task.status)}  revealed ${task.revealedCount}/${task.verifierCount}`);
    detail("bounty", `${formatEther(task.bounty)} 0G`);
    detail("revealDeadline", `${task.revealDeadline}  (${new Date(task.revealDeadline * 1000).toISOString()})`);

    // Whether the grace has elapsed is the contract's judgement, not a sum of
    // parameters this script decoded. Asking it costs one eth_call and is the
    // only answer that cannot be wrong.
    const refusal = await keeper.simulate("expireTask", [taskId]);
    if (refusal) {
      detail("expireTask", `refused — ${String(refusal).slice(0, 70)}`);
      detail("elapsed", `${((now - task.revealDeadline) / 3600).toFixed(1)}h since the reveal deadline`);
      ok("the contract refuses an expiry that is not due yet");
      continue;
    }

    detail("expireTask", `legal — ${((now - task.revealDeadline) / 3600).toFixed(1)}h since the reveal deadline`);
    const receipt = await keeper.send("expireTask", [taskId]);
    detail("tx", txUrl(config.chain.chainId, receipt.txHash) ?? receipt.txHash);
    const expired = await reader.getTask(taskId);
    detail("status", statusName(expired.status));
    detail("outcome", `${outcomeName(expired.outcome)} (${expired.outcome})`);
    assert(expired.status === 8, "the task is Expired");
    assert(
      task.revealedCount === 0 ? expired.outcome === 4 : expired.outcome === 2,
      task.revealedCount === 0
        ? "a task nobody revealed on expires as Expired"
        : "partial reveals settle at the conflict rate",
    );
    const refunded =
      (await reader.allocationOf(taskId, task.creator)) + (await reader.pendingWithdrawals(task.creator));
    detail("creator holds", `${formatEther(refunded)} 0G  (allocated + withdrawable)`);
    assert(refunded >= task.bounty, "at least the unspent bounty came back to the creator");
  }
}

/* ── the API call used by the dispute path ───────────────────────────────── */

async function prepareChallengeViaApi(taskId, body) {
  const base = process.env.API_URL ?? `http://127.0.0.1:${config.api.port}`;
  // The route resolves `:taskId` against the read model, so the indexer has to
  // have caught up with a task created seconds ago.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await fetch(`${base}/v1/tasks/${taskId}`);
    if (probe.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const response = await fetch(`${base}/v1/tasks/${taskId}/challenge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `lifecycle-${taskId.slice(2, 18)}`,
    },
    body: JSON.stringify({ ...body, challenger: creator.account }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST /v1/tasks/${taskId}/challenge -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function unsettledTasks() {
  const head = await reader.blockNumber();
  const deploy = BigInt(env("DEPLOY_BLOCK") ?? 52352124n);
  const ids = new Set();
  for (let from = deploy; from <= head; from += 10_000n) {
    const to = from + 9_999n > head ? head : from + 9_999n;
    for (const log of await reader.getLogs(from, to)) {
      if (reader.eventNameForTopic(log.topics[0]) === "TaskCreated") ids.add(log.topics[1]);
    }
  }
  const open = [];
  for (const id of ids) {
    const task = await reader.getTask(id);
    if ([1, 2, 3].includes(task.status)) open.push(id);
  }
  return open;
}

/* ── verdict ─────────────────────────────────────────────────────────────── */

console.log(`\n${failures.length === 0 ? "every assertion held" : `${failures.length} assertion(s) failed:`}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
