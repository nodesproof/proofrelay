/**
 * The Fastify instance, assembled from dependencies rather than from process
 * state, so a test can build the whole API — every route, every hook, the error
 * mapper, the rate limiter — against fakes and drive it with `.inject()`.
 * `server.ts` is then only the part that cannot be faked: reading config,
 * opening sockets and starting background loops.
 *
 * Three cross-cutting decisions live here rather than being repeated per route:
 *
 * - **Every response carries `x-request-id`.** It is the incoming header when
 *   the caller supplied one, so a request keeps its identity across the UI, the
 *   API and the job it enqueues; that is what makes a log line joinable.
 * - **The rate limit key is the wallet when there is one.** The session is
 *   resolved in an `onRequest` hook registered *before* the limiter, and only
 *   when an Authorization header is present — an unauthenticated flood
 *   therefore costs no database query and is bucketed by IP, exactly as the
 *   threat model's "Denial of service through large tasks" says.
 * - **Nothing throws past `errorHandler`.** Routes raise `ProofRelayError` and
 *   let the mapper decide the status code, so an error code exists for every
 *   failure the UI or an operator can see.
 */
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import type { Config } from "@proofrelay/config";
import type { ChainClient, VerifierOnChain } from "@proofrelay/chain-client";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { ComputeAdapter } from "@proofrelay/compute-adapter";
import { ProofRelayError } from "@proofrelay/schemas";
import type { Pool } from "./db.js";
import { Logger, metrics } from "./observability.js";
import { correlationFields, errorHandler } from "./middleware/errors.js";
import { bearerToken, resolveSession, type SessionIdentity } from "./auth/siwe.js";
import type { IndexerStatus } from "./indexer/indexer.js";
import type { QueueCounts } from "./orchestrator/queue.js";
import {
  createTaskService,
  type TaskChainReader,
  type TaskService,
} from "./services/task-service.js";
import {
  createPrepareService,
  type PrepareChainReader,
  type PrepareService,
} from "./services/prepare-service.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerVerifierRoutes } from "./routes/verifiers.js";
import { registerArtifactObjectRoute, registerArtifactRoutes } from "./routes/artifacts.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerStatsRoutes } from "./routes/stats.js";

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const isDevelopment = process.env.NODE_ENV !== "production";


/* ── dependencies ────────────────────────────────────────────────────────── */

/**
 * Every chain read the HTTP layer performs, and nothing else. Structural rather
 * than `ChainClient` for the same reason the two services declare their own
 * readers: a route suite must be able to pin a struct without a JSON-RPC
 * transport, and `ChainClientIsAppChain` below fails to compile if the real
 * client ever stops satisfying it.
 */
export interface AppChain extends TaskChainReader, PrepareChainReader {
  isPaused(): Promise<boolean>;
  blockNumber(): Promise<bigint>;
  getVerifier(verifier: Address): Promise<VerifierOnChain>;
  pendingWithdrawals(account: Address): Promise<bigint>;
}

type Assert<T extends true> = T;
export type ChainClientIsAppChain = Assert<ChainClient extends AppChain ? true : false>;

/** What `/health` needs from the indexer; the real one satisfies it. */
export interface IndexerHandle {
  status(): IndexerStatus;
}

/** What `/health` needs from the orchestrator. */
export interface QueueHandle {
  health(): Promise<QueueCounts>;
}

/** Only the two members `/health` reads, so a fake compute adapter is two fields. */
export type ComputeProbe = Pick<ComputeAdapter, "driver" | "health">;

export interface AppDeps {
  config: Config;
  pool: Pool;
  chain: AppChain;
  storage: StorageAdapter;
  compute: ComputeProbe;
  logger?: Logger | undefined;
  indexer?: IndexerHandle | null | undefined;
  orchestrator?: QueueHandle | null | undefined;
  now?: (() => Date) | undefined;
}

