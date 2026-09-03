/**
 * Idempotency for mutating endpoints.
 *
 * Every mutation the UI performs is retried by the browser, by a flaky mobile
 * connection, or by a user pressing the button twice. `POST /v1/tasks/prepare`
 * fetches sources and uploads a manifest to 0G Storage, so a duplicate is not
 * merely wasteful — it produces a second manifest, which is a second thing the
 * creator could sign.
 *
 * The contract is the usual one, with the strict half kept strict: the same key
 * with the same body replays the stored response byte for byte, and the same key
 * with a *different* body is a 409. Serving the first answer to a second
 * question is worse than an error, because the client would never learn that
 * the request it actually sent was ignored.
 */
import { createHash } from "node:crypto";
import { ProofRelayError, canonicalString } from "@proofrelay/schemas";
import { withTransaction, type Pool } from "../db.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAY_HEADER = "x-idempotent-replay";

/**
 * A row claimed but never completed is a crashed attempt. Sixty seconds is
 * longer than any handler here takes and short enough that a user retrying by
 * hand is not told "still in flight" about a process that died.
 */
export const IN_FLIGHT_TIMEOUT_MS = 60_000;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

export function requireIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) {
    throw new ProofRelayError("VALIDATION_FAILED", "an Idempotency-Key header is required", {
      detail: { header: "Idempotency-Key" },
    });
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ProofRelayError(
      "VALIDATION_FAILED",
      "Idempotency-Key must be 8-255 characters of [A-Za-z0-9._:-]",
      { detail: { header: "Idempotency-Key" } },
    );
  }
  return key;
}

/**
 * Hashed over canonical bytes, so a client that re-serialises its own request
 * with different key order is a replay rather than a conflict. That is the
 * whole reason `canonicalString` exists.
 */
export function requestHash(route: string, body: unknown): string {
  return createHash("sha256")
    .update(`${route}\n${canonicalString(body ?? null)}`, "utf8")
    .digest("hex");
}

export type IdempotencyClaim =
  | { state: "fresh" }
  | { state: "replay"; statusCode: number; response: unknown };

interface KeyRow {
  route: string;
  request_hash: string;
  status_code: number | null;
  response: unknown;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyArgs {
  key: string;
  route: string;
  body: unknown;
}

/**
 * Claims the key, or reports that this exact request already has an answer.
 *
 * The insert is the lock: `ON CONFLICT DO NOTHING` means two concurrent
 * requests with the same key cannot both be "fresh", whatever the isolation
 * level, and the loser goes on to read the row the winner inserted.
 */
export async function beginIdempotent(
  pool: Pool,
  args: IdempotencyArgs,
  now = new Date(),
): Promise<IdempotencyClaim> {
  const hash = requestHash(args.route, args.body);

  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (key, route, request_hash, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [args.key, args.route, hash, now],
    );
    if ((inserted.rowCount ?? 0) > 0) return { state: "fresh" };

    const existing = await client.query<KeyRow>(
      `SELECT route, request_hash, status_code, response, created_at, completed_at
         FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
      [args.key],
    );
    const row = existing.rows[0];
    if (!row) return { state: "fresh" };

    if (row.route !== args.route) {
      throw conflict(args.key, "route");
    }
    if (row.request_hash !== hash) {
      throw conflict(args.key, "body");
    }
    if (row.completed_at !== null) {
      return { state: "replay", statusCode: row.status_code ?? 200, response: row.response };
    }
    if (now.getTime() - row.created_at.getTime() > IN_FLIGHT_TIMEOUT_MS) {
      // The previous attempt died without answering. Re-stamp it so this
      // attempt owns the lease, rather than leaving the key wedged forever.
      await client.query("UPDATE idempotency_keys SET created_at = $2 WHERE key = $1", [
        args.key,
        now,
      ]);
      return { state: "fresh" };
    }
    throw conflict(args.key, "in_flight");
  });
}

function conflict(key: string, reason: "route" | "body" | "in_flight"): ProofRelayError {
  const message =
    reason === "in_flight"
      ? "a request with this Idempotency-Key is still in flight"
      : `this Idempotency-Key was used for a different request ${reason}`;
  return new ProofRelayError("IDEMPOTENCY_CONFLICT", message, {
    retryable: false,
    detail: { key, reason },
  });
}

export async function completeIdempotent(
  pool: Pool,
  key: string,
  statusCode: number,
  response: unknown,
  now = new Date(),
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
        SET status_code = $2, response = $3::jsonb, completed_at = $4
      WHERE key = $1`,
    [key, statusCode, JSON.stringify(response ?? null), now],
  );
}

/**
 * A failed handler releases its key. Only successful responses are worth
 * replaying — pinning a 503 to the key would make the client's own retry
 * impossible, and none of these endpoints has an irreversible side effect that
 * survives its own failure.
 */
export async function releaseIdempotent(pool: Pool, key: string): Promise<void> {
  await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND completed_at IS NULL", [key]);
}

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

export async function withIdempotency<T>(
  pool: Pool,
  args: IdempotencyArgs & { statusCode?: number },
  handler: () => Promise<T>,
  now = new Date(),
): Promise<IdempotentResult<T>> {
  const claim = await beginIdempotent(pool, args, now);
  if (claim.state === "replay") {
    return { statusCode: claim.statusCode, body: claim.response as T, replayed: true };
  }

  const statusCode = args.statusCode ?? 200;
  try {
    const body = await handler();
    await completeIdempotent(pool, args.key, statusCode, body, new Date());
    return { statusCode, body, replayed: false };
  } catch (error) {
    await releaseIdempotent(pool, args.key).catch(() => undefined);
    throw error;
  }
}

export async function purgeIdempotencyKeys(
  pool: Pool,
  retainMs = 24 * 60 * 60 * 1_000,
  now = new Date(),
): Promise<number> {
  const result = await pool.query("DELETE FROM idempotency_keys WHERE created_at < $1", [
    new Date(now.getTime() - retainMs),
  ]);
  return result.rowCount ?? 0;
}
