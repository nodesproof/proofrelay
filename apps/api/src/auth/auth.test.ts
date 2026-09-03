/**
 * Auth and the middleware layer.
 *
 * The replay cases are the reason this file exists. A signature is not a
 * credential — it is a credential *for one challenge*, and everything that
 * makes that true (the single-use nonce, the transactional consume, the chain
 * and domain binding) is asserted here against a real Postgres rather than a
 * stub, because the guarantee lives in the UPDATE's WHERE clause.
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { z } from "zod";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "@proofrelay/config";
import { ProofRelayError } from "@proofrelay/schemas";
import {
  AUTH_STATEMENT,
  bearerToken,
  buildChallengeMessage,
  createChallenge,
  hashToken,
  normalizeAddress,
  requireSession,
  resolveSession,
  revokeSession,
  verifyChallenge,
  type AuthOptions,
} from "./siwe.js";
import {
  IN_FLIGHT_TIMEOUT_MS,
  beginIdempotent,
  requestHash,
  requireIdempotencyKey,
  withIdempotency,
} from "../middleware/idempotency.js";
import { mapError, scrubSecrets } from "../middleware/errors.js";

/** Anvil's second well-known account. Public by construction; funds nothing. */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const signer = privateKeyToAccount(TEST_KEY);

const DOMAIN = "auth-test.proofrelay.invalid";
const CHAIN_ID = 16_602;
const KEY_PREFIX = "authtest-";

const options: AuthOptions = {
  domain: DOMAIN,
  chainId: CHAIN_ID,
  nonceTtlSec: 300,
  sessionTtlSec: 3_600,
  statement: AUTH_STATEMENT,
};

async function openPool(): Promise<
  { ok: true; pool: pg.Pool } | { ok: false; detail: string }
> {
  const url = loadConfig().api.databaseUrl;
  const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3_000 });
  pool.on("error", () => undefined);
  try {
    await pool.query("SELECT 1");
    return { ok: true, pool };
  } catch (error) {
    await pool.end().catch(() => undefined);
    return { ok: false, detail: String((error as Error).message).slice(0, 160) };
  }
}

const probe = await openPool();
if (!probe.ok) {
  console.warn(
    `[auth.test] DATABASE_URL is unreachable (${probe.detail}) — skipping the DB-backed auth, ` +
      "session and idempotency suites. Start Postgres and run `npm run migrate` to run them.",
  );
}
const describeDb = probe.ok ? describe : describe.skip;

// One teardown for the whole file: the suites below share a pool, so ending it
// inside any of them would take the others down with it.
afterAll(async () => {
  if (!probe.ok) return;
  const { pool } = probe;
  await pool.query("DELETE FROM auth_nonces WHERE domain LIKE $1", [`%${DOMAIN}`]).catch(() => undefined);
  await pool
    .query("DELETE FROM sessions WHERE lower(address) = lower($1)", [signer.address])
    .catch(() => undefined);
  await pool
    .query("DELETE FROM idempotency_keys WHERE key LIKE $1", [`${KEY_PREFIX}%`])
    .catch(() => undefined);
  await pool.end().catch(() => undefined);
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    if (error instanceof ProofRelayError) return error.code;
    return `UNEXPECTED: ${String((error as Error).message ?? error)}`;
  }
}

