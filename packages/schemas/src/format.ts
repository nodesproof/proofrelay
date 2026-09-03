/** Presentation helpers shared by the API and the UI so both agree on wording. */

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

/** wei -> "10.00 0G". Fixed two decimals matches the task table's column width. */
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

/** "8 min ago" — the relative wording the task table and timeline both use. */
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

/** The timeline groups by TODAY / YESTERDAY / an explicit date. */
export function dayBucket(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffDays = Math.round((startOf(now) - startOf(then)) / 86_400_000);
  if (diffDays <= 0) return "TODAY";
  if (diffDays === 1) return "YESTERDAY";
  return then
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

export function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** PR-1048 style handle, stable for a given creation index. */
export function taskRef(sequence: number): string {
  return `PR-${1000 + sequence}`;
}
