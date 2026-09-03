I have completed live, end-to-end verification against 0G Galileo. Here is the report.

---

# 0G Storage Integration Report — ProofRelay

**Researched, executed and verified on 2026‑09‑02 against the live 0G Galileo testnet (chainId 16602).**
Every claim below is either quoted from `docs.0g.ai` / the npm registry, or was **executed** — including a real paid upload. Facts I could not verify are labelled as such.

**Headline result — a real round trip completed:**

| | |
|---|---|
| Uploaded object | 492‑byte canonical ProofRelay `source-snapshot` JSON |
| 0G root hash | `0x33a7ade582563d55284a3740b1bfeb2fd2cc512a0b1bbaa12cd02e27b18bee8f` |
| Tx hash | `0x734fe9fad8d0e955df4360d823305f2aab0e7168667d76dd0c2b1a9fd412006c` |
| txSeq | `148961` |
| Wall clock | **11 678 ms** (submit → finality → segment upload → finalized) |
| Gas | **427 733** @ 4.000000007 gwei = **0.001710932 0G** |
| Storage fee (`msg.value`) | **61 467 289 924 wei = 0.0000000615 0G** (2 sectors) |
| Read back (SDK, `proof:true`) | byte‑identical ✅ |
| Read back (plain `fetch` gateway) | byte‑identical ✅ |
| Re‑upload of same bytes | 858 ms, **0 wei spent**, `txHash: ""` ✅ (idempotent) |