describe("challenge message", () => {
  const issuedAt = new Date("2026-09-02T10:00:00.000Z");
  const expiresAt = new Date("2026-09-02T10:05:00.000Z");
  const message = buildChallengeMessage({
    domain: DOMAIN,
    address: signer.address,
    statement: AUTH_STATEMENT,
    chainId: CHAIN_ID,
    nonce: "abc123",
    issuedAt,
    expiresAt,
  });

  it("binds the domain, the checksummed address, the chain and the nonce", () => {
    expect(message.startsWith(`${DOMAIN} wants you to sign in`)).toBe(true);
    expect(message).toContain(getAddress(signer.address));
    expect(message).toContain(`Chain ID: ${CHAIN_ID}`);
    expect(message).toContain("Nonce: abc123");
    expect(message).toContain("Issued At: 2026-09-02T10:00:00.000Z");
    expect(message).toContain("Expiration Time: 2026-09-02T10:05:00.000Z");
  });

  it("says in the wallet prompt that it authorises nothing", () => {
    expect(message).toContain("authorises no transaction and moves no funds");
  });

  it("checksums an address and refuses a non-address", () => {
    expect(normalizeAddress(signer.address.toLowerCase())).toBe(getAddress(signer.address));
    expect(() => normalizeAddress("0xnope")).toThrow(ProofRelayError);
  });

  it("parses a bearer header and nothing else", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("stores a session by digest, never by token", () => {
    const token = "not-a-real-token";
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });
});

describe("error mapping", () => {
  it("keeps a ProofRelayError's code and status", () => {
    const mapped = mapError(new ProofRelayError("TASK_NOT_FOUND", "no such task"));
    expect(mapped.statusCode).toBe(404);
    expect(mapped.body.error.code).toBe("TASK_NOT_FOUND");
    expect(mapped.internal).toBe(false);
  });

  it("turns a ZodError into VALIDATION_FAILED with the field paths", () => {
    const schema = z.object({ claims: z.array(z.object({ text: z.string() })) });
    const parsed = schema.safeParse({ claims: [{ text: 7 }] });
    expect(parsed.success).toBe(false);
    const mapped = mapError(parsed.success ? new Error("unreachable") : parsed.error);
    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe("VALIDATION_FAILED");
    const fields = (mapped.body.error.detail as { fields: Array<{ path: string }> }).fields;
    expect(fields[0]?.path).toBe("claims.0.text");
  });

  it("never leaks a stack trace or an internal message", () => {
    const error = new Error("connect ECONNREFUSED /var/run/postgresql/.s.PGSQL.5432");
    const mapped = mapError(error);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe("INTERNAL");
    expect(mapped.body.error.message).toBe("internal error");
    expect(JSON.stringify(mapped.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(mapped.body)).not.toContain("at ");
  });

  it("scrubs a configured secret out of anything it echoes", () => {
    const env = { KEEPER_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeef" } as NodeJS.ProcessEnv;
    const text = "signing failed with 0xdeadbeefdeadbeefdeadbeef";
    expect(scrubSecrets(text, env)).toBe("signing failed with [redacted]");
  });
});

describe("idempotency key handling", () => {
  it("requires a key of a sane shape", async () => {
    expect(await codeOf(Promise.reject(mustThrow(() => requireIdempotencyKey(undefined))))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await codeOf(Promise.reject(mustThrow(() => requireIdempotencyKey("short"))))).toBe(
      "VALIDATION_FAILED",
    );
    expect(requireIdempotencyKey("create-task-0001")).toBe("create-task-0001");
  });

  it("hashes the body canonically, so key order is not a different request", () => {
    const a = requestHash("/v1/tasks/prepare", { title: "x", claims: ["a"] });
    const b = requestHash("/v1/tasks/prepare", { claims: ["a"], title: "x" });
    const c = requestHash("/v1/tasks/prepare", { claims: ["b"], title: "x" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

function mustThrow(fn: () => unknown): unknown {
  try {
    fn();
    return new Error("expected a throw");
  } catch (error) {
    return error;
  }
}

describeDb("SIWE challenge and session", () => {
  const pool = (probe as { pool: pg.Pool }).pool;

  async function issueAndSign(overrides: Partial<AuthOptions> = {}, now = new Date()) {
    const opts = { ...options, ...overrides };
    const challenge = await createChallenge(pool, { address: signer.address }, opts, now);
    const signature = await signer.signMessage({ message: challenge.message });
    return { challenge, signature, opts };
  }

  it("accepts a signature over the challenge it issued", async () => {
    const { challenge, signature } = await issueAndSign();
    const session = await verifyChallenge(
      pool,
      { address: signer.address, signature, nonce: challenge.nonce },
      options,
    );
    expect(session.address).toBe(getAddress(signer.address));
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const identity = await requireSession(pool, `Bearer ${session.token}`);
    expect(identity.address).toBe(getAddress(signer.address));
  });

  it("rejects a replay of a consumed nonce even with a valid signature", async () => {
    const { challenge, signature } = await issueAndSign();
    const first = await verifyChallenge(
      pool,
      { address: signer.address, signature, nonce: challenge.nonce },
      options,
    );
    expect(first.token).toBeTruthy();

    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature, nonce: challenge.nonce },
          options,
        ),
      ),
    ).toBe("NONCE_INVALID");
  });

  it("lets exactly one of two concurrent submissions win", async () => {
    const { challenge, signature } = await issueAndSign();
    const input = { address: signer.address, signature, nonce: challenge.nonce };
    const results = await Promise.allSettled([
      verifyChallenge(pool, input, options),
      verifyChallenge(pool, input, options),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ProofRelayError);
    expect(((rejected[0] as PromiseRejectedResult).reason as ProofRelayError).code).toBe(
      "NONCE_INVALID",
    );
  });

  it("rejects a challenge issued for another chain", async () => {
    const { challenge, signature } = await issueAndSign({ chainId: 1 });
    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature, nonce: challenge.nonce },
          options,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("rejects a challenge issued for another domain", async () => {
    const { challenge, signature } = await issueAndSign({ domain: `other.${DOMAIN}` });
    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature, nonce: challenge.nonce },
          options,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    // The stray row belongs to another domain, so clean it up by nonce.
    await pool.query("DELETE FROM auth_nonces WHERE nonce = $1", [challenge.nonce]);
  });

  it("rejects an expired challenge", async () => {
    const issuedAt = new Date();
    const { challenge, signature } = await issueAndSign({ nonceTtlSec: 60 }, issuedAt);
    const later = new Date(issuedAt.getTime() + 61_000);
    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature, nonce: challenge.nonce },
          options,
          later,
        ),
      ),
    ).toBe("SESSION_EXPIRED");
  });

  it("rejects a tampered signature and leaves the nonce spendable", async () => {
    const { challenge, signature } = await issueAndSign();
    const tampered = `${signature.slice(0, 40)}${signature[40] === "a" ? "b" : "a"}${signature.slice(41)}`;

    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature: tampered, nonce: challenge.nonce },
          options,
        ),
      ),
    ).toBe("SIGNATURE_INVALID");

    const row = await pool.query("SELECT consumed_at FROM auth_nonces WHERE nonce = $1", [
      challenge.nonce,
    ]);
    expect(row.rows[0]?.consumed_at).toBeNull();

    const session = await verifyChallenge(
      pool,
      { address: signer.address, signature, nonce: challenge.nonce },
      options,
    );
    expect(session.address).toBe(getAddress(signer.address));
  });

  it("rejects a signature presented for someone else's challenge", async () => {
    const { challenge, signature } = await issueAndSign();
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    expect(
      await codeOf(
        verifyChallenge(pool, { address: other, signature, nonce: challenge.nonce }, options),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("rejects an unknown nonce", async () => {
    const { signature } = await issueAndSign();
    expect(
      await codeOf(
        verifyChallenge(
          pool,
          { address: signer.address, signature, nonce: "0".repeat(32) },
          options,
        ),
      ),
    ).toBe("NONCE_INVALID");
  });

  it("expires and revokes sessions", async () => {
    const issuedAt = new Date();
    const { challenge, signature } = await issueAndSign({}, issuedAt);
    const session = await verifyChallenge(
      pool,
      { address: signer.address, signature, nonce: challenge.nonce },
      { ...options, sessionTtlSec: 60 },
      issuedAt,
    );

    expect(
      await codeOf(
        resolveSession(pool, session.token, new Date(issuedAt.getTime() + 61_000)),
      ),
    ).toBe("SESSION_EXPIRED");

    expect(await revokeSession(pool, session.token)).toBe(true);
    expect(await resolveSession(pool, session.token, issuedAt)).toBeNull();
    expect(await codeOf(requireSession(pool, `Bearer ${session.token}`, issuedAt))).toBe(
      "UNAUTHORIZED",
    );
  });

  it("refuses a request with no bearer token", async () => {
    expect(await codeOf(requireSession(pool, undefined))).toBe("UNAUTHORIZED");
    expect(await codeOf(requireSession(pool, "Bearer not-a-real-token"))).toBe("UNAUTHORIZED");
  });
});

describeDb("idempotency middleware", () => {
  const pool = (probe as { pool: pg.Pool }).pool;
  const route = "/v1/tasks/prepare";
  let counter = 0;
  const nextKey = () => `${KEY_PREFIX}${Date.now()}-${(counter += 1)}`;

  it("replays the stored response for the same key and body", async () => {
    const key = nextKey();
    const body = { title: "Same question", claims: ["a"] };
    let runs = 0;

    const first = await withIdempotency(pool, { key, route, body }, async () => {
      runs += 1;
      return { manifestId: "m-1", runs };
    });
    const second = await withIdempotency(pool, { key, route, body }, async () => {
      runs += 1;
      return { manifestId: "m-2", runs };
    });

    expect(runs).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(second.statusCode).toBe(first.statusCode);
  });

  it("409s the same key with a different body", async () => {
    const key = nextKey();
    await withIdempotency(pool, { key, route, body: { title: "one" } }, async () => ({ ok: true }));
    const failure = await codeOf(
      withIdempotency(pool, { key, route, body: { title: "two" } }, async () => ({ ok: true })),
    );
    expect(failure).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("409s the same key on a different route", async () => {
    const key = nextKey();
    const body = { title: "one" };
    await withIdempotency(pool, { key, route, body }, async () => ({ ok: true }));
    expect(
      await codeOf(
        withIdempotency(pool, { key, route: "/v1/tasks/x/challenge", body }, async () => ({
          ok: true,
        })),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("refuses a second attempt while the first is still in flight", async () => {
    const key = nextKey();
    const body = { title: "in flight" };
    const claim = await beginIdempotent(pool, { key, route, body });
    expect(claim.state).toBe("fresh");
    expect(await codeOf(beginIdempotent(pool, { key, route, body }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("re-runs a crashed attempt once its lease is stale", async () => {
    const key = nextKey();
    const body = { title: "crashed" };
    const started = new Date();
    await beginIdempotent(pool, { key, route, body }, started);

    const later = new Date(started.getTime() + IN_FLIGHT_TIMEOUT_MS + 1_000);
    const retry = await beginIdempotent(pool, { key, route, body }, later);
    expect(retry.state).toBe("fresh");
  });

  it("releases the key when the handler fails, so the client can retry", async () => {
    const key = nextKey();
    const body = { title: "boom" };
    await expect(
      withIdempotency(pool, { key, route, body }, async () => {
        throw new ProofRelayError("STORAGE_UNAVAILABLE", "0G Storage is down");
      }),
    ).rejects.toBeInstanceOf(ProofRelayError);

    const retry = await withIdempotency(pool, { key, route, body }, async () => ({ ok: true }));
    expect(retry.replayed).toBe(false);
    expect(retry.body).toEqual({ ok: true });
  });
});
