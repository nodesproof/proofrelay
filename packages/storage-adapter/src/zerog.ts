import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { ethers } from "ethers";
import {
  ProofRelayError,
  bareHex,
  bytesObjectHash,
  canonicalBytes,
  keccakHex,
  withRetry,
  type ArtifactKind,
} from "@proofrelay/schemas";
import { LocalStorageAdapter } from "./local.js";
import {
  parsePointer,
  zerogPointer,
  type DependencyHealth,
  type FetchedObject,
  type StorageAdapter,
  type StoredObject,
} from "./types.js";

/**
 * The 0G SDK writes progress straight to console.log — node selection, segment
 * counts, sync polling — with no hook to redirect it. Left alone it interleaves
 * with the services' structured JSON logs and makes them unparseable, so SDK
 * calls run with console captured and the output re-emitted as one structured
 * line at debug level. Set STORAGE_SDK_LOGS=1 to watch it raw.
 */
/** Depth of the console swap above, so nested calls do not restore each other's. */
let swapDepth = 0;

async function quietly<T>(fn: () => Promise<T>, sink: (lines: string[]) => void): Promise<T> {
  if (process.env.STORAGE_SDK_LOGS === "1") return fn();
  // Reentrancy guard. Two concurrent storage calls both swapped console and both
  // restored what they saw on the way in — the second captured the FIRST call's
  // collector as "the original" and put that back, so every later console.log in
  // the process went into an array nobody reads. The API's own logging simply
  // stopped. Only the outermost call swaps; the inner ones share its capture.
  if (swapDepth > 0) {
    swapDepth += 1;
    try {
      return await fn();
    } finally {
      swapDepth -= 1;
    }
  }

  const captured: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
  swapDepth = 1;
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      // The SDK logs its options object, which carries a bigint fee.
      return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const collect = (...args: unknown[]) => {
    captured.push(args.map(render).join(" "));
  };
  console.log = collect;
  console.info = collect;
  console.debug = collect;
  try {
    return await fn();
  } finally {
    swapDepth = 0;
    Object.assign(console, original);
    if (captured.length) sink(captured);
  }
}

export interface ZeroGStorageOptions {
  indexerRpc: string;
  rpcUrl: string;
  privateKey: `0x${string}`;
  /** Every upload is mirrored here so a gateway outage degrades to a cache read. */
  cacheRoot: string;
  expectedReplica?: number;
  gateways?: string[];
  /** Wait for finality before returning. Off makes a demo feel fast and a read racy. */
  finalityRequired?: boolean;
  /** Where the SDK's captured console output goes. */
  onSdkLog?: (lines: string[]) => void;
  /**
   * Refuse an object larger than this rather than materialise it. Every
   * artifact this system produces is bounded — a manifest, a report, or at most
   * 20 snapshots of FETCH_MAX_BYTES — but a pointer is attacker-supplied and
   * can name a blob of any size that someone else uploaded.
   */
  maxObjectBytes?: number;
  /** Deadline for a download or a health probe. */
  readTimeoutMs?: number;
  /** Deadline for an upload, which waits on storage finality and is far slower. */
  uploadTimeoutMs?: number;
}

export const DEFAULT_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;

/**
 * The SDK has no timeout of its own and its finality wait is an unbounded loop,
 * so a lagging storage node holds a request open forever — on a public testnet
 * that is the normal failure, not an exotic one. Racing a timer turns it into a
 * STORAGE_* error the existing retry and mapping machinery already understands.
 *
 * The race must sit outside quietly(), or the console it swapped is never put
 * back and every later log line disappears.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProofRelayError("STORAGE_UNAVAILABLE", `${what} timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 0G Storage driver, on @0gfoundation/0g-storage-ts-sdk.
 *
 * Two things are worth knowing about the pointer it produces. First, the
 * pointer carries 0G's merkle root over 256-byte sectors, which is NOT the
 * keccak256 the contract holds — the contract stores a hash over canonical
 * bytes, and the pointer only helps retrieval. The two are different functions
 * of the same object, so a pointer can never stand in for the hash. Second, every upload is mirrored into a local content-addressed
 * cache, because the pointer is an availability promise while the hash is the
 * integrity one: if the gateway is down we can still serve bytes and still
 * prove they are the right bytes.
 */