Signer used: `0xA7d6b126D6dCbc75319f7c1B7B43524Cc791E02D` (the repo's already‑funded `STORAGE_PRIVATE_KEY`, balance 0.383 0G, nonce 48 → 49).

---

## 0. Three corrections to the brief, evidenced

Before the answers, three assumptions in the task are wrong and would have shipped as bugs.

### 0.1 The package to use is neither of the two candidates

Both candidates exist, both are **deprecated**. The live package is a *third* name.

```
@0glabs/0g-ts-sdk            0.3.3   published 2025-10-22
  deprecated: "Package no longer supported."
@0gfoundation/0g-ts-sdk      1.2.8   published 2026-04-30
  deprecated: "This package has moved. Please use @0gfoundation/0g-storage-ts-sdk instead."
@0gfoundation/0g-storage-ts-sdk  1.2.11  published 2026-08-06   <-- USE THIS, not deprecated
```

### 0.2 The surviving artifacts are addressed by **keccak256**, not sha256

The brief says `local://<sha256>`. I hashed all 42 surviving artifact bodies:

```
matched 42/42  ->  KECCAK256
```

`sha256` matched **zero** of them. The `sha256:` prefix that appears *inside* artifacts (`contentHash: "sha256:60be539c…"`) is the hash of the **fetched source text**, a different field entirely. The store address / pointer / on‑chain `bytes32` is keccak256.

I reconstructed the exact canonicalizer and it reproduces all 42 files **byte for byte**:

```js
const canon = (v) =>
  Array.isArray(v)              ? '[' + v.map(canon).join(',') + ']'
: (v && typeof v === 'object')  ? '{' + Object.keys(v).sort()
                                        .map(k => JSON.stringify(k) + ':' + canon(v[k]))
                                        .join(',') + '}'
:                                 JSON.stringify(v);

// verified: 42/42 byte-identical, 42/42 keccak256 == filename
```

So: `objectHash = keccak256(utf8(canon(obj)))`, pointer = `local://` + that hex **without** `0x`, on‑chain `manifestHash`/`reportHash` = the same hex **with** `0x`. Confirmed by cross‑reference: a manifest carries `snapshotPointer: "local://47395b6d…"` and `snapshotHash: "0x47395b6d…"` — identical hex.

### 0.3 `0g://` is unattested in the surviving data, and it is *not* a content hash

All 57 pointer occurrences across the 84 files are `local://`. **Zero** `0g://`. The frontend mock (`proofrelay-frontend/client/src/pages/Artifacts.tsx`) invents a third, incompatible shape: `0g://storage/7b1d…a32f`. That must be changed.

Critically: `local://<hex>` **is** the content hash (self‑verifying), but `0g://0x<root>` is a **Merkle root over 256‑byte sectors** — a completely different function of the bytes. Verified: for my 492‑byte object, `objectHash = 0x173dbc41…` while `root = 0x33a7ade5…`. The pointer therefore **cannot** verify the content, and `objectHash` must travel alongside it. This is exactly what `ARCHITECTURE.md` demands ("Pointer string tidak boleh menjadi satu-satunya integrity mechanism").

---

## 1. Package name and current version

| Field | Value |
|---|---|
| **Package** | `@0gfoundation/0g-storage-ts-sdk` |
| **Latest** | `1.2.11` (published 2026‑08‑06T15:19:59Z) |
| Version history | 1.2.8 (2026‑04‑30), 1.2.9 (2026‑05‑05), 1.2.10 (2026‑06‑04), 1.2.11 (2026‑08‑06) |
| Weekly downloads | 1 337 (vs 492 / 607 for the two deprecated names) |
| Repo | `git+https://github.com/0gfoundation/0g-storage-ts-sdk.git` |
| License | ISC |
| **peerDependencies** | `{ "ethers": "6.13.1" }` — **an exact pin, not a range** |
| dependencies | `@noble/curves ^1.9.7`, `@noble/hashes ^1.8.0`, `@noble/ciphers ^1.3.0`, `@ethersproject/bytes ^5.7.0`, `@ethersproject/keccak256 ^5.7.0`, `open-jsonrpc-provider ^0.2.1` |
| `engines` | **absent** (see §4) |
| main / module / types | `./lib.commonjs/index.js` / `./lib.esm/index.js` / `./types/index.d.ts` |

Docs confirm the name: *"npm install @0gfoundation/0g-storage-ts-sdk ethers"* — [Storage SDK | 0G Documentation](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk).

### 1.1 ethers: **v6 only, and the pin is enforced by npm**

`ethers` **v5 will not work at all** — the SDK's own code uses `ethers.JsonRpcProvider`, `ZeroAddress`, `Signer`, `contract.getFunction(...).send(...)`, all v6‑only APIs. (`@ethersproject/bytes` and `@ethersproject/keccak256` are v5 *sub*packages bundled as ordinary deps for Merkle math — they do not imply v5 compatibility.)

Verified npm behaviour with any ethers other than `6.13.1`:

```
npm error peer ethers@"6.13.1" from @0gfoundation/0g-storage-ts-sdk@1.2.11
npm error Fix the upstream dependency conflict, or retry
npm error this command with --force or --legacy-peer-deps
```

I then forced `ethers@6.17.0` with `--legacy-peer-deps` and the SDK **worked at runtime** (indexer RPC, contract binding, Merkle root all fine). But do not rely on that — **pin `ethers@6.13.1` exactly**:

```jsonc
// package.json
"dependencies": {
  "@0gfoundation/0g-storage-ts-sdk": "1.2.11",
  "ethers": "6.13.1",
  "tslib": "^2.8.1"        // see §4.3 — do not omit
}
```

---

## 2. Import surface and complete working code

### 2.1 Full export surface (enumerated at runtime, not from docs)

```
Batcher, Blob, DEFAULT_BATCH_SIZE, DEFAULT_CHUNK_SIZE, DEFAULT_SEGMENT_MAX_CHUNKS,
DEFAULT_SEGMENT_SIZE, Downloader, ECIES_HEADER_SIZE, ECIES_VERSION, EMPTY_CHUNK,
EMPTY_CHUNK_HASH, EPHEMERAL_PUBKEY_SIZE, EncryptedFile, EncryptedFileFragment,
EncryptionHeader, FixedPriceFlow__factory, GetSplitNum, HotRouterClient, Indexer,
KvClient, KvIterator, LeafNode, MAX_KEY_SIZE, MAX_QUERY_SIZE, MAX_SET_SIZE, MemData,
MerkleTree, Proof, ProofErrors, SMALL_FILE_SIZE_THRESHOLD, STREAM_DOMAIN,
SYMMETRIC_HEADER_SIZE, SYMMETRIC_VERSION, SegmentRange, StorageKv, StorageNode,
StreamData, StreamDataBuilder, TIMEOUT_MS, Uploader, ZERO_HASH, ZgFile, calculatePrice,
checkExist, checkReplica, computePaddedSize, cryptAt, decryptFile, decryptFragmentData,
defaultUploadOption, delay, deriveEciesDecryptKey, deriveEciesEncryptKey, factories,
getFlowContract, getMarketContract, getShardConfigs, insert, isValidConfig,
iteratorPaddedSize, mergeUploadOptions, newEciesEncryptedFile, newEciesHeader,
newSymmetricEncryptedFile, newSymmetricHeader, nextPow2, nodeForSegment,
normalizePrivKey, normalizePubKey, numSplits, parseEncryptionHeader, pushdown,
resolveDecryptionKey, selectNodes, tryDecrypt, tryDecryptFragments, txWithGasAdjustment
```

**`RetryOpts` is NOT exported** from the package root — `types/index.d.ts` re‑exports `common/transfer/indexer/kv/node/file/hot/contracts/utils/constant` but **not** `./types.js`. `import type { RetryOpts }` fails with `TS2305`. Declare it locally.

### 2.2 Exact signatures (from `types/indexer/Indexer.d.ts`, v1.2.11)

```ts
export declare class Indexer extends HttpProvider {
  constructor(url: string);                         // ONE argument. Flow contract is auto-discovered.

  getShardedNodes(): Promise<ShardedNodes>;
  getNodeLocations(): Promise<Map<string, IpLocation>>;
  getFileLocations(rootHash: string): Promise<ShardedNode[]>;
  selectNodes(expectedReplica: number, method?: 'min'|'max'|'random'): Promise<[StorageNode[], Error|null]>;

  upload(
    file: AbstractFile,
    blockchain_rpc: string,          // NOTE: a URL string, NOT the provider object
    signer: Signer,
    uploadOpts?: UploadOption,
    retryOpts?: RetryOpts,
    opts?: TransactionOptions,       // { gasPrice?: bigint; gasLimit?: bigint }
  ): Promise<[
    { txHash: string; rootHash: string; txSeq: number }              // single (<= fragmentSize)
    | { txHashes: string[]; rootHashes: string[]; txSeqs: number[] } // fragmented (> 4 GB)
    , Error | null
  ]>;

  download(rootHash: string,    filePath: string, proof?: boolean): Promise<Error|null>;  // Node only (fs)
  download(rootHashes: string[],filePath: string, proof?: boolean): Promise<Error|null>;
  downloadToBlob(rootHash: string,     opts?: DownloadOption): Promise<[Blob, Error|null]>; // Node+browser
  downloadToBlob(rootHashes: string[], opts?: DownloadOption): Promise<[Blob, Error|null]>;
  peekHeader(rootHash: string): Promise<[EncryptionHeader|null, Error|null]>;
}

export interface UploadOption {
  tags?: BytesLike; submitter?: string; finalityRequired?: boolean;
  taskSize?: number; expectedReplica?: number; fragmentSize?: number;
  skipTx?: boolean; skipIfFinalized?: boolean; fee?: bigint; nonce?: bigint;
  onProgress?: (message: string) => void;
  encryption?: { type:'aes256'; key: Uint8Array } | { type:'ecies'; recipientPubKey: Uint8Array|string };
}
export interface DownloadOption {
  proof?: boolean;
  decryption?: { symmetricKey?: Uint8Array|string; privateKey?: Uint8Array|string };
}
type RetryOpts = { Retries: number; Interval: number; MaxGasPrice: number; TooManyDataRetries?: number };
// ^ PascalCase is mandatory. Interval is in SECONDS, not ms.
```

Runtime‑verified `defaultUploadOption`:

```js
{ tags:'0x', submitter:'', finalityRequired:true, taskSize:1, expectedReplica:1,
  fragmentSize:4294967296, skipTx:false, skipIfFinalized:true, fee:0n }
```

Runtime‑verified constants:

```
DEFAULT_CHUNK_SIZE         = 256        // "sector"; the billing unit
DEFAULT_SEGMENT_MAX_CHUNKS = 1024
DEFAULT_SEGMENT_SIZE       = 262144     // 256 KiB
SMALL_FILE_SIZE_THRESHOLD  = 262144
TIMEOUT_MS                 = 3000000
ZERO_HASH                  = 0x0000…0000
EMPTY_CHUNK_HASH           = 0xd397b3b043d87fcd6fad1291ff0bfd16401c274896d8c63a923727f077b8e0b5
```

### 2.3 Complete working example — this is the exact file I ran

Every line below executed successfully; the console output is reproduced under §2.4.

```ts
// og-e2e.ts   —  node --import tsx og-e2e.ts     (or plain .mjs, as I ran it)
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers, keccak256, toUtf8Bytes } from 'ethers';

const RPC_URL     = 'https://evmrpc-testnet.0g.ai';                     // chainId 16602 (0x40da) — verified live
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';      // turbo. standard is 503, see §5.4

type RetryOpts = { Retries: number; Interval: number; MaxGasPrice: number; TooManyDataRetries?: number };

/** ProofRelay canonical JSON — reproduces all 42 surviving artifacts byte-for-byte. */
const canon = (v: unknown): string =>
  Array.isArray(v)             ? '[' + v.map(canon).join(',') + ']'
: (v && typeof v === 'object') ? '{' + Object.keys(v as object).sort()
                                       .map(k => JSON.stringify(k) + ':' + canon((v as any)[k]))
                                       .join(',') + '}'
:                                JSON.stringify(v);

// ─── 1. provider + signer wiring (ethers v6) ────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer   = new ethers.Wallet(process.env.STORAGE_PRIVATE_KEY!, provider);

// ─── 2. indexer. ONE arg. Do NOT pass a flow address — it is auto-discovered. ──
const indexer  = new Indexer(INDEXER_RPC);
// Optional but recommended: HttpProvider fields are plain instance props (verified mutable)
(indexer as any).timeout = 60_000;   // default 30_000 ms
(indexer as any).retry   = 5;        // default 3 (axios-level)

// ─── 3. serialize + compute BOTH hashes ─────────────────────────────────────
const doc   = { kind: 'source-snapshot', schemaVersion: '1.0.0', /* … */ };
const bytes = toUtf8Bytes(canon(doc));
const objectHash = keccak256(bytes);        // 0x… → this is the ON-CHAIN bytes32 commitment

// ─── 4. predict the 0G root offline — no network, no wallet, no cost ─────────
const mem = new MemData(bytes);             // MemData for buffers; ZgFile.fromFilePath() for files
const [tree, treeErr] = await mem.merkleTree();
if (treeErr) throw treeErr;
const predictedRoot = tree!.rootHash();     // === the rootHash upload will return (verified true)

// ─── 5. upload ──────────────────────────────────────────────────────────────
const uploadOpts = {
  finalityRequired: true,     // wait until storage nodes report finalized
  expectedReplica : 1,
  taskSize        : 4,        // segments per parallel task
  skipIfFinalized : true,     // ← the free-dedupe switch; keep it on
  onProgress      : (m: string) => console.log('[0g]', m),
};
const retryOpts: RetryOpts = { Retries: 5, Interval: 3, MaxGasPrice: 0, TooManyDataRetries: 5 };

const [tx, uploadErr] = await indexer.upload(mem, RPC_URL, signer, uploadOpts, retryOpts);
if (uploadErr) throw uploadErr;

// upload() returns one of two shapes — you MUST discriminate
const { rootHash, txHash, txSeq } =
  'rootHash' in tx ? tx : { rootHash: tx.rootHashes[0], txHash: tx.txHashes[0], txSeq: tx.txSeqs[0] };

console.log({ objectHash, rootHash, txHash, txSeq, dedup: txHash === '' });
//   txHash === ''  ⇒  content was already finalized on-network; NO transaction, NO cost.

const pointer = `0g://${rootHash}`;   // e.g. 0g://0x33a7ade5…bee8f

// ─── 6. download by root hash + verify integrity ────────────────────────────
const [blob, dlErr] = await indexer.downloadToBlob(rootHash, { proof: true });
if (dlErr) throw dlErr;
const back = new Uint8Array(await blob.arrayBuffer());

if (keccak256(back) !== objectHash) throw new Error('0G integrity check failed');
// ^ THIS is the real integrity gate. `proof: true` only checks bytes against the
//   Merkle root the network itself reports — it cannot detect a wrong pointer.
```

**`ZgFile` variant** (when the artifact is already on disk):

```ts
import { ZgFile } from '@0gfoundation/0g-storage-ts-sdk';
const file = await ZgFile.fromFilePath('/path/to/report.json');
try {
  const [tree] = await file.merkleTree();
  const [tx, err] = await indexer.upload(file, RPC_URL, signer);
} finally {
  await file.close();          // ZgFile holds an fs FileHandle — always close it
}
```

### 2.4 Actual console output of the run above

```
canonical bytes  : 492
objectHash(keccak): 0x173dbc41e82b8f9e55afadac7c02762b716344a341c1a3ef97b1667dcd7a542f
signer           : 0xA7d6b126D6dCbc75319f7c1B7B43524Cc791E02D balance 0.383460270967649618
predicted 0G root: 0x33a7ade582563d55284a3740b1bfeb2fd2cc512a0b1bbaa12cd02e27b18bee8f
Data prepared to upload root=0x33a7ade5…bee8f size=492 numSegments=1 numChunks=2
Submitting transaction with storage fee: 61467289924n
Transaction submitted, hash: 0x734fe9fad8d0e955df4360d823305f2aab0e7168667d76dd0c2b1a9fd412006c
  [progress] Waiting for storage node to sync (height=52613165)...     (x3, 1s apart)
  [progress] Log entry confirmed (txSeq=148961). Uploading segments...
  [progress] Segments uploaded. Waiting for finality...
  [progress] Upload finalized.
upload elapsed   : 11678 ms
upload result    : {"txHash":"0x734fe9fa…006c","rootHash":"0x33a7ade5…bee8f","txSeq":148961}
root matches pred: true
gasUsed          : 427733  gasPrice 4000000007  gasCost 0G 0.001710932002994131
                   | storageFee(value) 0G 0.000000061467289924
SDK readback len : 492 | byte-identical: true
SDK keccak match : true
REST status      : 200 ct text/plain; charset=utf-8 len 492
REST keccak match: true
POINTER          : 0g://0x33a7ade582563d55284a3740b1bfeb2fd2cc512a0b1bbaa12cd02e27b18bee8f
```

And the idempotency re‑run:

```
elapsed 858 ms
result {"txHash":"","rootHash":"0x33a7ade5…bee8f","txSeq":148961}
balance delta (wei): 0  => cost 0G 0.0
```

---

## 3. Funding and the fee model on Galileo

### 3.1 Yes, uploads need a funded wallet. Downloads do not.

Verified with a fresh zero‑balance wallet:

```
err.code         = INSUFFICIENT_FUNDS
err.shortMessage = insufficient funds
RPC              = { code: -32000, message: "insufficient funds for transfer" }
failing call     = eth_estimateGas on flow.submit(...) with value 0x727de34a2
```

Downloads (`downloadToBlob`, `download`, `peekHeader`, gateway `GET /file`) need **no key and no funds** — confirmed by running all of them with no wallet at all.

### 3.2 There are two costs, and the one everybody worries about is the wrong one

Upload = one `submit()` transaction to the **Flow** contract, then raw segment POSTs to storage nodes (free).

```
Flow (turbo, Galileo)  0x22E03a6A89B950F1c82ec5e74F8eCa321a105296   (matches docs + node self-report)
  .market()         →  0x26c8f001C94b0fd287DB5397F05EF8Bd8EF2cF4B   (read live)
  .pricePerSector() →  30 733 644 962 wei  = 3.0733644962e-8 0G     (read live 2026-09-02)
selector             0xbc8c11f8  submit(((uint256 length, bytes tags,
                                 (bytes32 root, uint256 height)[] nodes) data,
                                 address submitter)) payable
```

**Cost A — storage fee (`msg.value`).** From the SDK's own `calculatePrice`:

```js
fee = paddedChunks * pricePerSector
// paddedChunks = computePaddedSize(ceil(size/256))[0]
//   nextPow2(chunks); minChunk = pow2 >= 16 ? pow2/16 : 1; padded = ceil(chunks/minChunk)*minChunk
```

Computed table (ProofRelay artifacts are all in the first five rows):

| Object size | chunks | billed sectors | storage fee (0G) |
|---:|---:|---:|---:|
| 445 B (`source-snapshot`) | 2 | 2 | 6.15 × 10⁻⁸ |
| 492 B (**measured**) | 2 | 2 | **6.1467 × 10⁻⁸** |
| 1 KiB | 4 | 4 | 1.23 × 10⁻⁷ |
| 8 856 B (`verifier-report`) | 35 | 36 | 1.11 × 10⁻⁶ |
| 256 KiB | 1 024 | 1 024 | 3.15 × 10⁻⁵ |
| 1 MiB | 4 096 | 4 096 | 1.26 × 10⁻⁴ |
| 1 GiB | 4 194 304 | 4 194 304 | 1.29 × 10⁻¹ |

**Cost B — gas, which dominates by ~28 000×.**

| Source | gasUsed | @4 gwei |
|---|---:|---:|
| Live tx `0xe4c26225f7…` (sampled from chain) | 282 876 | 0.001132 0G |
| Live tx `0x78bca08aab…` (sampled from chain) | 279 570 | 0.001118 0G |
| **My upload `0x734fe9fa…`** | **427 733** | **0.001711 0G** |

Galileo `eth_gasPrice` reads `0xee6b2807` = 4.000000007 gwei (flat).

**Budget rule: ~0.0011–0.0018 0G per artifact, and it is essentially independent of size for anything under ~1 MiB.**

### 3.3 What that means for ProofRelay's faucet budget

Faucet is **0.1 0G per wallet per day**. One full ProofRelay task per `DEPLOYMENT.md` is ~0.017 0G of contract gas, plus the storage uploads. With one manifest + one snapshot per source + two reports + one consensus result ≈ 5–7 objects ≈ **0.008–0.012 0G of storage gas per task**.

→ **≈ 3–4 full tasks per day per faucet wallet.** The current `STORAGE_PRIVATE_KEY` holds 0.383 0G ≈ 220 uploads ≈ 30+ tasks. That is enough for a demo but not for an unattended keeper. Recommendation: give the storage driver **its own key**, separate from `KEEPER_PRIVATE_KEY` and `PRIVATE_KEY` (today all three env vars hold the *same* key `0xA7d6…E02D` — one stuck nonce takes down the whole system).

### 3.4 Free dedupe is a first‑class feature — use it

With `skipIfFinalized: true` (the default), re‑uploading identical bytes costs **0 wei** and returns in **858 ms** with `txHash: ''`. Because content addressing is deterministic and the Merkle root is computable offline, the adapter's `put()` is naturally idempotent. Never guard uploads with a database "have I uploaded this?" check — just call `upload()` and read `txHash === ''`.

---

## 4. Node.js compatibility

### 4.1 Minimum version

The package declares **no `engines`**. Evidence for the real floor:

- Starter kit README: **"Node.js >= 18"**.
- SDK uses the global `Blob` constructor in 18 places → Node **18+** (stable there).
- `globalThis.fetch` in `HotRouterClient` → Node 18+ (and it throws `HotRouterClient requires a fetch implementation (global fetch not found)` otherwise — but you will not touch the hot router).
- ESM build statically imports `node:fs/promises` (`FileHandle`) → Node 14.17+.
- Transitive `engines`: `@noble/*` `^14.21.3 || >=16`, `ethers` `>=14.0.0`, `ws` `>=10`.

**Recommendation: Node 22 LTS.** Verified working on **v22.23.1**. Node 20 is safe. Node 18 is the documented floor. Do not go below 18.

### 4.2 Native dependencies — yes, transitively

```
@0gfoundation/0g-storage-ts-sdk
└─ open-jsonrpc-provider@0.2.1
   ├─ axios@0.27.2                  ← EOL, and the source of 2 high CVEs (§4.6)
   ├─ ws@8.x
   └─ websocket@1.0.35
      ├─ bufferutil@4.1.0      ← N-API native addon
      └─ utf-8-validate@5.x    ← N-API native addon
```

Prebuilds shipped:

```
bufferutil     : darwin-arm64, darwin-x64, linux-x64, win32-ia32, win32-x64
utf-8-validate : darwin-x64+arm64, linux-x64, win32-ia32, win32-x64
```

**No `linux-arm64`, no musl.** On `node:22-alpine` or Apple‑Silicon Linux containers these fall through to `node-gyp` and need a toolchain:

```dockerfile
# Alpine
RUN apk add --no-cache python3 make g++
# or just avoid it entirely:
FROM node:22-bookworm-slim        # glibc linux-x64 → prebuilds hit, no compiler needed
```

Note the irony: none of this is ever used. The SDK only ever constructs `HttpProvider`, never the WebSocket one. It is dead weight you must still be able to install.

### 4.3 ESM/CJS: one real landmine — `tslib`

Both builds load and work (verified: ESM import ✅, CJS `require` ✅, `type:"module"` ✅, plain CJS package ✅). But:

```
$ grep -c 'require("tslib")' lib.commonjs/**/*.js     → 10 occurrences
$ node -p "require('@0gfoundation/0g-storage-ts-sdk/package.json').dependencies.tslib"
  undefined            # tslib is a devDependency only
```

The CJS entry point requires `tslib`, which the SDK does not declare. Under npm it resolves **by accident**, hoisted out of `ethers@6.13.1 → tslib@2.4.0`. Verified breakage:

```
pnpm install --config.node-linker=isolated                       → works (hidden hoist store)
pnpm install --config.node-linker=isolated --config.hoist-pattern=''
    pnpm ESM import OK: function
    pnpm CJS require FAILED: MODULE_NOT_FOUND | Cannot find module 'tslib'
```

**Fix: add `"tslib": "^2.8.1"` to your own dependencies.** One line, permanently immune. Note `proofrelay-frontend` already uses pnpm.

Other bundler notes:
- `lib.esm/**` statically imports `node:fs/promises` at load time → the ESM build cannot enter a browser bundle without aliasing. Docs confirm: use `vite-plugin-node-polyfills` + stub aliases.
- `indexer.download()` is **Node‑only** (`fs.appendFileSync`). Browsers must use `downloadToBlob()`, or the gateway (§5).
- Browser file class is exported as `Blob` and collides with the native global — alias it: `import { Blob as ZgBlob } from '…'`.

### 4.4 TypeScript: the `signer as any` cast, root‑caused

The starter kit says "`signer as any` is needed because the SDK expects ethers v5 Signer types". **That diagnosis is wrong.** I reproduced and traced it:

```
src/a.ts(18,79): error TS2345: Argument of type 'Wallet' is not assignable to parameter of type 'Signer'.
  Type '…/ethers/lib.esm/providers/provider' Provider is not assignable to
  type '…/ethers/lib.commonjs/providers/provider' Provider.
    Property '#private' in type 'Network' refers to a different member…
```

The SDK's `exports` map points the `types` condition at `./types/index.d.ts`, which TS resolves against ethers' **lib.commonjs** declarations, while your ESM app resolves ethers to **lib.esm**. Two structurally identical classes with different private brands. It is an ethers‑v6 dual‑build artifact, nothing to do with v5.

Measured fix matrix:

| `moduleResolution` | result |
|---|---|
| `"bundler"` | **clean, no cast needed** ✅ |
| `"NodeNext"` | `TS2345` ❌ |
| `"node16"` | `TS2345` ❌ |
| `"NodeNext"` + `skipLibCheck:true` | still `TS2345` ❌ (it's a source error, not a lib error) |

**Recommendation:** use `"moduleResolution": "bundler"` in the backend/worker `tsconfig.json`. If you must stay on `NodeNext`, isolate the cast inside the adapter:

```ts
// the ONE place in the codebase allowed to do this
const [tx, err] = await indexer.upload(file, RPC_URL, signer as unknown as Parameters<Indexer['upload']>[2], …);
```

Also remember: `RetryOpts` is not exported — declare it locally (§2.1).

### 4.5 The SDK writes to `console.log` and you cannot turn it off

There is no logger injection point. A single upload emitted ~30 lines to stdout, including a full pretty‑printed dump of your `UploadOption` object and every selected `StorageNode`. In a JSON‑structured‑logging service this is unacceptable noise. Verified workaround — capture and re‑emit through your logger:

```ts
async function quiet<T>(fn: () => Promise<T>, log: (m: string) => void): Promise<T> {
  const orig = console.log;
  console.log = (...a: unknown[]) => log(a.map(String).join(' '));
  try { return await fn(); } finally { console.log = orig; }
}
// verified: captured 3 SDK log lines, downloadToBlob still returned 492 bytes, err null
```

Because this monkey‑patches a global, wrap **only** the SDK call and never run two wrapped calls concurrently in the same process.

### 4.6 Security posture of the dependency tree

`npm audit` on a clean install: **4 high, 1 moderate**.

```
axios 0.27.2   HIGH  CSRF; SSRF + credential leakage via absolute URL
ws             HIGH  uninitialized memory disclosure; memory-exhaustion DoS
open-jsonrpc-provider  HIGH (via axios)
ethers         MODERATE (via ws)
```

You cannot patch these without patching `open-jsonrpc-provider`. Mitigation: the SDK only ever points axios at *your own* configured indexer URL and at storage‑node URLs returned by that indexer, so the SSRF surface is bounded by trusting the indexer. Note this in `THREAT_MODEL.md` and keep `STORAGE_INDEXER_RPC` non‑user‑controllable. `npm audit fix` will not help; do not let CI hard‑fail on it without an allowlist entry.

---

## 5. HTTP gateway — the SDK‑free fallback driver

The indexer exposes a REST gateway alongside its JSON‑RPC. **I verified every endpoint below against `https://indexer-storage-testnet-turbo.0g.ai`.**

### 5.1 Download by root hash

```
GET https://indexer-storage-testnet-turbo.0g.ai/file?root=0x<64 hex>
GET .../file?root=0x…&name=artifact.json          → sets Content-Disposition filename
GET .../file?txSeq=<n>                            → by transaction sequence number
GET .../file/{root}/path/to/file                  → files inside an uploaded directory
GET .../file/{txSeq}/path/to/file
```

Verified response for my uploaded object:

```
HTTP/2 200
accept-ranges: bytes
content-disposition: attachment; filename="0x33a7ade5…bee8f"
content-length: 492
content-type: text/plain; charset=utf-8
```

Byte‑identical to the SDK download; keccak256 matched. `Range` requests work (`Range: bytes=0-31` → `HTTP/2 206`, `content-range: bytes 0-31/44849`).

### 5.2 ⚠ The trap: errors return **HTTP 200**

```
$ curl -w '%{http_code}' '…/file?root=0x1111…1111'
{"code":101,"message":"File not found","data":null}
200
```

A fetch‑based driver that checks `res.ok` will happily hand a JSON error object to your JSON parser and store it as the artifact. **You must sniff the body**, and — because you have `objectHash` — the keccak check catches it anyway. Never write a gateway response to the artifact store without hashing it first.

### 5.3 Reference fallback driver

```ts
const OG_GATEWAY = 'https://indexer-storage-testnet-turbo.0g.ai';

export async function fetchByRoot(root: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(`${OG_GATEWAY}/file?root=${root}`, { signal, redirect: 'error' });
  if (!res.ok) throw new StorageError('OG_GATEWAY_HTTP', `HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());

  // the gateway signals "not found" with HTTP 200 + a JSON error envelope
  if (buf.length < 4096 && buf[0] === 0x7b /* '{' */) {
    try {
      const j = JSON.parse(new TextDecoder().decode(buf));
      if (typeof j?.code === 'number' && typeof j?.message === 'string' && 'data' in j) {
        throw new StorageError(j.code === 101 ? 'NOT_FOUND' : 'OG_GATEWAY_ERROR', j.message);
      }
    } catch (e) { if (e instanceof StorageError) throw e; /* real JSON artifact — fall through */ }
  }
  return buf;
}
```

### 5.4 Other reachable HTTP surfaces (all verified live)

**Indexer JSON‑RPC** (`POST` to the indexer root):

```bash
curl -X POST https://indexer-storage-testnet-turbo.0g.ai \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"indexer_getShardedNodes","params":[]}'
# → {"trusted":[{"url":"http://34.19.125.196:5678","config":{"shardId":0,"numShard":2},…}, …6 nodes],
#    "discovered":null}
```

Also `indexer_getNodeLocations`, `indexer_getFileLocations`.

**Storage nodes** (`POST` JSON‑RPC on port 5678; `GET` returns 405):

```bash
curl -X POST http://34.19.125.196:5678 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"zgs_getFileInfo","params":["0x33a7…bee8f", true]}'
# → { tx:{dataMerkleRoot, merkleNodes, startEntryIndex, size, seq}, finalized:true,
#     isCached:false, uploadedSegNum:1, pruned:false }
```

Also `zgs_getStatus` (returns `{connectedPeers, logSyncHeight, nextTxSeq, networkIdentity:{chainId:16602, flowAddress:…}}`).

> **Storage nodes are plain `http://`, not TLS.** That matters for browser mixed‑content, for egress firewall rules, and for `THREAT_MODEL.md`. Anything the SDK downloads travels in cleartext — which is exactly why the keccak check is mandatory rather than decorative.

