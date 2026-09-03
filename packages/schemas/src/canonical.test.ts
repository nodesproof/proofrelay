import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalBytes, canonicalString, contentHash, objectHash, objectId, sha256Hex } from "./canonical.js";

const STORAGE = new URL("../../../.proofrelay/storage", import.meta.url).pathname;

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(walk(path));
    else if (path.endsWith(".json") && !path.endsWith(".meta.json")) out.push(path);
  }
  return out;
}

/**
 * The canonicaliser is pinned against artifacts that already exist and whose
 * hashes are already onchain. If this suite goes red, every historical object
 * has just been orphaned — that is the failure it is here to catch, and it is
 * why it asserts byte equality rather than a round trip through ourselves.
 */
describe("canonical form against the surviving 0G artifacts", () => {
  let files: string[] = [];
  try {
    files = walk(STORAGE);
  } catch {
    files = [];
  }
  const originals = files.filter((path) => {
    const raw = readFileSync(path);
    return objectId(JSON.parse(raw.toString("utf8"))) === path.split("/").pop()!.replace(".json", "");
  });

  it("finds the fixture corpus", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("re-serialises every artifact byte-for-byte", () => {
    const mismatched = originals.filter(
      (path) => !canonicalBytes(JSON.parse(readFileSync(path, "utf8"))).equals(readFileSync(path)),
    );
    expect(mismatched).toEqual([]);
    expect(originals.length).toBeGreaterThanOrEqual(42);
  });

  it("reproduces every artifact's content-addressed filename", () => {
    for (const path of originals) {
      const expected = path.split("/").pop()!.replace(".json", "");
      expect(objectId(JSON.parse(readFileSync(path, "utf8")))).toBe(expected);
    }
  });

  /**
   * A `local://` pointer IS the object hash, so it is self-verifying. A
   * `0g://` pointer is a merkle root over 256-byte sectors — a different
   * function of the same bytes — so it cannot be, and the hash has to travel
   * beside it. Asserting both halves is what stops someone "simplifying" the
   * manifest by dropping snapshotHash on the grounds that the pointer looks
   * like a hash already.
   */
  it("makes a local pointer self-verifying and a 0G pointer not", () => {
    const manifests = originals
      .map((path) => JSON.parse(readFileSync(path, "utf8")))
      .filter((value) => value.kind === "task-manifest");
    expect(manifests.length).toBeGreaterThan(0);
    let local = 0;
    let zerog = 0;
    for (const manifest of manifests) {
      for (const source of manifest.sources) {
        if (source.snapshotPointer.startsWith("local://")) {
          expect(source.snapshotPointer).toBe(`local://${source.snapshotHash.slice(2)}`);
          local += 1;
        } else {
          expect(source.snapshotPointer).toMatch(/^0g:\/\/0x[0-9a-f]{64}$/);
          expect(source.snapshotPointer.slice(5)).not.toBe(source.snapshotHash);
          zerog += 1;
        }
      }
    }
    expect(local + zerog).toBeGreaterThan(0);
  });

  it("uses sha256 for a source's contentHash, which is a different field", () => {
    const snapshots = originals
      .map((path) => JSON.parse(readFileSync(path, "utf8")))
      .filter((value) => value.kind === "source-snapshot" && value.byteLength === value.text.length);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.contentHash).toBe(contentHash(snapshot.text));
    }
  });
});

describe("canonicalisation invariants", () => {
  it("is independent of key order", () => {
    expect(canonicalString({ b: 1, a: 2 })).toBe(canonicalString({ a: 2, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalString({ a: [1, 2] })).not.toBe(canonicalString({ a: [2, 1] }));
  });

  it("minifies and preserves non-ASCII", () => {
    expect(canonicalString({ dash: "v1.4.0 — August" })).toBe('{"dash":"v1.4.0 — August"}');
  });

  it("drops undefined but keeps null", () => {
    expect(canonicalString({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("returns 0x-prefixed keccak for objectHash and bare hex for objectId", () => {
    const value = { kind: "probe", n: 1 };
    expect(objectHash(value)).toBe(`0x${objectId(value)}`);
    expect(objectHash(value)).not.toBe(`0x${sha256Hex(canonicalBytes(value))}`);
  });
});

describe("canonicalize is injective", () => {
  /**
   * On a plain object literal, assigning `__proto__` hits the inherited setter
   * and the key vanishes — so two artifacts differing only in that field
   * canonicalised to the same bytes and shared a content hash. A content hash
   * that cannot tell two documents apart is not a content hash.
   */
  it("keeps a __proto__ field instead of swallowing it", () => {
    const withField = JSON.parse('{"a":1,"__proto__":{"x":2}}') as Record<string, unknown>;
    const without = JSON.parse('{"a":1}') as Record<string, unknown>;

    expect(canonicalBytes(withField).toString("utf8")).toContain("__proto__");
    expect(objectHash(withField)).not.toBe(objectHash(without));
  });

  it("does not let a __proto__ field pollute anything", () => {
    canonicalBytes(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

