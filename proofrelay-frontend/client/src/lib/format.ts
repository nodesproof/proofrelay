/**
 * Client-side presentation helpers.
 *
 * The API already applies `packages/schemas/src/format.ts` to everything it can
 * (`bountyFormatted`, `sizeLabel`, `shortHash`, `time`, `day`, …) and those
 * preformatted fields must always be preferred. What lives here is the residue
 * the API cannot preformat: values that come straight off the wallet or the
 * chain (checksummed addresses, block heights, wei balances read by the browser)
 * and values that have to be recomputed on a clock tick rather than on fetch.
 *
 * The implementations of the shared helpers are kept in step with
 * `packages/schemas/src/format.ts` so a client-side recompute can never disagree
 * with the server's preformatted string. They differ in one way only: an instant
 * the API could not parse must render the design's em-dash here rather than throw
 * or print "Invalid Date" into the page, because on this side the value is inside
 * a React render and a throw takes the whole route to the error boundary.
 */

/* ── mirrors of packages/schemas/src/format.ts ───────────────────────────── */

const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** wei -> "10.00 0G". Real bounties are ~0.001 0G, so four significant fraction digits. */
export function formatToken(wei: bigint | string, symbol = "0G", decimals = 18, precision = 4): string {
  const value = typeof wei === "bigint" ? wei : BigInt(wei || "0");
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  const shown = fracStr.length ? `${whole}.${fracStr}` : `${whole}.00`;
  return `${shown} ${symbol}`;
}

export function shortHash(hash: string | null | undefined, head = 4, tail = 4): string {
  if (!hash) return "—";
  const prefix = hash.startsWith("sha256:") ? "sha256:" : "";
  const body = hash.slice(prefix.length);
  const raw = body.startsWith("0x") ? body.slice(2) : body;
  if (raw.length <= head + tail) return hash;
  const lead = body.startsWith("0x") ? `0x${raw.slice(0, head)}` : raw.slice(0, head);
  return `${prefix}${lead}…${raw.slice(-tail)}`;
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** "8 min ago" — recomputed on a tick, never frozen at fetch time. */
export function relativeTime(iso: string | Date | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} mo ago`;
}

/**
 * An instant the API could not parse must not become a day header. `new Date()`
 * on a malformed string yields an Invalid Date, whose `toLocaleDateString` is the
 * literal "Invalid Date" — the timeline would print that as a heading.
 */
export function dayBucket(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffDays = Math.round((startOf(now) - startOf(then)) / 86_400_000);
  if (diffDays <= 0) return "TODAY";
  if (diffDays === 1) return "YESTERDAY";
  return then.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase();
}

/**
 * `toISOString()` throws RangeError on an Invalid Date, and this is rendered
 * inline in the task timeline and beside every quoted span — a single malformed
 * timestamp out of storage would take the whole page to the error boundary.
 */
export function utcClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toISOString().slice(11, 19);
}

export function taskRef(sequence: number): string {
  return `PR-${1000 + sequence}`;
}

/* ── keccak-256, only so addresses can be EIP-55 checksummed ─────────────── */

const MASK64 = (1n << 64n) - 1n;

const KECCAK_RC: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** rotation offsets r[x][y], flattened as x + 5y */
const KECCAK_ROT: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(value: bigint, bits: bigint): bigint {
  const v = value & MASK64;
  return ((v << bits) | (v >> (64n - bits))) & MASK64;
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x += 1) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], BigInt(KECCAK_ROT[x + 5 * y]));
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK64 & b[((x + 2) % 5) + 5 * y]);
    state[0] ^= KECCAK_RC[round];
  }
}

/** keccak-256 over raw bytes, returned as a lowercase hex string with no 0x prefix. */
export function keccak256Hex(input: Uint8Array): string {
  const RATE = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const state: bigint[] = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
      state[lane] ^= value;
    }
    keccakF1600(state);
  }

  let out = "";
  for (let lane = 0; lane < 4; lane += 1) {
    const value = state[lane];
    for (let byte = 0; byte < 8; byte += 1) out += Number((value >> BigInt(byte * 8)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * EIP-55. A wallet hands back a lowercase address; the sidebar and the wallet
 * button must render the checksummed form so it can be compared by eye against
 * the explorer.
 */
export function toChecksumAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const raw = address.startsWith("0x") || address.startsWith("0X") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(raw)) return null;
  const lower = raw.toLowerCase();
  const bytes = new Uint8Array(40);
  for (let i = 0; i < 40; i += 1) bytes[i] = lower.charCodeAt(i);
  const hash = keccak256Hex(bytes);
  let out = "0x";
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** "0x7A…8C21" over the checksummed form; null when there is nothing connected. */
export function shortChecksumAddress(address: string | null | undefined): string | null {
  const checksummed = toChecksumAddress(address);
  return checksummed ? shortAddress(checksummed) : null;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/* ── chain and health chrome ─────────────────────────────────────────────── */

/** "#52,357,975". The design renders the block height with a leading hash. */
export function blockLabel(block: number | bigint | null | undefined): string | null {
  if (block === null || block === undefined) return null;
  const value = typeof block === "bigint" ? block : Math.trunc(block);
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return `#${value.toLocaleString("en-US")}`;
}

/** "12 blocks behind" / "1 block behind" for the indexer-lag alert. */
export function lagLabel(lagBlocks: number | null | undefined): string | null {
  if (lagBlocks === null || lagBlocks === undefined || !Number.isFinite(lagBlocks)) return null;
  const blocks = Math.max(0, Math.trunc(lagBlocks));
  return `${blocks.toLocaleString("en-US")} block${blocks === 1 ? "" : "s"} behind`;
}

/** The activity page zero-pads its signal count; the badge does not. */
export function pad2(count: number): string {
  return String(Math.max(0, Math.trunc(count))).padStart(2, "0");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function percentLabel(value: number | null | undefined, digits = 1): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value.toFixed(digits)}%`;
}

/** Chain name for a chainId the API has not described (wallet on an unknown network). */
export function chainName(chainId: number | null | undefined, known?: string | null): string {
  if (known) return known;
  if (chainId === null || chainId === undefined) return "unknown network";
  if (chainId === 16602) return "0G Galileo testnet";
  if (chainId === 16661) return "0G mainnet";
  if (chainId === 31337) return "Local anvil";
  return `chain ${chainId}`;
}

/** The topbar chip is narrow — "0G Galileo testnet" becomes "0G testnet". */
export function shortChainName(name: string): string {
  return name.replace(/^0G\s+\w+\s+testnet$/i, "0G testnet").replace(/\s+Testnet$/i, " testnet");
}

export function explorerAddressUrl(explorer: string | null | undefined, address: string | null | undefined): string | null {
  if (!explorer || !address) return null;
  return `${explorer.replace(/\/$/, "")}/address/${address}`;
}

export function explorerTxUrl(explorer: string | null | undefined, txHash: string | null | undefined): string | null {
  if (!explorer || !txHash) return null;
  return `${explorer.replace(/\/$/, "")}/tx/${txHash}`;
}
