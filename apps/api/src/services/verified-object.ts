/**
 * Fetching a content-addressed object and proving it before it is served.
 *
 * Two routes need this — `GET /v1/reports/{hash}` and `GET /v1/artifacts/{hash}`
 * — and the rules they must obey are the ones worth having exactly one copy of:
 *
 * 1. **A mismatch is never served.** Not from storage, and not from the indexed
 *    copy either. `CONTENT_HASH_MISMATCH` is precisely the condition the hash
 *    exists to detect, and answering 200 with the bytes plus `verified: false`
 *    would put unverifiable content on a page whose entire purpose is
 *    verifiability.
 * 2. **A mismatch never falls through to the cache.** It is a verdict, not an
 *    outage; falling back would hide the very thing that was just detected.
 * 3. **A storage outage degrades rather than fails.** The API's own copy was
 *    only ever written after its hash checked out — and it is re-hashed here
 *    anyway, because a row that was verified on the way in can still have been
 *    corrupted since.
 *
 * A second implementation of that would be a second chance to get it wrong.
 */
import { ProofRelayError, canonicalBytes, hashesEqual, objectHash } from "@proofrelay/schemas";
import type { StorageAdapter } from "@proofrelay/storage-adapter";
import type { Logger } from "../observability.js";
import { hashMismatchError } from "../indexer/artifact-sync.js";

export interface VerifiedObject {
  body: unknown;
  /** The bytes actually proved, so a caller can report the size it served. */
  bytes: Buffer;
  source: "storage" | "cache";
}

export interface VerifiedObjectRequest {
  /** The hash the object must have, lowercased, `0x` + 64 hex. */
  hash: string;
  /** Where to look. Null is fine — every adapter accepts a bare hash. */
  pointer: string | null;
  /** The indexed copy, or null when the API has never held one. */
  cached: unknown;
  requestId: string;
  /** What to call the thing in log lines: "report", "artifact". */
  noun: string;
}

export async function fetchVerifiedObject(
  deps: { storage: StorageAdapter; logger: Logger },
  { hash, pointer, cached, requestId, noun }: VerifiedObjectRequest,
): Promise<VerifiedObject> {
  const reference = pointer ?? hash;

  try {
    const fetched = await deps.storage.get(reference);
    if (!hashesEqual(fetched.hash, hash)) {
      deps.logger.error(`${noun} body does not match its onchain hash`, {
        requestId,
        errorCode: "CONTENT_HASH_MISMATCH",
        expected: hash,
        actual: fetched.hash,
        pointer: reference,
      });
      throw hashMismatchError(hash, fetched.hash, pointer);
    }
    return {
      body: JSON.parse(fetched.bytes.toString("utf8")),
      bytes: fetched.bytes,
      source: "storage",
    };
  } catch (error) {
    if (error instanceof ProofRelayError && error.code === "CONTENT_HASH_MISMATCH") throw error;
    if (cached === null) throw error;

    const actual = objectHash(cached);
    if (!hashesEqual(actual, hash)) {
      deps.logger.error(`indexed ${noun} copy does not match its onchain hash`, {
        requestId,
        errorCode: "CONTENT_HASH_MISMATCH",
        expected: hash,
        actual,
      });
      throw hashMismatchError(hash, actual, pointer);
    }

    deps.logger.warn(`serving the indexed ${noun} copy`, {
      requestId,
      errorCode: "STORAGE_UNAVAILABLE",
      hash,
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    });
    // Re-serialised rather than remembered: this is the byte string the hash
    // above was computed over, so the length reported to the caller describes
    // what was actually proved.
    return { body: cached, bytes: canonicalBytes(cached), source: "cache" };
  }
}
