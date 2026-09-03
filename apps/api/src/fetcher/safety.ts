/**
 * Content-safety screen for anything about to become a public artifact.
 *
 * Threat model, "Personal data in a public artifact": `/v1/tasks/prepare`
 * rejects inputs matching email addresses, payment card numbers,
 * phone-number-with-context, national ID patterns and private-key-with-context.
 *
 * Two design constraints follow from that being a *guardrail* rather than a DLP
 * product. First, a false positive is expensive — it blocks a legitimate task —
 * so the shapes that overlap with ordinary technical text (16 digits, 64 hex
 * characters, a run of digits) are only reported when a checksum or a nearby
 * context word says so, and the near misses come back as warnings instead.
 * Second, nothing matched is ever echoed back: the response would otherwise
 * become the second copy of the secret the creator was trying not to publish.
 */

export const PERSONAL_DATA_KINDS = [
  "email",
  "payment-card",
  "phone",
  "national-id",
  "private-key",
] as const;
export type PersonalDataKind = (typeof PERSONAL_DATA_KINDS)[number];

export interface PersonalDataMatch {
  field: string;
  kind: PersonalDataKind;
  /** Surrounding text with the match itself replaced by a redaction marker. */
  excerpt: string;
}

export interface PersonalDataScreen {
  ok: boolean;
  matches: PersonalDataMatch[];
  /** Advisory notes for the manifest's `safety.warnings`; never blocking. */
  warnings: string[];
}

interface Span {
  kind: PersonalDataKind;
  start: number;
  end: number;
  /** Higher wins when two detectors claim overlapping text. */
  rank: number;
  label: string;
}

const RANK: Record<PersonalDataKind, number> = {
  "private-key": 5,
  "payment-card": 4,
  "national-id": 3,
  email: 2,
  phone: 1,
};

/* ── context words ───────────────────────────────────────────────────────── */

/**
 * Whole-word matching, not substring: "tel" must not fire on "hotel", and a
 * space in a phrase also matches an underscore or a hyphen so `private_key`
 * and `private-key` need no separate entries.
 */
function contextRegex(words: string[]): RegExp {
  const alternatives = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_-]+"))
    .join("|");
  return new RegExp(`(?:^|[^a-z0-9])(?:${alternatives})(?:[^a-z0-9]|$)`, "i");
}

const PHONE_CONTEXT = contextRegex([
  "phone",
  "phones",
  "telephone",
  "tel",
  "telp",
  "mobile",
  "cell",
  "cellphone",
  "whatsapp",
  "fax",
  "call",
  "contact",
  "kontak",
  "hubungi",
  "reach me at",
]);
const SSN_CONTEXT = contextRegex(["ssn", "social security"]);
const NIK_CONTEXT = contextRegex(["nik", "ktp", "nomor induk kependudukan", "kependudukan"]);
const AADHAAR_CONTEXT = contextRegex(["aadhaar", "aadhar", "uidai"]);
const NINO_CONTEXT = contextRegex(["national insurance", "nino", "ni number"]);
const KEY_CONTEXT = contextRegex([
  "private key",
  "privatekey",
  "priv key",
  "privkey",
  "secret key",
  "secretkey",
  "signing key",
  "keystore",
  "mnemonic",
  "seed phrase",
  "recovery phrase",
  "wallet secret",
]);

const BEFORE_WINDOW = 72;
const AFTER_WINDOW = 40;

/**
 * True when the context wording appears close enough to the match to be talking
 * about it. Both sides are checked, because "private key: 0x..." and "0x... is
 * my private key" are the same disclosure, and the field name counts as context
 * so a field literally called `privateKey` needs no wording at all.
 */
function hasContext(text: string, field: string, start: number, end: number, words: RegExp): boolean {
  const haystack =
    `${field} ` +
    text.slice(Math.max(0, start - BEFORE_WINDOW), start) +
    " " +
    text.slice(end, end + AFTER_WINDOW);
  return words.test(haystack);
}

/* ── checksums and shape tests ───────────────────────────────────────────── */

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD_LENGTHS = new Set([13, 14, 15, 16, 19]);

/**
 * Luhn alone is not enough: one in ten arbitrary numbers passes it, and order
 * ids are exactly the kind of arbitrary number a claim contains. The issuer
 * ranges narrow that to numbers that could actually be printed on a card.
 */
function looksLikeCard(raw: string, digits: string): boolean {
  if (!CARD_LENGTHS.has(digits.length)) return false;
  if (raw.includes("+") || raw.includes("(") || raw.includes(".")) return false; // phone shapes
  if (!/^[3-6]/.test(digits)) return false; // Amex/Diners, Visa, Mastercard, Discover/UnionPay
  return luhn(digits);
}

