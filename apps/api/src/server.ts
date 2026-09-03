/**
 * The API process.
 *
 * Everything here is the part `buildApp` cannot be handed: real sockets, real
 * background loops, and the boot-time assertions that must fail loudly.
 *
 * A misconfigured chain is checked *before* the listener opens. An API that
 * serves the wrong contract looks perfectly healthy — it answers, it indexes,
 * it renders tasks — and the only symptom is that every value on the screen
 * belongs to a different deployment. `describeConfig` prints where each value
 * was resolved from for the same reason: the runbook's first question when
 * something is on the wrong chain is "which file did that come from".
 */
import { ChainClient } from "@proofrelay/chain-client";
import {
  assertContractConfigured,
  assertIndexerStartBlock,
  describeConfig,
  loadConfig,
} from "@proofrelay/config";
import { createStorageAdapter } from "@proofrelay/storage-adapter";
import { createComputeAdapter } from "@proofrelay/compute-adapter";
import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { Logger } from "./observability.js";
import { Indexer } from "./indexer/indexer.js";
import { ArtifactSync } from "./indexer/artifact-sync.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { Keeper } from "./orchestrator/keeper.js";
import { purgeExpiredAuth } from "./auth/siwe.js";
import { purgeIdempotencyKeys } from "./middleware/idempotency.js";

const HOUSEKEEPING_MS = 15 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.api.logLevel, { component: "api" });

  process.stdout.write(`${describeConfig(config)}\n`);
  assertContractConfigured(config);
  assertIndexerStartBlock(config);

  const pool = createPool(config);
  const chain = new ChainClient({
    chainId: config.chain.chainId,
    rpcUrl: config.chain.rpcUrl,
    contract: config.chain.contract,
    confirmations: config.chain.confirmations,
  });
  const storage = createStorageAdapter(config.storage);
  // The API never scores a claim; it only reports which driver a verifier would
  // use and whether that driver answers. The verifier profiles carry the depth
  // and threshold that actually matter.
  const compute = createComputeAdapter(config.compute);

  const indexer = new Indexer({ config, pool, chain, logger });
  const artifactSync = new ArtifactSync({ pool, storage, logger });
  const keeper = new Keeper({ pool, config, storage, logger });
  const orchestrator = new Orchestrator({
    pool,
    config,
    storage,
    logger,
    handlers: { FINALIZATION: keeper.finalizationHandler() },
  });

  const app = await buildApp({
    config,
    pool,
    chain,
    storage,
    compute,
    logger,
    indexer,
    orchestrator,
  });

  if (config.indexer.enabled) indexer.start();
  else logger.warn("indexer disabled by INDEXER_ENABLED=false", { errorCode: "NOT_CONFIGURED" });

  artifactSync.start();

  if (config.orchestrator.enabled) {
    orchestrator.start();
    keeper.start();
  } else {
    logger.warn("orchestrator disabled by ORCHESTRATOR_ENABLED=false", {
      errorCode: "NOT_CONFIGURED",
    });
  }

  // Spent nonces and completed idempotency keys are retained deliberately (a
  // replay must be answered "already used", not "never issued"), so something
  // has to age them out or the two tables grow without bound.
  const housekeeping = setInterval(() => {
    void Promise.all([purgeExpiredAuth(pool), purgeIdempotencyKeys(pool)]).catch((error) => {
      logger.warn("housekeeping failed", {
        errorCode: "INTERNAL",
        detail: String((error as Error)?.message ?? error).slice(0, 200),
      });
    });
  }, HOUSEKEEPING_MS);
  housekeeping.unref?.();

  await app.listen({ host: config.api.host, port: config.api.port });
  logger.info("api listening", {
    host: config.api.host,
    port: config.api.port,
    chainId: config.chain.chainId,
    contract: config.chain.contract,
    storage: storage.driver,
    compute: compute.driver,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    clearInterval(housekeeping);
    // The listener closes first so nothing new arrives, then the loops are
    // allowed to finish the transaction each is holding. Killing an indexer
    // pass mid-batch is safe but costs a rescan on the next boot.
    await app.close().catch(() => undefined);
    await Promise.all([
      indexer.stop(),
      artifactSync.stop(),
      orchestrator.stop(),
      keeper.stop(),
    ]).catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  // Boot failures are the ones an operator has to read, so they go out plainly
  // rather than as a JSON log line nobody has a parser for yet.
  process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
  process.exit(1);
});
