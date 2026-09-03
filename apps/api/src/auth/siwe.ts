/**
 * SIWE-style wallet authentication.
 *
 * The threat model's "Signature replay" section is the specification: the
 * challenge binds domain, EIP-55 address, chain ID, a single-use nonce and an
 * expiry, and the nonce is consumed transactionally *after* the signature
 * verifies, so a valid signature presented twice is still rejected the second
 * time.
 *
 * Two decisions that are easy to get wrong and are load-bearing here:
 *
 * 1. `verifyChallenge` never accepts a message from the client. It takes a
 *    nonce, reads the row it issued, and rebuilds the exact bytes it expects to
 *    have been signed. A client that could hand over its own message text could
 *    sign a challenge for a different domain or a different chain and present
 *    it here — binding the fields would then prove nothing.
 * 2. The session token is opaque and only its sha256 is stored. A dump of
 *    `sessions` therefore does not let the reader authenticate as anyone; the
 *    bearer token exists only in the client.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { envInt, type Config } from "@proofrelay/config";
import { ProofRelayError } from "@proofrelay/schemas";
import { one, withTransaction, type Pool } from "../db.js";

/**
 * Wording matters: a wallet shows this line verbatim, and a user who cannot
 * tell a login from a transaction is one prompt away from signing something
 * else. It says what the signature does and what it does not do.
 */
export const AUTH_STATEMENT =
  "Sign in to ProofRelay. This proves you control this address. " +
  "It authorises no transaction and moves no funds.";

export interface AuthOptions {
  domain: string;
  chainId: number;
  /** How long a challenge stays signable. */
  nonceTtlSec: number;
  sessionTtlSec: number;
  statement: string;
}

export function authOptionsFromConfig(config: Config): AuthOptions {
  return {
    domain: config.api.domain,
    chainId: config.chain.chainId,
    nonceTtlSec: envInt("AUTH_NONCE_TTL_SEC", 300),
    sessionTtlSec: config.api.sessionTtlSec,
    statement: AUTH_STATEMENT,
  };
}