export class ZeroGStorageAdapter implements StorageAdapter {
  readonly driver = "zerog";
  private readonly indexer: Indexer;
  private readonly signer: ethers.Wallet;
  private readonly cache: LocalStorageAdapter;
  private readonly options: ZeroGStorageOptions;
  /** object id -> 0G root, so re-putting identical bytes does not pay twice. */
  private readonly roots = new Map<string, string>();

  constructor(options: ZeroGStorageOptions) {
    this.options = options;
    this.indexer = new Indexer(options.indexerRpc);
    const provider = new ethers.JsonRpcProvider(options.rpcUrl);
    this.signer = new ethers.Wallet(options.privateKey, provider);
    this.cache = new LocalStorageAdapter(options.cacheRoot);
  }

  async put(kind: ArtifactKind | string, value: unknown): Promise<StoredObject> {
    return this.putBytes(kind, canonicalBytes(value));
  }

  async putBytes(kind: ArtifactKind | string, bytes: Buffer): Promise<StoredObject> {
    const started = Date.now();
    const objectId = keccakHex(bytes);
    const local = await this.cache.putBytes(kind, bytes);

    const known = this.roots.get(objectId);
    if (known) {
      return {
        ...local,
        pointer: zerogPointer(known),
        rootHash: known,
        driver: this.driver,
        latencyMs: Date.now() - started,
        deduplicated: true,
      };
    }

    const uploaded = await withRetry(
      async () =>
        withDeadline(
        quietly(async () => {
        const file = new MemData(new Uint8Array(bytes));
        const [tree, treeError] = await file.merkleTree();
        if (treeError || !tree) throw wrap(treeError, "could not build the merkle tree");
        const localRoot = tree.rootHash() ?? "";

        const [result, uploadError] = await this.indexer.upload(
          file,
          this.options.rpcUrl,
          // The SDK's declarations resolve ethers through its own module copy,
          // so TypeScript sees two nominally distinct Signer types for one object.
          this.signer as never,
          {
            expectedReplica: this.options.expectedReplica ?? 1,
            finalityRequired: this.options.finalityRequired ?? true,
            // Identical bytes already stored are a hit, not a re-upload: every
            // object here is content-addressed, so a second put is a no-op.
            skipIfFinalized: true,
          },
          // Galileo's suggested gas price is sometimes under what the mempool
          // takes. One bump is cheaper than losing an upload that already paid
          // the storage fee.
          { Retries: 3, Interval: 3, MaxGasPrice: 60_000_000_000 },
        );

        if (uploadError) {
          if (/already exist|data already|duplicate|finalized/i.test(String(uploadError.message ?? uploadError))) {
            return { rootHash: localRoot, txHash: "", existed: true };
          }
          throw wrap(uploadError, "0G Storage upload failed");
        }

        const single = result as { txHash?: string; rootHash?: string };
        const multi = result as { txHashes?: string[]; rootHashes?: string[] };
        return {
          rootHash: single.rootHash ?? multi.rootHashes?.[0] ?? localRoot,
          txHash: single.txHash ?? multi.txHashes?.[0] ?? "",
          existed: false,
        };
        }, this.options.onSdkLog ?? (() => undefined)),
          this.uploadTimeoutMs,
          "0G Storage upload",
        ),
      { attempts: 3, baseDelayMs: 1_500, shouldRetry: () => true },
    ).catch((error) => {
      throw new ProofRelayError("STORAGE_UPLOAD_FAILED", "0G Storage upload failed after 3 attempts", {
        cause: error,
        detail: { objectId, message: String((error as Error).message).slice(0, 400) },
      });
    });

    const root = bareHex(uploaded.rootHash);
    if (root) this.roots.set(objectId, root);

    return {
      hash: `0x${objectId}`,
      objectId,
      pointer: root ? zerogPointer(root) : local.pointer,
      kind,
      byteLength: bytes.byteLength,
      driver: this.driver,
      rootHash: root || undefined,
      txHash: uploaded.txHash || undefined,
      latencyMs: Date.now() - started,
      deduplicated: uploaded.existed,
    };
  }