/** What every route file receives: the deps plus the two service facades. */
export interface RouteContext {
  config: Config;
  pool: Pool;
  chain: AppChain;
  storage: StorageAdapter;
  compute: ComputeProbe;
  logger: Logger;
  indexer: IndexerHandle | null;
  orchestrator: QueueHandle | null;
  now: () => Date;
  tasks: TaskService;
  prepare: PrepareService;
}

/**
 * A session resolved once per request. The error is kept rather than thrown,
 * because most routes do not need a wallet at all and an expired token must not
 * turn a public GET into a 401.
 */
export interface SessionState {
  identity: SessionIdentity | null;
  error: ProofRelayError | null;
}

declare module "fastify" {
  interface FastifyRequest {
    wallet: SessionState;
  }
}

const NO_SESSION: SessionState = { identity: null, error: null };

/** The address a route may act for, or the reason it may not. */
export function requireWallet(request: FastifyRequest): Address {
  const state = request.wallet ?? NO_SESSION;
  if (state.identity) return state.identity.address;
  throw (
    state.error ??
    new ProofRelayError("UNAUTHORIZED", "a bearer session token is required", {
      detail: { hint: "POST /v1/auth/nonce then POST /v1/auth/verify" },
    })
  );
}

/* ── assembly ────────────────────────────────────────────────────────────── */

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? new Logger(deps.config.api.logLevel, { component: "api" });
  const now = deps.now ?? (() => new Date());

  const context: RouteContext = {
    config: deps.config,
    pool: deps.pool,
    chain: deps.chain,
    storage: deps.storage,
    compute: deps.compute,
    logger,
    indexer: deps.indexer ?? null,
    orchestrator: deps.orchestrator ?? null,
    now,
    tasks: createTaskService({
      db: deps.pool,
      chain: deps.chain,
      storage: deps.storage,
      config: deps.config,
      logger,
      now,
    }),
    prepare: createPrepareService({
      chain: deps.chain,
      storage: deps.storage,
      config: deps.config,
      logger,
      now,
    }),
  };

  // Annotated rather than inlined: with trustProxy present TypeScript resolves
  // Fastify's http2 overload instead of the default one and the instance type
  // drifts away from FastifyInstance.
  const serverOptions: FastifyServerOptions = {
    // Fastify's own pino logger stays off: `Logger` is what carries the
    // correlation fields the architecture doc asks for, and two log formats in
    // one stream is worse than one.
    logger: false,
    bodyLimit: deps.config.api.bodyLimitBytes,
    // Number of reverse proxies in front of this API. 0 — the default — makes
    // the socket peer the client, which is what a direct deployment wants and
    // what a deployment behind a TLS terminator must not leave: there every
    // anonymous caller in the world resolves to the proxy and shares one
    // rate-limit bucket. Raising it where no proxy exists is the opposite
    // failure — any client could forge X-Forwarded-For and mint a fresh bucket
    // per request — so it stays opt-in through TRUST_PROXY_HOPS.
    // A function rather than a bare `true`: `true` trusts every hop, so a client
    // that sends its own X-Forwarded-For chain picks its own address and mints a
    // fresh rate-limit bucket per request. This trusts exactly the first
    // TRUST_PROXY_HOPS hops, which is what the operator actually deployed.
    trustProxy:
      deps.config.api.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < deps.config.api.trustProxyHops
        : false,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      const value = Array.isArray(supplied) ? supplied[0] : supplied;
      return value && /^[\w.:-]{1,128}$/.test(value) ? value : randomUUID();
    },
  };

  const app = Fastify(serverOptions);

  app.setErrorHandler((error, request, reply) => errorHandler(logger)(error, request, reply));

  /**
   * A route that does not exist is not a task that does not exist, but
   * `ErrorCode` has no generic NOT_FOUND and `mapError` already documents
   * TASK_NOT_FOUND as the 404 fall-through. Answering with the same body shape
   * as every other error matters more than the code being a perfect fit.
   */
  app.setNotFoundHandler((request, reply) => {
    const error = new ProofRelayError("TASK_NOT_FOUND", `no route for ${request.method} ${request.url}`, {
      detail: { method: request.method, url: request.url },
    });
    return errorHandler(logger)(error, request, reply);
  });

  // Reserved rather than given a default value: every request gets its own in
  // the hook below, and a shared default object would be one mutable state
  // visible to every concurrent request.
  app.decorateRequest("wallet");

  app.addHook("onRequest", async (request, reply) => {
    request.wallet = NO_SESSION;
    reply.header("x-request-id", request.id);

    const token = bearerToken(request.headers.authorization);
    if (!token) return;
    try {
      request.wallet = { identity: await resolveSession(deps.pool, token, now()), error: null };
    } catch (error) {
      // SESSION_EXPIRED here; a route that needs a wallet re-raises it, one
      // that does not carries on unauthenticated.
      request.wallet = {
        identity: null,
        error:
          error instanceof ProofRelayError
            ? error
            : new ProofRelayError("UNAUTHORIZED", "session could not be resolved", { cause: error }),
      };
    }
  });

  await app.register(cors, {
    // Vite picks the next free port when its own is taken, so a dev origin is
    // not knowable in advance — a fixed allowlist produces a UI stuck on
    // skeletons with nothing in the server log to explain it. Outside
    // production any loopback origin is accepted; in production only the
    // configured list is, and there is no wildcard.
    origin: isDevelopment
      ? (origin, callback) => callback(null, !origin || LOOPBACK_ORIGIN.test(origin) || deps.config.api.corsOrigins.includes(origin))
      : deps.config.api.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-request-id"],
    exposedHeaders: ["x-request-id", "x-idempotent-replay", "retry-after"],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    max: deps.config.api.rateLimitMax,
    timeWindow: deps.config.api.rateLimitWindowMs,
    // Per IP, always.
    //
    // Keying on the wallet when one was proved inverted the mitigation it was
    // meant to be: nothing gates who may hold a session — `POST /v1/auth/nonce`
    // issues a challenge for any address asked for, and a wallet is a keypair
    // anyone can generate offline for free — so authenticating handed the caller
    // a *fresh* bucket. An attacker multiplied its quota by signing in again,
    // while a NAT'd office shared one. An identity that costs nothing cannot
    // bound anything.
    keyGenerator: (request) => request.ip,
    // The limiter's own rejection goes through `mapError`, which turns a 429
    // into RATE_LIMITED; building a second error shape here would give the UI
    // two things to parse.
    errorResponseBuilder: (_request, context) =>
      new ProofRelayError("RATE_LIMITED", `rate limit exceeded, retry in ${context.after}`, {
        detail: { max: context.max, windowMs: deps.config.api.rateLimitWindowMs, after: context.after },
      }),
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.httpLatency.observe(reply.elapsedTime, {
      method: request.method,
      route: request.routeOptions?.url ?? "unrouted",
      status: String(reply.statusCode),
    });
    logger.debug("request", {
      ...correlationFields(request),
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  await registerHealthRoutes(app, context);
  await registerAuthRoutes(app, context);
  await registerStatsRoutes(app, context);
  await registerTaskRoutes(app, context);
  await registerReportRoutes(app, context);
  await registerVerifierRoutes(app, context);
  await registerArtifactRoutes(app, context);
  await registerArtifactObjectRoute(app, context);
  await registerActivityRoutes(app, context);

  await app.ready();
  return app;
}

/**
 * Shared by the routes that page: an opaque marker rather than an offset. The
 * implementation lives in `middleware/cursor.ts` with the per-field validators,
 * and is re-exported here because that is where the route files already look.
 */
export {
  cursorInteger,
  cursorTimestamp,
  decodeCursor,
  encodeCursor,
  rejectCursor,
} from "./middleware/cursor.js";
