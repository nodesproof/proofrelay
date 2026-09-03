/**
 * `/health`, `/health/live` and `/metrics`.
 *
 * `/health` is a readiness probe and answers 503 the moment any dependency is
 * down, because a pod that cannot reach 0G Storage should stop receiving
 * traffic rather than serve half a product. `/health/live` touches nothing:
 * a liveness probe that fails because Postgres is slow restarts a process that
 * was never broken, and restarting it does not bring Postgres back.
 *
 * Every probe is bounded. A dependency that hangs is worse than one that
 * refuses, and an unbounded probe turns a slow gateway into a health endpoint
 * that never answers — which is indistinguishable, to a load balancer, from the
 * API itself being dead.
 */
import type { FastifyInstance } from "fastify";
import { networkInfo } from "@proofrelay/chain-client";
import {
  HealthResponse,
  type DependencyHealth,
  type HealthResponse as HealthResponseType,
} from "@proofrelay/schemas";
import type { RouteContext } from "../app.js";
import { databaseHealth } from "../db.js";
import { metrics } from "../observability.js";
import { countsByStatus } from "../orchestrator/queue.js";

const PROBE_TIMEOUT_MS = 4_000;

const STOPPED: HealthResponseType["indexer"] = {
  running: false,
  lastError: null,
  processedEvents: 0,
  lastBlock: null,
  headBlock: null,
  lagBlocks: null,
};

async function probe(fn: () => Promise<DependencyHealth>): Promise<DependencyHealth> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<DependencyHealth>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probe exceeded ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS,
      );
    });
    return await Promise.race([fn(), timeout]);
  } catch (error) {
    return {
      ok: false,
      detail: String((error as Error)?.message ?? error).slice(0, 200),
      latencyMs: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const network = networkInfo(ctx.config.chain.chainId);

  app.get("/health/live", async () => ({
    ok: true,
    version: ctx.config.version,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/health", async (_request, reply) => {
    // `paused` is read inside the chain probe rather than beside it: both are
    // eth_calls against the same RPC, and a second unguarded call would be the
    // one that hangs after the guarded one timed out.
    let paused = false;

    const [database, storage, compute, chain] = await Promise.all([
      probe(async () => {
        const result = await databaseHealth(ctx.pool);
        return { ok: result.ok, detail: result.detail, latencyMs: result.latencyMs };
      }),
      probe(() => ctx.storage.health()),
      probe(() => ctx.compute.health()),
      probe(async () => {
        const started = Date.now();
        const head = await ctx.chain.blockNumber();
        paused = await ctx.chain.isPaused();
        return {
          ok: true,
          detail: `head=${head}${paused ? " paused=true" : ""}`,
          latencyMs: Date.now() - started,
        };
      }),
    ]);

    const indexer = ctx.indexer?.status() ?? STOPPED;
    if (indexer.lagBlocks !== null) metrics.chainSyncLag.set(indexer.lagBlocks);

    const queue = await (ctx.orchestrator
      ? ctx.orchestrator.health()
      : countsByStatus(ctx.pool)
    ).catch(() => ({}) as Record<string, number>);

    const dependencies = { database, storage, compute, chain };
    const ok = Object.values(dependencies).every((entry) => entry.ok);

    const body: HealthResponseType = {
      ok,
      version: ctx.config.version,
      chainId: ctx.config.chain.chainId,
      contract: ctx.config.chain.contract,
      network: ctx.config.chain.network,
      explorer: network.explorer,
      storageExplorer: network.storageExplorer,
      drivers: { storage: ctx.storage.driver, compute: ctx.compute.driver },
      dependencies,
      indexer,
      queue,
      paused,
    };

    // Parsed on the way out rather than trusted: `/health` is the one endpoint
    // an operator reads when everything else is on fire, so a drift between the
    // DTO and what it sends must fail here rather than in the UI.
    return reply.code(ok ? 200 : 503).send(HealthResponse.parse(body));
  });

  app.get("/metrics", async (_request, reply) =>
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metrics.render()),
  );
}