**Dead ends** (do not build on them):
- `https://indexer-storage-testnet-standard.0g.ai` → **HTTP 503, nginx**. The standard network is under maintenance / deprecated. There is no second network to fail over to.
- `storagescan-galileo.0g.ai/tx/<root>` → 308‑redirects to `chainscan-galileo.0g.ai/tx/<root>`, i.e. it treats it as a *transaction* hash. There is no public "view artifact by root hash" explorer page. **The gateway URL is your artifact permalink:** `https://indexer-storage-testnet-turbo.0g.ai/file?root=<root>&name=<kind>.json`.
- `chainscan-galileo.0g.ai/tx/<txHash>` → 200. Use that for the submit transaction.

---

## 6. Failure modes, exact error strings, and a retry policy

### 6.1 ⚠ The tuple contract is a lie — everything can throw

The docs and the starter kit both say "the SDK uses tuple-based error returns `[result, error]`". **Verified false for the indexer.** Every failure I could produce *threw*:

| Call | On failure |
|---|---|
| `downloadToBlob(unknownRoot)` | **THROWS** `JsonRpcError` `code -32000` `"file not found"` |
| `download(unknownRoot, path)` | **THROWS** same |
| `peekHeader(unknownRoot)` | **THROWS** same |
| `getFileLocations(unknownRoot)` | **THROWS** same |
| `getShardedNodes()` / `selectNodes()` on a bad host | **THROWS** `AxiosError` `ENOTFOUND` |
| indexer URL with a wrong path | **THROWS** `AxiosError` `ERR_BAD_REQUEST` `"Request failed with status code 404"` |