/** Real Indonesian province codes; a random 16-digit id almost never starts with one. */
const NIK_PROVINCES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 31, 32, 33, 34, 35, 36, 51, 52, 53, 61, 62, 63, 64, 65, 71,
  72, 73, 74, 75, 76, 81, 82, 91, 92, 93, 94, 95, 96,
]);

/** Province + regency + district, then DDMMYY with +40 on the day for women. */
function looksLikeNik(digits: string): boolean {
  if (digits.length !== 16) return false;
  if (!NIK_PROVINCES.has(Number(digits.slice(0, 2)))) return false;
  if (Number(digits.slice(2, 4)) === 0 || Number(digits.slice(4, 6)) === 0) return false;
  const rawDay = Number(digits.slice(6, 8));
  const day = rawDay > 40 ? rawDay - 40 : rawDay;
  const month = Number(digits.slice(8, 10));
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  return Number(digits.slice(12)) !== 0; // serial is 1-based
}

const SSN_INVALID_AREA = /^(?:000|666|9\d\d)/;

function looksLikeSsn(digits: string): boolean {
  if (digits.length !== 9) return false;
  if (SSN_INVALID_AREA.test(digits)) return false;
  return digits.slice(3, 5) !== "00" && digits.slice(5) !== "0000";
}

/* ── detectors ───────────────────────────────────────────────────────────── */

/**
 * Every repetition is bounded, and deliberately so. The unbounded form —
 * `[A-Za-z0-9-]*[A-Za-z0-9]` inside an optional group, repeated by a `*` —
 * backtracks quadratically on a host-shaped run that never terminates, e.g.
 * `a@` followed by `a-` repeated: measured 45 ms at 8 KB, which is ~28 s for one
 * 200 KB inlineText field, on a route that needs no authentication.
 *
 * The bounds are the real limits, so nothing legitimate stops matching: 64 for
 * the local part (RFC 5321), 63 per DNS label (1 + 61 + 1), and 8 levels of
 * subdomain, which no address in a public source is going to exceed.
 */
const EMAIL =
  /\b[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){0,8}\.[A-Za-z]{2,24}\b/g;

/** A run of digits with the separators people actually type, no line breaks. */
const NUMERIC_RUN = /\+?\d(?:[\d \t().-]{5,30}\d)?/g;

const SSN_FORMATTED = /\b\d{3}-\d{2}-\d{4}\b/g;
const NPWP_FORMATTED = /\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g;
const NINO = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g;
const AADHAAR = /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g;

const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
/** Base58 WIF; the 5/K/L prefix and length make it distinctive on its own. */
const WIF_KEY = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const HEX_64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const WORD_RUN = /\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/g;

