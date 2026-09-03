/**
 * The task endpoints.
 *
 * `prepare` and `challenge` are the two mutations, and both go through
 * `withIdempotency`: preparation fetches sources and uploads a manifest to 0G
 * Storage, so a double-submitted form must not produce a second manifest the
 * creator could also sign.
 *
 * `sync` is deliberately *not* idempotency-keyed. It writes only what the chain
 * says, so running it twice converges on the same row rather than duplicating
 * anything — and the runbook tells an operator to curl it with no headers when
 * the read model has drifted. Requiring a key there would make the documented
 * recovery step fail.
 *
 * The creator is whoever the session says, and falls back to an explicit
 * `creator` in the body when there is no session. The threat model plans for
 * both — "rate limiting is applied per wallet when authenticated and per IP
 * otherwise" — and preparation signs nothing, spends none of the caller's
 * funds and mints no task: the wallet still has to send `createTask` itself.
 */
import type { FastifyInstance } from "fastify";
import { isAddress, type Address } from "viem";
import { ProofRelayError, TaskListQuery } from "@proofrelay/schemas";
import type { RouteContext } from "../app.js";
import {
  IDEMPOTENCY_HEADER,
  REPLAY_HEADER,
  requireIdempotencyKey,
  withIdempotency,
} from "../middleware/idempotency.js";
import { resolveTaskId } from "../services/refs.js";

interface TaskParams {
  taskId: string;
}

/**
 * The address the artifact will name. A session wins over the body, so a caller
 * that authenticated cannot prepare a manifest in somebody else's name.
 */
export function actingAddress(
  request: { wallet?: { identity: { address: Address } | null } },
  body: unknown,
  field: "creator" | "challenger",
): Address {
  const session = request.wallet?.identity?.address;
  if (session) return session;

  const supplied = (body as Record<string, unknown> | null | undefined)?.[field];
  if (typeof supplied === "string" && isAddress(supplied)) return supplied as Address;

  throw new ProofRelayError(
    "UNAUTHORIZED",
    `sign in, or name the ${field} address in the request body`,
    { detail: { field, hint: "POST /v1/auth/nonce then POST /v1/auth/verify" } },
  );
}

export async function registerTaskRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  app.get("/v1/tasks", async (request) =>
    ctx.tasks.listTasks(TaskListQuery.parse((request.query ?? {}) as Record<string, unknown>)),
  );

  /**
   * Rate-limited on its own, far below the global budget. Each accepted request
   * writes one object to 0G Storage per source plus the manifest — up to 21
   * uploads, every one of them paid for by STORAGE_PRIVATE_KEY — and it needs no
   * session, because `actingAddress` accepts a creator named in the body. The
   * global limit is sized for a browser polling read endpoints and is far too
   * loose to sit in front of a spend.
   *
   * This bounds the damage; it does not remove it. Requiring a signed-in wallet
   * is the complete fix, and it needs the web app to implement SIWE first —
   * `authNonce`/`authVerify` exist in the client and nothing calls them.
   */
  app.post(
    "/v1/tasks/prepare",
    { config: { rateLimit: { max: ctx.config.api.spendRateLimitMax } } },
    async (request, reply) => {
      const key = requireIdempotencyKey(request.headers[IDEMPOTENCY_HEADER]);
      const creator = actingAddress(request, request.body, "creator");

      const result = await withIdempotency(
        ctx.pool,
        { key, route: "POST /v1/tasks/prepare", body: request.body ?? null, statusCode: 201 },
        () => ctx.prepare.prepareTask({ creator, request: request.body }),
        ctx.now(),
      );

      return reply
        .code(result.statusCode)
        .header(REPLAY_HEADER, String(result.replayed))
        .send(result.body);
    },
  );

  app.get<{ Params: TaskParams }>("/v1/tasks/:taskId", async (request) =>
    ctx.tasks.getTask(request.params.taskId),
  );

  app.post<{ Params: TaskParams }>("/v1/tasks/:taskId/sync", async (request) => {
    const result = await ctx.tasks.syncTask(request.params.taskId);
    ctx.logger.info("task synced", {
      requestId: request.id,
      taskId: result.taskId,
      syncState: result.syncState,
      changed: result.changed,
    });
    return result;
  });

  /** Same budget as `prepare`: it uploads the challenge evidence on the operator's key. */
  app.post<{ Params: TaskParams }>(
    "/v1/tasks/:taskId/challenge",
    { config: { rateLimit: { max: ctx.config.api.spendRateLimitMax } } },
    async (request, reply) => {
      const key = requireIdempotencyKey(request.headers[IDEMPOTENCY_HEADER]);
      const challenger = actingAddress(request, request.body, "challenger");
      // Resolved before the handler so a `PR-…` handle is accepted here too, and
      // so the idempotency route string names one task rather than two spellings
      // of it.
      const taskId = await resolveTaskId(ctx.pool, request.params.taskId);

      const result = await withIdempotency(
        ctx.pool,
        {
          key,
          route: `POST /v1/tasks/${taskId}/challenge`,
          body: request.body ?? null,
          statusCode: 201,
        },
        () => ctx.prepare.prepareChallenge({ taskId, challenger, request: request.body }),
        ctx.now(),
      );

      return reply
        .code(result.statusCode)
        .header(REPLAY_HEADER, String(result.replayed))
        .send(result.body);
    },
  );
}