**Every SDK call must be inside both `try/catch` and an `if (err)` check.** A `[blob, err]` destructure alone will crash your worker.

### 6.2 ⚠ `waitForLogEntry` is an unbounded `while (true)` with no timeout

Read from `lib.commonjs/transfer/Uploader.js`:

```js
async waitForLogEntry(root, finalityRequired, txSeq, useTxSeq, onProgress) {
  let info = null;
  while (true) {                       // ← no iteration cap, no deadline
    await delay(1000);
    for (let client of this.nodes) {
      info = await client.getFileInfo(root, true);
      if (info === null) { onProgress?.('Waiting for storage node to sync…'); ok = false; break; }
      if (finalityRequired && !info.finalized) { ok = false; break; }
    }
    if (ok) break;
  }
  return info;
}
```

`indexer.upload()` calls this **twice** (once after submit, once for finality). If a storage node stalls, **your worker hangs forever** — no error, no timeout, just a progress message every second. My run looped 3× (3 s). A stalled node loops until the process is killed.

**This is the single most important thing to defend against.** Always race the upload:

```ts
const withDeadline = <T>(p: Promise<T>, ms: number, tag: string) =>
  Promise.race([p, new Promise<never>((_, rej) =>
    setTimeout(() => rej(new StorageError('OG_UPLOAD_TIMEOUT', `${tag} exceeded ${ms}ms`)), ms).unref())]);

const [tx, err] = await withDeadline(indexer.upload(...), 120_000, 'indexer.upload');
```

