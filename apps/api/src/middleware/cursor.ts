/**
 * Keyset page markers.
 *
 * A cursor is an opaque base64url string, but it is *client-held* opaque: it
 * comes back over the wire and can be edited. Every field is therefore
 * re-validated against the column it is about to be compared with, not merely
 * against JavaScript's idea of the type.
 *
 * That distinction is the whole reason this file exists. `Number.isInteger`
 * accepts `1e30`; `bigint` does not, and the value even serialises as `"1e+30"`.
 * `new Date` accepts `Sat Sep 02 2026 12:00:00 GMT+9999` and `+275760-09-13`;
 * `timestamptz` accepts neither. In both cases the mismatch surfaces as a
 * Postgres error the mapper can only render as 500 INTERNAL — an unhandled
 * failure for an input the client supplied and could have been told about.
 */
import { ProofRelayError } from "@proofrelay/schemas";

/** int8 and int4, the two column widths a cursor is compared against. */
const MAX_INT8 = 9_223_372_036_854_775_807n;
const MAX_INT4 = 2_147_483_647;

/**
 * Exactly what `Date.prototype.toISOString` emits, which is what `encodeCursor`
 * writes. Anything else is not a marker this API produced, so it is rejected
 * rather than guessed at.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(parts.join("|"), "utf8").toString("base64url");
}

export function rejectCursor(raw: unknown): never {
  throw new ProofRelayError("VALIDATION_FAILED", "cursor is not a page marker from this endpoint", {
    detail: { cursor: typeof raw === "string" ? raw.slice(0, 120) : null },
  });
}

export function decodeCursor(raw: string | undefined, fields: number): string[] | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length !== fields) rejectCursor(raw);
  return parts;
}

/** A timestamp both JS and `timestamptz` read the same way, or a 400. */
export function cursorTimestamp(value: string | undefined, raw: unknown): string {
  if (!value || !ISO_INSTANT.test(value) || Number.isNaN(new Date(value).getTime())) {
    rejectCursor(raw);
  }
  return value;
}

/**
 * A non-negative integer that fits the column. `bits` is 64 for `block_number`
 * and 32 for `log_index`; both are compared as SQL integers, and a value past
 * the width is a bad cursor rather than a server fault.
 */
export function cursorInteger(value: string | undefined, bits: 32 | 64, raw: unknown): number {
  if (!value || !/^\d{1,20}$/.test(value)) rejectCursor(raw);
  const parsed = BigInt(value as string);
  if (bits === 64 ? parsed > MAX_INT8 : parsed > BigInt(MAX_INT4)) rejectCursor(raw);
  // Safe to narrow: block heights and log indexes are far below 2^53, and the
  // bound above is what keeps a hand-edited value from reaching the column.
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) rejectCursor(raw);
  return Number(parsed);
}
