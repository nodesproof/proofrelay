import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  ProofRelayError,
  bareHex,
  bytesObjectHash,
  canonicalBytes,
  keccakHex,
  type ArtifactKind,
} from "@proofrelay/schemas";
import {
  localPointer,
  parsePointer,
  type DependencyHealth,
  type FetchedObject,
  type StorageAdapter,
  type StoredObject,
} from "./types.js";

/** A stored object is addressed by its content hash and nothing else. */
const OBJECT_ID = /^[0-9a-f]{64}$/;

/**
 * Filesystem content-addressed store.
 *
 * Layout matches the artifacts already on disk from the previous run —
 * `<root>/<aa>/<bb>/<keccak256>.json` beside a `.meta.json` holding kind and size —
 * so an existing `.proofrelay/storage` directory stays readable.
 *
 * This is the driver the tests run against and the one that keeps a demo alive
 * when 0G Storage is unreachable. It provides availability, not trust: integrity
 * still comes from the hash the contract holds.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly driver = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(objectId: string): string {
    const id = bareHex(objectId);
    // Pointers are attacker-supplied: `revealReport` and `createTask` both take
    // the pointer string straight from the caller and the indexer hands it here
    // unchanged, so `local://../../../../etc/passwd` would otherwise reach
    // readFile. bareHex only strips prefixes and lowercases — it validates
    // nothing — so the content-address shape has to be enforced here, at the one
    // place every read and write resolves a path.
    if (!OBJECT_ID.test(id)) {
      throw new ProofRelayError("VALIDATION_FAILED", "pointer is not a content address", {
        detail: { objectId: id.slice(0, 80), expected: "64 lowercase hex characters" },
      });
    }
    const path = join(this.root, id.slice(0, 2), id.slice(2, 4), `${id}.json`);
    // Belt and braces: the regex is the policy, this is the backstop that keeps
    // any future change to it from turning into a filesystem escape.
    if (!resolve(path).startsWith(resolve(this.root) + sep)) {
      throw new ProofRelayError("VALIDATION_FAILED", "pointer resolves outside the object store", {
        detail: { objectId: id.slice(0, 80) },
      });
    }
    return path;
  }

  async put(kind: ArtifactKind | string, value: unknown): Promise<StoredObject> {
    return this.putBytes(kind, canonicalBytes(value));
  }

  async putBytes(kind: ArtifactKind | string, bytes: Buffer): Promise<StoredObject> {
    const started = Date.now();
    const id = keccakHex(bytes);
    const path = this.pathFor(id);
    let deduplicated = true;
    try {
      await stat(path);
    } catch {
      deduplicated = false;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      await writeFile(
        `${path}.meta.json`,
        `${JSON.stringify({ kind, byteLength: bytes.byteLength }, null, 2)}\n`,
      );
    }
    return {
      hash: `0x${id}`,
      objectId: id,
      pointer: localPointer(id),
      kind,
      byteLength: bytes.byteLength,
      driver: this.driver,
      latencyMs: Date.now() - started,
      deduplicated,
    };
  }

  async get(reference: string): Promise<FetchedObject> {
    const { id } = parsePointer(reference);
    const objectId = bareHex(id);
    const path = this.pathFor(objectId);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new ProofRelayError("ARTIFACT_NOT_FOUND", `no local object ${objectId}`, {
        cause: error,
        detail: { reference },
      });
    }
    let kind: string | null = null;
    try {
      kind = JSON.parse(await readFile(`${path}.meta.json`, "utf8")).kind ?? null;
    } catch {
      kind = null;
    }
    return {
      bytes,
      hash: bytesObjectHash(bytes),
      pointer: localPointer(objectId),
      source: "storage",
      kind,
    };
  }

  async getJson<T = unknown>(reference: string): Promise<T> {
    const { bytes } = await this.get(reference);
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  async has(reference: string): Promise<boolean> {
    try {
      await stat(this.pathFor(bareHex(parsePointer(reference).id)));
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      await mkdir(this.root, { recursive: true });
      const probe = canonicalBytes({ probe: "storage-health" });
      await this.putBytes("source-snapshot", probe);
      return {
        ok: true,
        detail: `${this.root} -> writable`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return { ok: false, detail: String((error as Error).message), latencyMs: Date.now() - started };
    }
  }
}