Note that a timeout here does **not** mean the upload failed — the `submit()` tx may already be mined. Because the root hash is deterministic and known in advance, recovery is trivial: probe `getFileLocations(predictedRoot)` or the gateway and treat a hit as success.

### 6.3 `RetryOpts` is mostly decorative on the upload path

Traced through the source:

| Field | Where it is actually consumed on `indexer.upload()` |
|---|---|
| `TooManyDataRetries` | ✅ `uploadTask()` — segment POST retries. Default **3**. |
| `Interval` | ✅ the sleep between those retries (in **seconds**). Default 1. |
| `Retries` | ❌ only used by `waitForReceipt()`, which `uploadFile()` never calls |
| `MaxGasPrice` | ❌ only used by `txWithGasAdjustment()`, which nothing on this path calls |

So `{ Retries: 99, MaxGasPrice: 5e9 }` buys you nothing. Only `TooManyDataRetries` and `Interval` matter. Do your own outer retry (§6.6).

### 6.4 Complete error‑string catalogue

**Retryable, classified as such by the SDK** (`isRetryableError`):

```
"too many data writing"                    ← storage node backpressure; the common one
"returned null for upload segments"
error.data?.message?.includes('too many data writing')
```

**Success in disguise** (`isAlreadyUploadedError` → returns 0, treated as OK):

```
error.data includes "already uploaded and finalized"
message includes "Invalid params" && error.data === "already uploaded and finalized"
```

**Terminal — never retry** (verified live):

```
code = INSUFFICIENT_FUNDS   shortMessage = "insufficient funds"
                            RPC: { code:-32000, message:"insufficient funds for transfer" }
"Failed to get suggested gas price, set your own gas price"
"Wrong path, provide a file path which does not exist."      ← indexer.download() refuses to overwrite
"Output file already exists. Provide a file path which does not exist."
```

**Node selection / coverage:**

```
"cannot select a subset from the returned nodes that meets the replication requirement"
"Cannot form a complete shard covering set for ${rootHash}"
"No storage node holds segment with index "
"No locations found for root hash: ${rootHash}"
"failed to get status from the selected node"
"Failed to get shard configs"
```

**Lifecycle / transfer:**

```
"File not finalized"                        "File not found on node "
"Failed to get log entry"                   "Failed to get upload tasks"
"Failed to create Merkle tree, "            "Failed to create submission"
"Send transaction timeout"                  "Get transaction receipt timeout"
"Failed after ${maxRetries} attempts: ${errorMessage}"
"Upload failed after ${maxRetries} attempts to node ${url}"
"Failed to download file with root ${root}: ${msg}"
"Failed to create downloader for ${rootHash}: ${msg}"
```

**Merkle proof enum** (`ProofErrors`):

```
"invalid merkle proof format" | "merkle proof root mismatch" | "merkle proof content mismatch"
| "merkle proof position mismatch" | "failed to validate merkle proof"
```

**Encryption:**

```
"v1 encrypted file requires a symmetric key (withSymmetricKey)"
"v2 encrypted file requires a private key (withPrivateKey)"
"symmetric key must be 32 bytes, got ${n}"   "unsupported encryption version: ${v}"
"data too short for v1 encryption header: ${n} < 17"
```

⚠ Docs warning, worth repeating: **a wrong decryption key does not throw** — `downloadToBlob` silently returns ciphertext. Your keccak check is the only thing that catches it. (ProofRelay artifacts are public, so prefer plaintext and skip this whole surface.)

**Transport (thrown, not returned):**

```
JsonRpcError  code -32000  "file not found"
AxiosError    ENOTFOUND | ECONNREFUSED | ETIMEDOUT | ECONNRESET
AxiosError    ERR_BAD_REQUEST  "Request failed with status code 404"
Error         "Timeout after 30000 ms"        ← open-jsonrpc-provider default
```

### 6.5 Underlying transport defaults (verified mutable)

```js
new Indexer(url)      // → HttpProvider: timeout = 30000 ms, retry = 3 (axios-level, in-provider)
new StorageNode(url)  // → same defaults; created internally by Uploader/Downloader
indexer.timeout = 60_000;  indexer.retry = 5;   // plain instance props — verified assignable
```

The internally-constructed `StorageNode`s you cannot reach, so their 30 s / 3 stays fixed.

### 6.6 Recommended retry/backoff policy

**Classify first, then retry.** Never blind‑retry an upload: a blind retry on a `submit()` that actually landed burns another 0.0017 0G — although `skipIfFinalized` makes it *safe*, just wasteful.

```ts
type Cls = 'RETRY' | 'FATAL' | 'ALREADY_OK';

function classify(e: any): Cls {
  const m = String(e?.message ?? e), d = String(e?.data ?? e?.data?.message ?? '');
  if (/already uploaded and finalized/.test(m + d))                 return 'ALREADY_OK';
  if (e?.code === 'INSUFFICIENT_FUNDS')                             return 'FATAL';
  if (/insufficient funds|nonce too low|replacement transaction underpriced/i.test(m)) return 'FATAL';
  if (/Wrong path|already exists|must be 32 bytes|unsupported encryption/i.test(m))    return 'FATAL';
  if (e?.code === -32000 && /file not found/i.test(m))              return 'FATAL';  // ← not a transient
  if (/too many data writing|returned null for upload segments/i.test(m + d))          return 'RETRY';
  if (['ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(e?.code)) return 'RETRY';
  if (/Timeout after \d+ ms|status code 5\d\d|OG_UPLOAD_TIMEOUT/i.test(m))             return 'RETRY';
  if (/Failed to get log entry|File not finalized|failed to get status/i.test(m))      return 'RETRY';
  if (/cannot select a subset|Cannot form a complete shard|No locations found/i.test(m)) return 'RETRY';
  return 'RETRY';                                                   // unknown → one cautious retry
}
```

