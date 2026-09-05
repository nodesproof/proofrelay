/**
 * `POST /v1/auth/nonce` and `POST /v1/auth/verify`.
 *
 * Both are mutations, and both deliberately do *not* take an `Idempotency-Key`
 * even though every other mutation does. A replayed nonce is not a nonce, and a
 * replayed session issuance would hand the same bearer token to a second
 * caller — the whole point of `auth/siwe.ts` is that the second presentation of
 * a signature fails. Making these replayable would undo that.
 */
import type { FastifyInstance } from "fastify";
import {
  NonceRequest,
  NonceResponse,
  VerifyRequest,
  VerifyResponse,
} from "@proofrelay/schemas";
import type { RouteContext } from "../app.js";
import { authOptionsFromConfig, bearerToken, createChallenge, revokeSession, verifyChallenge } from "../auth/siwe.js";

export async function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const options = authOptionsFromConfig(ctx.config);

  app.post("/v1/auth/nonce", async (request) => {
    const input = NonceRequest.parse(request.body ?? {});
    const challenge = await createChallenge(ctx.pool, input, options, ctx.now());
    ctx.logger.info("auth challenge issued", { requestId: request.id, address: challenge.address });
    return NonceResponse.parse({
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
    });
  });

  /**
   * Revoking is not the same as forgetting. A UI that only drops its copy of the
   * token leaves it live on the server until `SESSION_TTL_SEC` runs out, which
   * is not what a user who clicked "sign out" was told would happen —
   * `revokeSession` has existed since the auth layer was written and nothing
   * reached it.
   *
   * 204 whether or not a row was hit. A caller learning that its token *was*
   * still valid is the one piece of information a logout has no reason to give.
   */
  app.post("/v1/auth/logout", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token) {
      const revoked = await revokeSession(ctx.pool, token, ctx.now());
      ctx.logger.info("auth session revoked", { requestId: request.id, revoked });
    }
    return reply.code(204).send();
  });

  app.post("/v1/auth/verify", async (request) => {
    const input = VerifyRequest.parse(request.body ?? {});
    try {
      const session = await verifyChallenge(ctx.pool, input, options, ctx.now());
      // The token is in the body and nowhere else: logging it would put a live
      // credential in the log stream, which is the one place it must never be.
      ctx.logger.info("auth session issued", { requestId: request.id, address: session.address });
      return VerifyResponse.parse({
        token: session.token,
        address: session.address,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      // `VerifyFailure` is more granular than the error code on purpose: a spike
      // in `nonce_consumed` is a replay attempt, a spike in `signature_invalid`
      // is a broken wallet integration, and the log line is where that shows.
      const reason = (error as { detail?: { reason?: string } })?.detail?.reason ?? "error";
      ctx.logger.warn("auth verify rejected", {
        requestId: request.id,
        address: input.address,
        errorCode: (error as { code?: string })?.code ?? "INTERNAL",
        reason,
      });
      throw error;
    }
  });
}
