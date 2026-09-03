import type { ArtifactKind } from "@proofrelay/schemas";

export interface StoredObject {
  /** keccak256 of the canonical bytes, as `0x…` — this is what goes onchain. */
  hash: `0x${string}`;
  /** Content-addressed id (bare hex) used as the local filename. */
  objectId: string;
  /** Retrieval hint: `local://<objectId>` or `0g://0x<merkleRoot>`. Never the integrity mechanism. */
  pointer: string;
  kind: ArtifactKind | string;
  byteLength: number;
  driver: string;
  /** 0G Storage merkle root, when the object went to 0G. */
  rootHash?: string | undefined;
  /** Upload transaction on the storage flow contract, when there was one. */
  txHash?: string | undefined;
  latencyMs: number;
  /** true when the object was already present and no upload was needed. */
  deduplicated: boolean;
}

export interface FetchedObject {
  bytes: Buffer;
  /** Recomputed from the bytes actually received, never trusted from metadata. */
  hash: `0x${string}`;
  pointer: string;
  source: "storage" | "cache" | "gateway";
  kind: string | null;
}

export interface DependencyHealth {
  ok: boolean;
  detail: string | null;
  latencyMs: number | null;
}

export interface StorageAdapter {
  readonly driver: string;
  /** Serialises canonically, hashes, uploads, and returns the pointer. Idempotent. */
  put(kind: ArtifactKind | string, value: unknown): Promise<StoredObject>;
  putBytes(kind: ArtifactKind | string, bytes: Buffer): Promise<StoredObject>;
  /** Accepts a pointer, a `0x…` hash or a bare object id. */
  get(reference: string): Promise<FetchedObject>;
  getJson<T = unknown>(reference: string): Promise<T>;
  has(reference: string): Promise<boolean>;
  health(): Promise<DependencyHealth>;
}

export function parsePointer(reference: string): { scheme: string; id: string } {
  const match = /^([a-z0-9]+):\/\/(.+)$/i.exec(reference.trim());
  if (match?.[1] && match[2]) return { scheme: match[1].toLowerCase(), id: match[2] };
  return { scheme: "hash", id: reference.trim() };
}

export function localPointer(objectId: string): string {
  return `local://${objectId}`;
}

export function zerogPointer(rootHash: string): string {
  const root = rootHash.startsWith("0x") ? rootHash : `0x${rootHash}`;
  return `0g://${root}`;
}