| Operation | attempts | backoff | ceiling | per‑attempt deadline | notes |
|---|---|---|---|---|---|
| `upload` | **3** | 2 s → 6 s → 18 s, ×3, full jitter | 30 s | **120 s** (`Promise.race`) | before each retry, probe `getFileLocations(predictedRoot)`; a hit = success, stop |
| `downloadToBlob` | **5** | 500 ms → ×2, full jitter | 8 s | **45 s** | on attempt 3, fall through to the REST gateway |
| gateway `fetch` | **3** | 1 s → ×2 | 8 s | **30 s** | `AbortSignal.timeout(30_000)` |
| `getShardedNodes` / `selectNodes` | **3** | 1 s → ×2 | 5 s | 20 s | cache the result for 60 s |
| chain RPC reads | **4** | 500 ms → ×2 | 5 s | 15 s | |

Plus:

- **Full jitter** — `sleep = random(0, min(cap, base * 3**n))`. All ProofRelay workers poll on the same cadence; without jitter they retry in lockstep and re‑create the "too many data writing" backpressure they are backing off from.
- **Circuit breaker** on the zerog driver: 5 consecutive `RETRY`‑class failures within 60 s → open for 30 s, and fall the adapter back to `local` (with `degraded: true` surfaced on `/health` per `DEPLOYMENT.md`'s `storage.ok` contract).
- **Serialize uploads per signer.** All uploads share one nonce sequence; concurrent `submit()` calls from one key produce `nonce too low` / `replacement transaction underpriced`, both `FATAL`. Put a mutex or single‑consumer queue in front of the zerog driver's `put()`.
- **Set `TooManyDataRetries: 5, Interval: 2`** to lean on the SDK's own inner retry before your outer one fires.
- **Never retry `-32000 "file not found"` as transient.** It is the SDK's answer for "this root has never been submitted", not "not replicated yet". A freshly‑finalized upload was queryable **immediately** in my run — there is no eventual‑consistency window to wait out.

---

## 7. Recommended `StorageAdapter` interface

### 7.1 The design constraint that drives everything

```
local://<hex>   the hex IS keccak256(bytes)  →  pointer is self-verifying
0g://0x<root>   the root is a Merkle root    →  pointer is NOT a content hash
```

`objectHash` (keccak256) and `pointer` are therefore **two independent values** and both must be persisted. The contract stores `objectHash` as `bytes32` and `pointer` as `string`; `MAX_POINTER_BYTES() = 256`, and both forms are ≤ 72 bytes, so there is head‑room.

This also means **a driver switch never invalidates a hash**. An artifact written under `local` and later re‑published to `zerog` keeps the identical `objectHash`, so `getTask().manifestHash` stays valid and no on‑chain state needs migrating. That is the property that makes `STORAGE_DRIVER` safe to flip mid‑demo.

### 7.2 Pointer grammar (normative)

```
pointer   := local-ptr | og-ptr
local-ptr := "local://" 64*HEXDIG-lower                    ; == keccak256(canonicalBytes), no 0x
og-ptr    := "0g://0x"  64*HEXDIG-lower                    ; == 0G Merkle root, WITH 0x
```

The `0x` asymmetry is deliberate and matches both corpora: `local://` mirrors the on‑disk filename (`.proofrelay/storage/75/74/7574….json`, no prefix), while `0g://0x…` mirrors what `indexer.upload()` returns and what `/file?root=` expects verbatim. Keeping the SDK's own formatting means zero string surgery at the call site — the highest‑value property for a pointer format.

**Action item:** `proofrelay-frontend/client/src/pages/Artifacts.tsx` hard-codes `0g://storage/7b1d…a32f`. That is a third, invalid shape. Fix it to `0g://0x…` when the frontend is wired to real data.

### 7.3 The interface

```ts
// packages/storage-adapter/src/types.ts

/** Artifact kinds, from ARCHITECTURE.md §10.1 and the 84 surviving files. */
export type ArtifactKind =
  | 'source-snapshot' | 'task-manifest' | 'verifier-report'
  | 'consensus-result' | 'challenge-evidence' | 'adjudication-report';

/** 0x-prefixed lowercase keccak256 of the canonical bytes. The on-chain bytes32. */
export type ObjectHash = `0x${string}`;

/** "local://<hex>" or "0g://0x<hex>". Retrieval hint ONLY — never an integrity proof. */
export type Pointer = string;

export interface PutResult {
  objectHash : ObjectHash;   // keccak256(canonicalBytes) — goes on chain
  pointer    : Pointer;      // driver-specific retrieval hint — goes on chain as string
  byteLength : number;
  driver     : 'local' | 'zerog';
  deduplicated: boolean;     // true = content already stored, no work/cost incurred
  txHash?    : `0x${string}`;// zerog only; absent when deduplicated
  txSeq?     : number;       // zerog only; useful for the /file?txSeq= gateway form
  elapsedMs  : number;
}

export interface GetResult {
  bytes      : Uint8Array;
  objectHash : ObjectHash;   // recomputed from the returned bytes, never trusted from the caller
  via        : 'local' | 'zerog-sdk' | 'zerog-gateway' | 'cache';
  elapsedMs  : number;
}

export interface DependencyHealth {         // shape mandated by DEPLOYMENT.md's /health contract
  ok: boolean; driver: string; detail?: string; latencyMs?: number;
}

export interface StorageAdapter {
  readonly driver: 'local' | 'zerog';

  /** Canonicalize, hash, store. MUST be idempotent by content. */
  put(obj: unknown, meta: { kind: ArtifactKind }): Promise<PutResult>;

  /** Store pre-serialized bytes (re-publishing an artifact between drivers). */
  putBytes(bytes: Uint8Array, meta: { kind: ArtifactKind }): Promise<PutResult>;

  /**
   * Retrieve by pointer. If `expect` is given, MUST throw StorageError('HASH_MISMATCH')
   * when keccak256(bytes) !== expect. Callers should ALWAYS pass it.
   */
  get(pointer: Pointer, expect?: ObjectHash): Promise<GetResult>;

  /** Cheap existence probe. MUST NOT download the body. */
  has(pointer: Pointer): Promise<boolean>;

  /** Offline. No network, no wallet, no cost. Computes exactly what put() would return. */
  address(obj: unknown): { objectHash: ObjectHash; pointer: Pointer; byteLength: number };

  health(): Promise<DependencyHealth>;
}

export class StorageError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND' | 'HASH_MISMATCH' | 'BAD_POINTER' | 'TOO_LARGE'
      | 'INSUFFICIENT_FUNDS' | 'OG_UPLOAD_TIMEOUT' | 'OG_GATEWAY_ERROR'
      | 'OG_GATEWAY_HTTP' | 'TRANSIENT' | 'FATAL',
    message: string,
    readonly cause?: unknown,
  ) { super(message); this.name = 'StorageError'; }
}
```

`address()` is the method that makes the whole thing pleasant: because the 0G Merkle root is computable with **no network and no wallet**, the API can hand the browser a manifest pointer *before* the upload transaction is even submitted, and the worker can prove an upload landed after a timeout without re‑paying. I verified `predictedRoot === tx.rootHash`.

### 7.4 Shared canonicalization — one module, no duplicates

```ts
// packages/storage-adapter/src/canonical.ts
import { keccak256, toUtf8Bytes } from 'ethers';
import type { ObjectHash } from './types.js';

/** Recursive key sort + compact JSON. Reproduces all 42 surviving artifacts byte-for-byte. */
export function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalize((v as Record<string, unknown>)[k]))
      .join(',') + '}';
  }
  return JSON.stringify(v);       // undefined -> "undefined" is impossible: schemas use null
}

export const canonicalBytes = (v: unknown): Uint8Array => toUtf8Bytes(canonicalize(v));
export const objectHashOf   = (b: Uint8Array): ObjectHash => keccak256(b) as ObjectHash;
```

Two invariants to lock in a test — both hold on the real corpus:

1. `canonicalize(JSON.parse(raw)) === raw` for all 42 artifacts.
2. `keccak256(canonicalBytes(obj)).slice(2) === <filename>` for all 42.

Ship that as `packages/storage-adapter/test/corpus.spec.ts` reading `.proofrelay/storage/**`. It is a free regression suite against the lost implementation, and it will catch the day someone "improves" the serializer.

Caveats to encode in the schema, not the serializer: `undefined` values (JS drops them, so schemas must use `null` — the surviving artifacts do, e.g. `"error":null`, `"answerText":null`), and floats (`confidence: 0.7417` round‑trips exactly through `JSON.stringify`; do not reformat numbers).

### 7.5 `local` driver

Mirrors the surviving layout exactly: `STORAGE_ROOT/<h[0:2]>/<h[2:4]>/<h>.json` plus a `<h>.json.meta.json` sidecar `{ "kind": ..., "byteLength": ... }` (pretty‑printed, 2‑space — verified from the surviving sidecars).

```ts
export class LocalStorageAdapter implements StorageAdapter {
  readonly driver = 'local' as const;
  constructor(private root: string) {}

  private path(hex: string) { return join(this.root, hex.slice(0,2), hex.slice(2,4), `${hex}.json`); }

  address(obj: unknown) {
    const bytes = canonicalBytes(obj);
    const objectHash = objectHashOf(bytes);
    return { objectHash, pointer: `local://${objectHash.slice(2)}`, byteLength: bytes.length };
  }

  async putBytes(bytes: Uint8Array, meta: { kind: ArtifactKind }): Promise<PutResult> {
    const t0 = Date.now();
    const objectHash = objectHashOf(bytes);
    const hex = objectHash.slice(2);
    const p = this.path(hex);
    const dedup = existsSync(p);
    if (!dedup) {
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;     // atomic: write-then-rename
      await writeFile(tmp, bytes);
      await rename(tmp, p);
      await writeFile(`${p}.meta.json`,
        JSON.stringify({ kind: meta.kind, byteLength: bytes.length }, null, 2) + '\n');
    }
    return { objectHash, pointer: `local://${hex}`, byteLength: bytes.length,
             driver: 'local', deduplicated: dedup, elapsedMs: Date.now() - t0 };
  }
  // get(): read, recompute keccak, compare to `expect` AND to the filename. Both must match.
}
```

Note that on `local` the driver can self‑audit: the filename *is* the expected hash, so a bit‑rotted store is detected on every read even when the caller forgets `expect`.

### 7.6 `zerog` driver

```ts
export class ZeroGStorageAdapter implements StorageAdapter {
  readonly driver = 'zerog' as const;
  private indexer: Indexer;
  private signer: ethers.Wallet;
  private queue = Promise.resolve();          // serialize uploads: one nonce sequence per key