  async get(reference: string): Promise<FetchedObject> {
    const { scheme, id } = parsePointer(reference);
    if (scheme === "local" || scheme === "hash") return this.cache.get(reference);

    const root = id.startsWith("0x") ? id : `0x${id}`;

    try {
      const [blob, error] = await withRetry(
        () =>
          withDeadline(
            quietly(
              () => this.indexer.downloadToBlob(root),
              this.options.onSdkLog ?? (() => undefined),
            ),
            this.readTimeoutMs,
            "0G Storage download",
          ),
        { attempts: 3, baseDelayMs: 800, shouldRetry: () => true },
      );
      if (error) throw wrap(error, "0G Storage download failed");
      // Checked before arrayBuffer(), which is what actually copies it into the
      // heap of every process that reads artifacts — the API and both workers.
      this.assertWithinCap(blob.size, root);
      const bytes = Buffer.from(await blob.arrayBuffer());
      this.assertWithinCap(bytes.byteLength, root);
      return {
        bytes,
        hash: bytesObjectHash(bytes),
        pointer: zerogPointer(root),
        source: "storage",
        kind: null,
      };
    } catch (indexerError) {
      for (const gateway of this.options.gateways ?? []) {
        try {
          const bytes = await this.downloadFromGateway(gateway, root);
          return {
            bytes,
            hash: bytesObjectHash(bytes),
            pointer: zerogPointer(root),
            source: "gateway",
            kind: null,
          };
        } catch {
          /* try the next gateway */
        }
      }
      // Last resort: our own mirror. The caller still checks the hash, so a
      // cache hit cannot launder wrong bytes — it only survives an outage.
      const cached = await this.cacheByRoot(root);
      if (cached) return cached;
      throw new ProofRelayError("STORAGE_UNAVAILABLE", `could not retrieve ${reference}`, {
        cause: indexerError,
        detail: { reference, message: String((indexerError as Error).message).slice(0, 300) },
      });
    }
  }

  private async cacheByRoot(root: string): Promise<FetchedObject | null> {
    for (const [id, knownRoot] of this.roots) {
      if (bareHex(knownRoot) !== bareHex(root)) continue;
      try {
        const hit = await this.cache.get(id);
        return { ...hit, source: "cache", pointer: zerogPointer(root) };
      } catch {
        return null;
      }
    }
    return null;
  }

  private async downloadFromGateway(gateway: string, root: string): Promise<Buffer> {
    const url = `${gateway.replace(/\/+$/, "")}/file?root=${root}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.readTimeoutMs) });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);

    // A gateway is an untrusted mirror named by an attacker-supplied pointer, so
    // the body is counted as it arrives and abandoned at the cap rather than
    // buffered whole by arrayBuffer().
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > 0) this.assertWithinCap(declared, root);
    if (!response.body) return Buffer.alloc(0);

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      this.assertWithinCap(total, root);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }

  private get maxObjectBytes(): number {
    return this.options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  private get readTimeoutMs(): number {
    return this.options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  }

  private get uploadTimeoutMs(): number {
    return this.options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  private assertWithinCap(byteLength: number, root: string): void {
    if (byteLength <= this.maxObjectBytes) return;
    throw new ProofRelayError("VALIDATION_FAILED", "stored object is larger than the cap", {
      detail: { root, byteLength, maxObjectBytes: this.maxObjectBytes },
    });
  }

  async getJson<T = unknown>(reference: string): Promise<T> {
    const { bytes } = await this.get(reference);
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  async has(reference: string): Promise<boolean> {
    try {
      await this.get(reference);
      return true;
    } catch {
      return false;
    }
  }

  /** Remember a pointer discovered elsewhere (an event, the read model). */
  rememberRoot(objectId: string, rootHash: string): void {
    const key = bareHex(objectId);
    const root = bareHex(rootHash);
    if (key && root) this.roots.set(key, root);
  }

  async health(): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      const nodes = await withDeadline(
        quietly(
          () => this.indexer.getShardedNodes(),
          this.options.onSdkLog ?? (() => undefined),
        ),
        this.readTimeoutMs,
        "0G Storage health probe",
      );
      const count = (nodes?.trusted?.length ?? 0) + (nodes?.discovered?.length ?? 0);
      const balance = await this.signer.provider!.getBalance(this.signer.address);
      const ok = count > 0 && balance > 0n;
      return {
        ok,
        detail: ok
          ? `${host(this.options.indexerRpc)} -> ${count} nodes, wallet ${ethers.formatEther(balance)} 0G`
          : count === 0
            ? `${host(this.options.indexerRpc)} -> no storage nodes available`
            : `storage wallet ${this.signer.address} has no balance; uploads will fail`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `${host(this.options.indexerRpc)} -> ${String((error as Error).message).slice(0, 160)}`,
        latencyMs: Date.now() - started,
      };
    }
  }
}

function wrap(error: unknown, message: string): Error {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return new Error(detail ? `${message}: ${detail}` : message);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
