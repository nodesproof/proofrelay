import {
  assertContractConfigured,
  describeConfig,
  env,
  envInt,
  loadConfig,
} from "@proofrelay/config";
import { ChainClient, ROLE } from "@proofrelay/chain-client";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { createComputeAdapter } from "@proofrelay/compute-adapter";
import { Adjudicator } from "./adjudicator.js";

// Set before the first read of the environment — `loadEnv()` is lazy, so this
// is the last moment it can be declared. It makes loadEnv pick up
// `.env.adjudicator`: this process's own key, compute deposit and thresholds.
// Placed here rather than above the imports because ESM hoists those.
process.env.PROOFRELAY_ROLE ??= "adjudicator";

const config = loadConfig();
assertContractConfigured(config);

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = { ts: new Date().toISOString(), level, message, verifierId: "adjudicator", ...fields };
  (level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(line)}\n`);
}

const privateKey = config.orchestrator.adjudicatorPrivateKey;
if (!privateKey) {
  log("error", "ADJUDICATOR_PRIVATE_KEY is not set; the adjudicator cannot resolve disputes");
  process.exit(1);
}

const chain = new ChainClient({
  chainId: config.chain.chainId,
  rpcUrl: config.chain.rpcUrl,
  contract: config.chain.contract,
  privateKey,
  confirmations: 1,
});

// A third configuration. Be precise about what that buys, because the previous
// comment claimed more than the code delivers: with COMPUTE_DRIVER=local the
// only knob that can move a verdict is the support threshold — `evidenceDepth`
// changes how many spans are cited, never the verdict — so the default of 0.5
// made this pass verdict-identical to a verifier running verifier-b's profile.
// The threshold below is deliberately distinct from both verifier profiles
// (0.55 and 0.50). Real independence needs a different model, which is what
// COMPUTE_DRIVER=zerog-router buys and COMPUTE_DRIVER=local cannot.
const adjudicator = new Adjudicator({
  chain,
  storage: createStorageAdapter(config.storage),
  compute: createComputeAdapter(config.compute, {
    evidenceDepth: envInt("ADJUDICATOR_EVIDENCE_DEPTH", 4),
    supportThreshold: Number(env("ADJUDICATOR_SUPPORT_THRESHOLD") ?? 0.6),
  }),
  evidenceDepth: envInt("ADJUDICATOR_EVIDENCE_DEPTH", 4),
  supportThreshold: Number(env("ADJUDICATOR_SUPPORT_THRESHOLD") ?? 0.6),
  pollMs: envInt("ADJUDICATOR_POLL_MS", 5_000),
  // The dispute lookback is a duration converted into blocks, so it needs the
  // chain's real cadence. Left unset it fell back to Galileo's 2 s, and on
  // mainnet — which lands a block about every 1 s — that covered barely five
  // days of a seven-day adjudication window: a dispute opened early simply
  // dropped out of view and expired unadjudicated.
  blockSeconds: config.chain.blockSeconds,
  log,
});

const account = chain.account!;
if (!(await chain.hasRole(ROLE.ADJUDICATOR, account))) {
  log("warn", "this key does not hold ADJUDICATOR_ROLE; resolveDispute will revert until an admin grants it", {
    address: account,
    role: ROLE.ADJUDICATOR,
  });
}

log("info", "starting adjudicator", { address: account, config: describeConfig(config) });

const shutdown = () => {
  log("info", "stopping adjudicator");
  adjudicator.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await adjudicator.start();