const SEMVER = /^\d+(?:\.\d+){2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface FieldScan {
  spans: Span[];
  warnings: string[];
}

function scanField(field: string, text: string): FieldScan {
  const spans: Span[] = [];
  const warnings: string[] = [];
  const add = (kind: PersonalDataKind, start: number, end: number, label: string) => {
    spans.push({ kind, start, end, rank: RANK[kind], label });
  };
  const at = (match: RegExpMatchArray): [number, number] => {
    const start = match.index ?? 0;
    return [start, start + match[0].length];
  };

  for (const match of text.matchAll(EMAIL)) {
    const [start, end] = at(match);
    add("email", start, end, "email address");
  }

  for (const match of text.matchAll(PEM_PRIVATE_KEY)) {
    const [start, end] = at(match);
    add("private-key", start, end, "PEM private key");
  }
  for (const match of text.matchAll(WIF_KEY)) {
    const [start, end] = at(match);
    add("private-key", start, end, "WIF private key");
  }
  for (const match of text.matchAll(HEX_64)) {
    const [start, end] = at(match);
    // A bare 64-hex string is also every content hash in this system, so the
    // context wording is what separates a key from a `manifestHash`.
    if (hasContext(text, field, start, end, KEY_CONTEXT)) {
      add("private-key", start, end, "private key");
    } else {
      warnings.push(
        `${field} contains a 64-character hex string; if that is a private key it must not be submitted`,
      );
    }
  }
  for (const match of text.matchAll(WORD_RUN)) {
    const [start, end] = at(match);
    if (hasContext(text, field, start, end, KEY_CONTEXT)) {
      add("private-key", start, end, "recovery phrase");
    }
  }

  for (const match of text.matchAll(SSN_FORMATTED)) {
    const [start, end] = at(match);
    if (looksLikeSsn(match[0].replace(/\D/g, ""))) {
      add("national-id", start, end, "US social security number");
    }
  }
  for (const match of text.matchAll(NPWP_FORMATTED)) {
    const [start, end] = at(match);
    add("national-id", start, end, "Indonesian NPWP");
  }
  for (const match of text.matchAll(NINO)) {
    const [start, end] = at(match);
    if (hasContext(text, field, start, end, NINO_CONTEXT)) {
      add("national-id", start, end, "UK national insurance number");
    }
  }
  for (const match of text.matchAll(AADHAAR)) {
    const [start, end] = at(match);
    if (hasContext(text, field, start, end, AADHAAR_CONTEXT)) {
      add("national-id", start, end, "Aadhaar number");
    }
  }

  for (const match of text.matchAll(NUMERIC_RUN)) {
    const raw = match[0];
    const [start, end] = at(match);
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7) continue;

    if (looksLikeCard(raw, digits)) {
      add("payment-card", start, end, "payment card number");
      continue;
    }
    if (digits.length === 16 && (looksLikeNik(digits) || hasContext(text, field, start, end, NIK_CONTEXT))) {
      add("national-id", start, end, "Indonesian NIK");
      continue;
    }
    if (digits.length === 9 && looksLikeSsn(digits) && hasContext(text, field, start, end, SSN_CONTEXT)) {
      add("national-id", start, end, "US social security number");
      continue;
    }
    if (digits.length === 12 && hasContext(text, field, start, end, AADHAAR_CONTEXT)) {
      add("national-id", start, end, "Aadhaar number");
      continue;
    }

    const phoneShaped =
      digits.length >= 8 &&
      digits.length <= 15 &&
      !SEMVER.test(raw.trim()) &&
      !ISO_DATE.test(raw.trim());
    if (phoneShaped && hasContext(text, field, start, end, PHONE_CONTEXT)) {
      add("phone", start, end, "phone number");
      continue;
    }

    // Nothing matched, so say what was nearly matched. A number that is the
    // right length for a card but fails Luhn is the common case: an order id.
    if (CARD_LENGTHS.has(digits.length) && !raw.includes("+")) {
      warnings.push(
        `${field} contains a ${digits.length}-digit number that is not a valid payment card; it is stored publicly exactly as written`,
      );
    } else if (phoneShaped && (/[+()]/.test(raw) || /\d[ -]\d/.test(raw))) {
      warnings.push(
        `${field} contains a number formatted like a phone number but with no contact wording; it is stored publicly exactly as written`,
      );
    }
  }

  return { spans, warnings };
}

/** Keeps the highest-ranked span of each overlapping group, earliest first. */
function resolveOverlaps(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.rank - a.rank || b.end - a.end);
  const kept: Span[] = [];
  for (const span of ordered) {
    const clash = kept.findIndex((other) => span.start < other.end && other.start < span.end);
    if (clash === -1) {
      kept.push(span);
      continue;
    }
    const other = kept[clash] as Span;
    if (span.rank > other.rank || (span.rank === other.rank && span.end - span.start > other.end - other.start)) {
      kept[clash] = span;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Builds the excerpt from a copy of the field in which *every* match is already
 * redacted, so the window around one secret cannot leak the one next to it.
 */
function redactedExcerpts(text: string, spans: Span[]): string[] {
  let redacted = "";
  const offsets: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const span of spans) {
    redacted += text.slice(cursor, span.start);
    const marker = `[REDACTED ${span.label}, ${span.end - span.start} chars]`;
    offsets.push({ start: redacted.length, end: redacted.length + marker.length });
    redacted += marker;
    cursor = span.end;
  }
  redacted += text.slice(cursor);

  return offsets.map(({ start, end }) => {
    const before = redacted.slice(Math.max(0, start - 32), start);
    const after = redacted.slice(end, end + 32);
    const lead = start > 32 ? "…" : "";
    const trail = end + 32 < redacted.length ? "…" : "";
    return `${lead}${before}${redacted.slice(start, end)}${after}${trail}`.replace(/\s+/g, " ").trim();
  });
}

/**
 * Screens a set of named fields. `ok` is false when anything matched, which is
 * what `/v1/tasks/prepare` turns into `PERSONAL_DATA_REJECTED`; `warnings` is
 * what the manifest records in `safety.warnings` when the task goes ahead.
 */
export function screenForPersonalData(fields: Record<string, string>): PersonalDataScreen {
  const matches: PersonalDataMatch[] = [];
  const warnings: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || !value) continue;
    const scan = scanField(field, value);
    const spans = resolveOverlaps(scan.spans);
    const excerpts = redactedExcerpts(value, spans);
    spans.forEach((span, index) => {
      matches.push({ field, kind: span.kind, excerpt: excerpts[index] ?? `[REDACTED ${span.label}]` });
    });
    // Deduped by text, so a field with twenty order ids produces one warning.
    for (const warning of scan.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  return { ok: matches.length === 0, matches, warnings };
}