  constructor(private cfg: {
    rpcUrl: string; indexerRpc: string; privateKey: string;
    uploadTimeoutMs?: number; gatewayBase?: string; cache?: StorageAdapter;
  }) {
    this.signer  = new ethers.Wallet(cfg.privateKey, new ethers.JsonRpcProvider(cfg.rpcUrl));
    this.indexer = new Indexer(cfg.indexerRpc);
    (this.indexer as any).timeout = 60_000;
    (this.indexer as any).retry   = 5;
  }

  address(obj: unknown) {
    const bytes = canonicalBytes(obj);
    // NOTE: the 0G root needs an async merkleTree(); address() stays sync and returns the
    // objectHash only. Use addressAsync() when the caller genuinely needs the pointer early.
    return { objectHash: objectHashOf(bytes), pointer: '', byteLength: bytes.length };
  }

  async addressAsync(obj: unknown) {
    const bytes = canonicalBytes(obj);
    const [tree, err] = await new MemData(bytes).merkleTree();
    if (err || !tree) throw new StorageError('FATAL', `merkleTree: ${err}`);
    return { objectHash: objectHashOf(bytes), pointer: `0g://${tree.rootHash()}`,
             byteLength: bytes.length };
  }

  async putBytes(bytes: Uint8Array, meta: { kind: ArtifactKind }): Promise<PutResult> {
    return (this.queue = this.queue.then(() => this.#put(bytes, meta))) as Promise<PutResult>;
  }

  async #put(bytes: Uint8Array, meta: { kind: ArtifactKind }): Promise<PutResult> {
    const t0 = Date.now();
    const objectHash = objectHashOf(bytes);
    const mem = new MemData(bytes);
    const [tree, terr] = await mem.merkleTree();
    if (terr || !tree) throw new StorageError('FATAL', `merkleTree: ${terr}`, terr);
    const root = tree.rootHash()!;

    // write-through to the local store first: 0G becomes an availability layer,
    // never a single point of failure for a demo.
    await this.cfg.cache?.putBytes(bytes, meta);

    const [tx, err] = await withDeadline(
      quiet(() => this.indexer.upload(mem, this.cfg.rpcUrl, this.signer as any,
        { finalityRequired: true, expectedReplica: 1, taskSize: 4, skipIfFinalized: true },
        { Retries: 5, Interval: 2, MaxGasPrice: 0, TooManyDataRetries: 5 }), log.debug),
      this.cfg.uploadTimeoutMs ?? 120_000, 'indexer.upload');

    if (err) {
      if ((err as any).code === 'INSUFFICIENT_FUNDS')
        throw new StorageError('INSUFFICIENT_FUNDS',
          `0G storage wallet ${this.signer.address} is out of gas — fund at https://faucet.0g.ai`, err);
      throw new StorageError(classify(err) === 'RETRY' ? 'TRANSIENT' : 'FATAL', String(err), err);
    }

    const one = 'rootHash' in tx ? tx
              : { rootHash: tx.rootHashes[0], txHash: tx.txHashes[0], txSeq: tx.txSeqs[0] };
    if (one.rootHash !== root)
      throw new StorageError('HASH_MISMATCH', `root drift: predicted ${root}, got ${one.rootHash}`);

    return { objectHash, pointer: `0g://${one.rootHash}`, byteLength: bytes.length,
             driver: 'zerog', deduplicated: one.txHash === '',
             txHash: one.txHash || undefined, txSeq: one.txSeq, elapsedMs: Date.now() - t0 };
  }

  async get(pointer: Pointer, expect?: ObjectHash): Promise<GetResult> {
    const root = parsePointer(pointer, '0g');            // throws BAD_POINTER
    const t0 = Date.now();
    let bytes: Uint8Array, via: GetResult['via'];
    try {
      const [blob, err] = await quiet(
        () => this.indexer.downloadToBlob(root, { proof: true }), log.debug);
      if (err) throw err;                                // tuple path
      bytes = new Uint8Array(await blob.arrayBuffer()); via = 'zerog-sdk';
    } catch (e) {                                        // ...and the throw path, §6.1
      bytes = await fetchByRoot(root); via = 'zerog-gateway';   // §5.3 fallback
    }
    const objectHash = objectHashOf(bytes);
    if (expect && objectHash !== expect)
      throw new StorageError('HASH_MISMATCH',
        `${pointer}: expected ${expect}, got ${objectHash}`);
    return { bytes, objectHash, via, elapsedMs: Date.now() - t0 };
  }

  async has(pointer: Pointer) {
    try { return (await this.indexer.getFileLocations(parsePointer(pointer, '0g'))).length > 0; }
    catch { return false; }
  }

  async health(): Promise<DependencyHealth> {
    const t0 = Date.now();
    try {
      const [nodes, err] = await this.indexer.selectNodes(1, 'random');
      if (err || !nodes.length) return { ok: false, driver: 'zerog', detail: String(err ?? 'no nodes') };
      const bal = await this.signer.provider!.getBalance(this.signer.address);
      if (bal < ethers.parseEther('0.005'))
        return { ok: false, driver: 'zerog', latencyMs: Date.now() - t0,
                 detail: `wallet ${this.signer.address} low: ${ethers.formatEther(bal)} 0G (<0.005)` };
      return { ok: true, driver: 'zerog', latencyMs: Date.now() - t0 };
    } catch (e) { return { ok: false, driver: 'zerog', detail: String(e) }; }
  }
}
```

`parsePointer` should be strict — reject anything that is not exactly `0g://0x` + 64 lowercase hex, and reject `local://` with an `0x` prefix. Pointers arrive from on‑chain `string` fields written by arbitrary users; a lax parser is an injection vector into the gateway URL. (`MAX_POINTER_BYTES()=256` is the contract's only guard.)

### 7.7 Factory and configuration

The env names in `.env.example` are already right; keep them and add three.

```ts
export function createStorageAdapter(env = process.env): StorageAdapter {
  const local = new LocalStorageAdapter(env.STORAGE_ROOT ?? '.proofrelay/storage');
  if ((env.STORAGE_DRIVER ?? 'local') === 'local') return local;

  if (!env.STORAGE_PRIVATE_KEY)
    throw new Error('STORAGE_DRIVER=zerog requires STORAGE_PRIVATE_KEY');

  return new ZeroGStorageAdapter({
    rpcUrl         : env.OG_RPC_URL         ?? 'https://evmrpc-testnet.0g.ai',
    indexerRpc     : env.STORAGE_INDEXER_RPC?? 'https://indexer-storage-testnet-turbo.0g.ai',
    privateKey     : env.STORAGE_PRIVATE_KEY,
    uploadTimeoutMs: Number(env.STORAGE_UPLOAD_TIMEOUT_MS ?? 120_000),   // NEW
    gatewayBase    : env.STORAGE_GATEWAY_URL ?? env.STORAGE_INDEXER_RPC, // NEW
    cache          : local,                                              // write-through
  });
}
```

```diff
  STORAGE_DRIVER=local
  STORAGE_ROOT=.proofrelay/storage
  STORAGE_INDEXER_RPC=https://indexer-storage-testnet-turbo.0g.ai
  STORAGE_PRIVATE_KEY=
+ # Hard deadline on indexer.upload(). REQUIRED: the SDK's internal wait loop
+ # is an unbounded `while (true)` and will otherwise hang the worker forever.
+ STORAGE_UPLOAD_TIMEOUT_MS=120000
+ # REST gateway for the SDK-free download fallback. Defaults to STORAGE_INDEXER_RPC.
+ STORAGE_GATEWAY_URL=https://indexer-storage-testnet-turbo.0g.ai
+ # Write every zerog artifact to STORAGE_ROOT too, so a 0G outage never loses evidence.
+ STORAGE_WRITE_THROUGH=true
```

### 7.8 Where the adapter sits in the ProofRelay flow

```
API           createTask   → adapter.put(snapshot)  → adapter.put(manifest)
                           → manifestHash = objectHash   (bytes32, on chain)
                           → manifestPointer = pointer   (string,  on chain)
Worker        reads getTask().manifestPointer + .manifestHash
                           → adapter.get(pointer, manifestHash)   ← expect is MANDATORY here
                           → …0G Compute…
                           → adapter.put(report) → commitReport(taskId, commitment)
                           → revealReport(taskId, reportHash, reportPointer, salt)
Keeper        finalizeConsensus(taskId, resultHash, …)  after adapter.put(consensus-result)
Adjudicator   adapter.put(adjudication-report) → resolveDispute(…, adjudicationPointer)
Frontend      renders artifact via the gateway permalink (§5.4), verifies keccak client-side
```

Two rules that fall straight out of `ARCHITECTURE.md` §"Pointer string tidak boleh menjadi satu-satunya integrity mechanism":

1. **`get()` without `expect` is a bug.** The on‑chain `bytes32` is the only trust anchor; the pointer is a hint that any `revealReport` caller controls.
2. **Never store the adapter's output as truth in Postgres.** The read model is a cache; `objectHash` from the chain wins in a conflict (this is the `SYNC_REQUIRED` path in §"Database tidak boleh dipakai untuk menentukan final truth").

---

## 8. Prioritized action list

| # | Action | Why |
|---|---|---|
| 1 | Use `@0gfoundation/0g-storage-ts-sdk@1.2.11`, **not** either candidate in the brief | both candidates carry npm deprecation notices |
| 2 | Pin `ethers` to exactly `6.13.1`; add `tslib` to your own deps | npm ERESOLVE hard‑fails otherwise; CJS build requires an undeclared `tslib` |
| 3 | Change the content address from sha256 → **keccak256** in every plan/doc | 42/42 surviving artifacts are keccak256; sha256 matches none |
| 4 | Wrap `indexer.upload()` in `Promise.race` with `STORAGE_UPLOAD_TIMEOUT_MS` | `waitForLogEntry` is an unbounded `while (true)` — verified in source |
| 5 | `try/catch` **and** `if (err)` on every indexer call | all four indexer failure paths throw despite the documented tuple contract |
| 6 | Body‑sniff the REST gateway; never trust `res.ok` | "File not found" is served as **HTTP 200** + JSON envelope |
| 7 | Always pass `expect` to `get()`; keccak‑verify every read | `0g://<root>` is a Merkle root, not a content hash; storage nodes are plain `http://` |
| 8 | Give the storage driver its own key | `STORAGE_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY` and `PRIVATE_KEY` are all `0xA7d6…E02D` today |
| 9 | Serialize uploads behind a per‑signer queue | one nonce sequence; concurrency yields `FATAL` nonce errors |
| 10 | Set `moduleResolution: "bundler"` in backend/worker tsconfig | eliminates the `signer as any` cast entirely (`NodeNext` cannot, even with `skipLibCheck`) |
| 11 | Fix `Artifacts.tsx` `0g://storage/…` → `0g://0x…` | invalid third pointer shape in the surviving frontend |
| 12 | Do not plan a `standard`‑network fallback | `indexer-storage-testnet-standard.0g.ai` returns **503**; turbo is the only live network |
| 13 | Route SDK `console.log` through your logger via the `quiet()` wrapper | ~30 unstructured lines per upload, no logger hook exists |
| 14 | Base Docker on `node:22-bookworm-slim`, not alpine | `bufferutil`/`utf-8-validate` ship no musl or linux‑arm64 prebuilds |
| 15 | Add `packages/storage-adapter/test/corpus.spec.ts` over `.proofrelay/storage/**` | free regression suite: 42/42 byte‑exact + keccak‑exact against the lost implementation |

---

## 9. Appendix

### 9.1 Verified network constants (2026‑09‑02)

```
Chain RPC          https://evmrpc-testnet.0g.ai      eth_chainId → 0x40da (16602)
Gas price          0xee6b2807 = 4.000000007 gwei     (flat)
Block at test      52 612 101 … 52 613 165
Turbo indexer      https://indexer-storage-testnet-turbo.0g.ai        ACTIVE
Standard indexer   https://indexer-storage-testnet-standard.0g.ai     503 nginx — DEAD
Flow (turbo)       0x22E03a6A89B950F1c82ec5e74F8eCa321a105296
Market (turbo)     0x26c8f001C94b0fd287DB5397F05EF8Bd8EF2cF4B
pricePerSector     30 733 644 962 wei / 256 B sector
submit selector    0xbc8c11f8  payable
Trusted nodes      6 × http://…:5678  (numShard=2, shardIds 0/1; Oregon / LA / Iowa)
Storage node txSeq 148 961 (mine) of nextTxSeq 148 961
Explorers          chainscan-galileo.0g.ai/tx/<txHash>   (200)
                   storagescan-galileo.0g.ai/tx/<x> → 308 → chainscan (NOT a root-hash viewer)
Faucet             https://faucet.0g.ai  — 0.1 0G/wallet/day
```

### 9.2 Reproduction scripts

All under `/tmp/claude-1000/-home-mdlog-Project-MDlabs-Akindo-ProofRelay/1dd3ffa9-2368-4d12-8bf9-2db55485205f/scratchpad/ogtest/` (session‑scoped; copy out what you want to keep):

| File | What it proves |
|---|---|
| `t1.mjs` | full export surface enumeration |
| `t2.mjs` | offline Merkle root, determinism, avalanche |
| `t3.mjs` | live indexer: shardedNodes / selectNodes / getFileLocations / peekHeader / downloadToBlob |
| `t4.cjs`, `cjs/index.js` | CJS interop |
| `t5.mjs` | unfunded‑wallet `INSUFFICIENT_FUNDS` capture |
| `t6.mjs`, `t7.mjs` | full failure‑mode matrix (throw vs tuple) |
| `e2e.mjs` | **the paid end‑to‑end round trip** |
| `idem.mjs` | zero‑cost dedupe proof |
| `bal.mjs` | read‑only wallet balances |
| `canon.mjs` | 42/42 canonicalization + keccak corpus verification |
| `../tstest/` | the `moduleResolution` matrix |
| `../pnpmtest/` | the `tslib` strict‑hoist break |

`canon.mjs` in particular should be promoted into the repo as a permanent test.

### 9.3 Live artifact created by this research

Publicly retrievable, no key required — a useful smoke‑test fixture:

```bash
curl 'https://indexer-storage-testnet-turbo.0g.ai/file?root=0x33a7ade582563d55284a3740b1bfeb2fd2cc512a0b1bbaa12cd02e27b18bee8f&name=probe.json'
# 492 bytes, keccak256 == 0x173dbc41e82b8f9e55afadac7c02762b716344a341c1a3ef97b1667dcd7a542f
```

---

Sources: [@0glabs/0g-ts-sdk – npm](https://www.npmjs.com/package/@0glabs/0g-ts-sdk) · [@0gfoundation/0g-ts-sdk – npm](https://www.npmjs.com/package/@0gfoundation/0g-ts-sdk) · [Storage SDK | 0G Documentation](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk) · [Storage CLI | 0G Documentation](https://docs.0g.ai/developer-hub/building-on-0g/storage/storage-cli) · [Testnet Overview | 0G Documentation](https://docs.0g.ai/developer-hub/testnet/testnet-overview) · [0g-storage-ts-starter-kit](https://github.com/0gfoundation/0g-storage-ts-starter-kit) · [0g-ts-sdk](https://github.com/0gfoundation/0g-ts-sdk) · [0G StorageScan](https://storagescan-galileo.0g.ai/)