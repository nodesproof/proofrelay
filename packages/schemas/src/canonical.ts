/**
 * Canonical serialisation and content addressing.
 *
 * Architecture doc §10.2: the hash a contract stores is computed over canonical
 * bytes, never over a UI rendering. Two artifacts that differ only in key order
 * or whitespace must produce the same hash, so every object is serialised with
 * its keys sorted recursively, minified, before hashing.
 *
 * The digest is keccak256, not sha256. That is not a style choice — it is
 * pinned by the 42 artifacts already in `.proofrelay/storage/`, whose filenames
 * are keccak256 of exactly these bytes (all 42 reproduce), and by the manifests
 * themselves, which record the same hex as both `snapshotPointer: "local://<hex>"`
 * and `snapshotHash: "0x<hex>"`. Changing the digest would orphan every existing
 * artifact and every hash already written onchain.
 *
 * Note the deliberate second hash function below. `contentHash` is sha256 and
 * covers the bytes fetched from a *source*; it is a different field with a
 * different job, and the artifacts carry it prefixed `sha256:` to say so.
 */
import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Recursively sort object keys. Arrays keep their order — it is meaningful. */
export function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return value;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    // `Object.create(null)`, so `__proto__` is an ordinary own property rather
    // than a setter that swallows the assignment. On a normal object literal the
    // key vanished, which made canonicalisation NON-INJECTIVE: two artifacts
    // differing only in a `__proto__` field hashed identically, and a content
    // hash that cannot tell two documents apart is not a content hash.
    const out = Object.create(null) as Record<string, Json>;
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

/**
 * Canonical JSON bytes: sorted keys, minified, non-ASCII left as UTF-8.
 *
 * Written as an explicit serialiser rather than `JSON.stringify(x, sortedKeys)`
 * so the byte layout is stated here and cannot drift with a runtime's
 * replacer semantics.
 */
export function canonicalString(value: unknown): string {
  return serialize(canonicalize(value));
}

function serialize(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value)
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as Json)}`)
    .join(",")}}`;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalString(value), "utf8");
}

export function keccakHex(bytes: Buffer | Uint8Array | string): string {
  const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return Buffer.from(keccak_256(input)).toString("hex");
}

/** sha256 of raw bytes. Used for source content, never for object addressing. */
export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `sha256:<hex>` — the form artifacts use for fetched source bytes. */
export function contentHash(bytes: Buffer | Uint8Array | string): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** `0x<hex>` — the form stored onchain as bytes32. */
export function objectHash(value: unknown): `0x${string}` {
  return `0x${keccakHex(canonicalBytes(value))}` as `0x${string}`;
}

/** The content-addressed id an artifact is stored under (bare hex, no 0x). */
export function objectId(value: unknown): string {
  return keccakHex(canonicalBytes(value));
}

/** Address raw bytes that were not produced by canonicalising an object. */
export function bytesObjectHash(bytes: Buffer | Uint8Array): `0x${string}` {
  return `0x${keccakHex(bytes)}` as `0x${string}`;
}

/** Strip a `sha256:` or `0x` prefix, returning bare lowercase hex. */
export function bareHex(hash: string): string {
  return hash.replace(/^sha256:/, "").replace(/^0x/, "").toLowerCase();
}

/** True when two hashes refer to the same bytes regardless of prefix style. */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return bareHex(a) === bareHex(b);
}
