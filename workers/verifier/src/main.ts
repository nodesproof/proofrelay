import { join } from "node:path";
import {
  assertContractConfigured,
  assertIndexerStartBlock,
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
assertIndexerStartBlock(config);

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

const worker = new VerifierWorker({
  chain,
  storage: createStorageAdapter(config.storage),
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
