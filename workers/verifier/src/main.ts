import { join } from "node:path";
import {
  assertContractConfigured,
  describeConfig,
  loadConfig,
  verifierProfile,
} from "@proofrelay/config";
import { ChainClient } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { createComputeAdapter } from "@proofrelay/compute-adapter";
import { CommitJournal } from "./journal.js";
import { DEFAULT_MIN_COLLECT_WEI, VerifierWorker } from "./worker.js";

const config = loadConfig();
assertContractConfigured(config);
// Not assertIndexerStartBlock: that guards the API's indexer against scanning
// from genesis. A verifier never indexes — it scans back from the head — so
// demanding the deploy block here only made a standalone operator look up a
// number nothing in this process reads.

const profile = verifierProfile();

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = { ts: new Date().toISOString(), level, message, verifierId: profile.id, ...fields };
  (level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(line)}\n`);
}

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey: profile.privateKey,
  confirmations: 1,
});

// A verifier is already an onchain identity, so it pays for its own uploads:
// the report body it reveals goes to 0G Storage on its own key unless the
// operator points STORAGE_PRIVATE_KEY at a dedicated one. Before this, every
// verifier signed with the deployment's shared storage key — which meant a
// machine running only a verifier had to hold a key that was not its own.
const storageKey = config.storage.privateKey ?? profile.privateKey;
log("info", "storage uploads signed by", { key: config.storage.privateKey ? "STORAGE_PRIVATE_KEY" : "the verifier's own key" });

const worker = new VerifierWorker({
  chain,
  storage: createStorageAdapter({ ...config.storage, privateKey: storageKey }),
  compute: createComputeAdapter(config.compute, {
    evidenceDepth: profile.evidenceDepth,
    supportThreshold: profile.supportThreshold,
  }),
  journal: new CommitJournal(join(config.root, ".proofrelay", "workers"), profile.id),
  verifierId: profile.id,
  evidenceDepth: profile.evidenceDepth,
  supportThreshold: profile.supportThreshold,
  pollMs: profile.pollMs,
  // Rewards are pull-based, so collecting costs gas. Hold until the unclaimed
  // total covers it; 0 collects eagerly.
  minCollectWei: BigInt(process.env.VERIFIER_MIN_COLLECT_WEI ?? DEFAULT_MIN_COLLECT_WEI),
  log,
});

log("info", "starting verifier", {
  address: chain.account,
  config: describeConfig(config),
  evidenceDepth: profile.evidenceDepth,
  supportThreshold: profile.supportThreshold,
});

const shutdown = () => {
  log("info", "stopping verifier");
  worker.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await worker.start();