export interface Challenge {
  nonce: string;
  message: string;
  address: Address;
  domain: string;
  chainId: number;
  statement: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SessionToken {
  /** The bearer token. Returned once, never stored, never logged. */
  token: string;
  address: Address;
  issuedAt: string;
  expiresAt: string;
}

export interface SessionIdentity {
  address: Address;
  expiresAt: Date;
}

interface NonceRow {
  nonce: string;
  address: string;
  chain_id: number;
  domain: string;
  statement: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

interface SessionRow {
  address: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * The URI is derived from the domain the challenge was issued under rather than
 * read from configuration at verify time. `AUTH_URI` changing between issue and
 * verify would otherwise invalidate every outstanding challenge, and the domain
 * is the field that actually carries the anti-phishing meaning.
 */
function challengeUri(domain: string): string {
  return `https://${domain}`;
}

/** EIP-4361 layout. Byte-exact — this is what gets signed and re-derived. */
export function buildChallengeMessage(fields: {
  domain: string;
  address: Address;
  statement: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${challengeUri(fields.domain)}`,
    "Version: 1",
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expiresAt.toISOString()}`,
  ].join("\n");
}

export function normalizeAddress(value: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ProofRelayError("VALIDATION_FAILED", "not an EVM address", {
      detail: { field: "address" },
    });
  }
  return getAddress(value);
}

export async function createChallenge(
  pool: Pool,
  input: { address: string },
  options: AuthOptions,
  now = new Date(),
): Promise<Challenge> {
  const address = normalizeAddress(input.address);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = now;
  const expiresAt = new Date(now.getTime() + options.nonceTtlSec * 1_000);

  await pool.query(
    `INSERT INTO auth_nonces (nonce, address, chain_id, domain, statement, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [nonce, address, options.chainId, options.domain, options.statement, issuedAt, expiresAt],
  );

  return {
    nonce,
    message: buildChallengeMessage({
      domain: options.domain,
      address,
      statement: options.statement,
      chainId: options.chainId,
      nonce,
      issuedAt,
      expiresAt,
    }),
    address,
    domain: options.domain,
    chainId: options.chainId,
    statement: options.statement,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * The reason a caller was turned away, for `auth_verify_total{result}`. It is
 * deliberately more granular than the error code, because a spike in
 * `nonce_consumed` is a replay attempt while a spike in `signature_invalid` is
 * a broken wallet integration.
 */
export type VerifyFailure =
  | "address_invalid"
  | "signature_malformed"
  | "nonce_unknown"
  | "nonce_consumed"
  | "nonce_expired"
  | "address_mismatch"
  | "chain_mismatch"
  | "domain_mismatch"
  | "signature_invalid";

function reject(failure: VerifyFailure): ProofRelayError {
  switch (failure) {
    case "nonce_unknown":
      return new ProofRelayError("NONCE_INVALID", "no such challenge", {
        detail: { reason: failure },
      });
    case "nonce_consumed":
      return new ProofRelayError("NONCE_INVALID", "this challenge has already been used", {
        detail: { reason: failure },
      });
    // There is no NONCE_EXPIRED code; SESSION_EXPIRED is the 401 the UI already
    // handles by starting a fresh challenge, which is exactly the right move.
    case "nonce_expired":
      return new ProofRelayError("SESSION_EXPIRED", "this challenge has expired", {
        detail: { reason: failure },
      });
    case "address_mismatch":
      return new ProofRelayError("UNAUTHORIZED", "this challenge was issued to another address", {
        detail: { reason: failure },
      });
    case "chain_mismatch":
      return new ProofRelayError("VALIDATION_FAILED", "this challenge is for another chain", {
        detail: { reason: failure },
      });
    case "domain_mismatch":
      return new ProofRelayError("VALIDATION_FAILED", "this challenge is for another domain", {
        detail: { reason: failure },
      });
    case "signature_malformed":
      return new ProofRelayError("SIGNATURE_INVALID", "signature is not hex", {
        detail: { reason: failure },
      });
    case "signature_invalid":
      return new ProofRelayError("SIGNATURE_INVALID", "signature does not match the challenge", {
        detail: { reason: failure },
      });
    default:
      return new ProofRelayError("VALIDATION_FAILED", "not an EVM address", {
        detail: { reason: failure },
      });
  }
}

export async function verifyChallenge(
  pool: Pool,
  input: { address: string; signature: string; nonce: string },
  options: AuthOptions,
  now = new Date(),
): Promise<SessionToken> {
  const address = normalizeAddress(input.address);
  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) {
    throw reject("signature_malformed");
  }

  const row = await one<NonceRow>(pool, "SELECT * FROM auth_nonces WHERE nonce = $1", [input.nonce]);
  if (!row) throw reject("nonce_unknown");

  if (getAddress(row.address) !== address) throw reject("address_mismatch");
  if (Number(row.chain_id) !== options.chainId) throw reject("chain_mismatch");
  if (row.domain !== options.domain) throw reject("domain_mismatch");
  if (row.consumed_at !== null) throw reject("nonce_consumed");
  if (row.expires_at.getTime() <= now.getTime()) throw reject("nonce_expired");

  const message = buildChallengeMessage({
    domain: row.domain,
    address,
    statement: row.statement,
    chainId: Number(row.chain_id),
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  });

  // A malformed-but-hex signature makes viem throw rather than return false.
  const valid = await verifyMessage({ address, message, signature: input.signature as Hex }).catch(
    () => false,
  );
  if (!valid) throw reject("signature_invalid");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + options.sessionTtlSec * 1_000);

  return withTransaction(pool, async (client) => {
    // Consuming and issuing in one transaction is what makes the replay window
    // zero-width: two requests carrying the same valid signature race here, and
    // the loser's UPDATE matches no row because consumed_at is no longer null.
    const consumed = await client.query(
      "UPDATE auth_nonces SET consumed_at = $2 WHERE nonce = $1 AND consumed_at IS NULL RETURNING nonce",
      [row.nonce, now],
    );
    if (consumed.rowCount === 0) throw reject("nonce_consumed");

    await client.query(
      "INSERT INTO sessions (token_hash, address, issued_at, expires_at) VALUES ($1, $2, $3, $4)",
      [hashToken(token), address, now, expiresAt],
    );

    return {
      token,
      address,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

/** Sessions are stored by digest, so the table never holds a usable credential. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function bearerToken(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function resolveSession(
  pool: Pool,
  token: string,
  now = new Date(),
): Promise<SessionIdentity | null> {
  const row = await one<SessionRow>(
    pool,
    "SELECT address, expires_at, revoked_at FROM sessions WHERE token_hash = $1",
    [hashToken(token)],
  );
  if (!row || row.revoked_at !== null) return null;
  if (row.expires_at.getTime() <= now.getTime()) {
    throw new ProofRelayError("SESSION_EXPIRED", "session expired");
  }
  return { address: getAddress(row.address), expiresAt: row.expires_at };
}

/** Resolves a bearer token to the address that signed for it. */
export async function requireSession(
  pool: Pool,
  authorization: string | string[] | undefined,
  now = new Date(),
): Promise<SessionIdentity> {
  const token = bearerToken(authorization);
  if (!token) {
    throw new ProofRelayError("UNAUTHORIZED", "a bearer session token is required");
  }
  const session = await resolveSession(pool, token, now);
  if (!session) {
    throw new ProofRelayError("UNAUTHORIZED", "unknown or revoked session");
  }
  return session;
}

export async function revokeSession(pool: Pool, token: string, now = new Date()): Promise<boolean> {
  const result = await pool.query(
    "UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token), now],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Spent and expired challenges are kept for a while rather than deleted on use:
 * a replay must be answered with "already used", and a row that is gone is
 * indistinguishable from a nonce that was never issued.
 */
export async function purgeExpiredAuth(
  pool: Pool,
  retainSec = 86_400,
  now = new Date(),
): Promise<{ nonces: number; sessions: number }> {
  const cutoff = new Date(now.getTime() - retainSec * 1_000);
  const nonces = await pool.query("DELETE FROM auth_nonces WHERE expires_at < $1", [cutoff]);
  const sessions = await pool.query("DELETE FROM sessions WHERE expires_at < $1", [cutoff]);
  return { nonces: nonces.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
}
