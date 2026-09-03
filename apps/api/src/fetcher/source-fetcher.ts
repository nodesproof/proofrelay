/**
 * SSRF-safe source fetcher.
 *
 * The threat model ("SSRF through a source URL") claims this refuses private,
 * loopback, link-local, carrier-grade-NAT, multicast and reserved destinations,
 * re-validates every redirect hop, and size-caps the response while streaming.
 *
 * Two consequences of taking that claim literally:
 *
 * 1. DNS is resolved here and the connection is *pinned* to the address that
 *    was validated. Validating a hostname and then handing the same hostname to
 *    the socket layer leaves a rebinding window between the two lookups, which
 *    is the standard way this guard is defeated. That rules out `fetch`, which
 *    does not expose the resolved address, so the request is issued through
 *    node:http/node:https with a custom `lookup`.
 * 2. Every hop is a fresh validation, not a fresh check of the first hostname.
 *    A public host redirecting to 169.254.169.254 is refused at the hop.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { SCHEMA_VERSION, contentHash, type SourceSnapshot } from "@proofrelay/schemas";

export const DEFAULT_MAX_BYTES = 524_288;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443];
const DEFAULT_PRODUCER = "proofrelay-api/1.0.0";
const DEFAULT_USER_AGENT = "ProofRelay-SourceFetcher/1.0 (+https://proofrelay.xyz)";

/* ── address classification ──────────────────────────────────────────────── */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "carrier-grade-nat"
  | "unique-local"
  | "multicast"
  | "broadcast"
  | "unspecified"
  | "ipv4-mapped"
  | "reserved";

const CLASS_DESCRIPTION: Record<AddressClass, string> = {
  public: "a public address",
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address",
  "carrier-grade-nat": "a carrier-grade-NAT address",
  "unique-local": "a unique-local address",
  multicast: "a multicast address",
  broadcast: "a broadcast address",
  unspecified: "an unspecified address",
  "ipv4-mapped": "an IPv4-mapped IPv6 address",
  reserved: "a reserved address",
};

/**
 * The only classes `FETCH_ALLOW_PRIVATE=1` relaxes. Link-local stays refused in
 * every configuration because 169.254.169.254 is the whole point of the attack;
 * an escape hatch that unblocks the cloud metadata service is not an escape
 * hatch, it is the vulnerability with a flag in front of it.
 */
const RELAXABLE: ReadonlySet<AddressClass> = new Set<AddressClass>([
  "loopback",
  "private",
  "unique-local",
]);

function classifyIpv4(ip: string): AddressClass {
  const parts = ip.split(".").map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  const d = parts[3] ?? 0;

  if (a === 0) return "unspecified"; // 0.0.0.0/8 "this network"
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat"; // 100.64.0.0/10
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved"; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay anycast
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a >= 224 && a <= 239) return "multicast";
  if (a === 255 && b === 255 && c === 255 && d === 255) return "broadcast";
  if (a >= 240) return "reserved";
  return "public";
}

/** 16 bytes, or null when the literal is not a parseable IPv6 address. */
function ipv6Bytes(ip: string): Uint8Array | null {
  if (isIP(ip) !== 6) return null;
  let text = (ip.split("%")[0] ?? "").replace(/^\[|\]$/g, "");

  // A dotted-quad tail (::ffff:1.2.3.4, 64:ff9b::203.0.113.1) is two groups.
  let quad: number[] = [];
  const dotted = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    quad = (dotted[1] ?? "").split(".").map(Number);
    if (quad.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    text = text.slice(0, dotted.index + 1); // keep the ':' so "::ffff:" stays well formed
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toBytes = (chunk: string | undefined): number[] | null => {
    const out: number[] = [];
    for (const group of (chunk ?? "").split(":").filter((g) => g !== "")) {
      const value = Number.parseInt(group, 16);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff || !/^[0-9a-f]{1,4}$/i.test(group)) {
        return null;
      }
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };

  const head = toBytes(halves[0]);
  const tail = toBytes(halves[1]);
  if (head === null || tail === null) return null;
  const suffix = [...tail, ...quad];
  const gap = 16 - head.length - suffix.length;
  if (gap < 0) return null;
  if (halves.length === 1 && gap !== 0) return null;

  const bytes = new Uint8Array(16);
  bytes.set(head, 0);
  bytes.set(suffix, 16 - suffix.length);
  return bytes;
}

function classifyIpv6(ip: string): AddressClass {
  const bytes = ipv6Bytes(ip);
  if (!bytes) return "reserved"; // unparseable is never something we dial
  const at = (i: number) => bytes[i] ?? 0;
  const zeros = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (at(i) !== 0) return false;
    return true;
  };

  if (zeros(0, 16)) return "unspecified";
  if (zeros(0, 15) && at(15) === 1) return "loopback";
  if (zeros(0, 10) && at(10) === 0xff && at(11) === 0xff) return "ipv4-mapped";
  if (at(0) === 0xff) return "multicast";
  if ((at(0) & 0xfe) === 0xfc) return "unique-local"; // fc00::/7
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0xc0) return "reserved"; // fec0::/10 site-local
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) return "reserved"; // NAT64
  if (at(0) === 0x01 && at(1) === 0x00 && zeros(2, 8)) return "reserved"; // 100::/64 discard
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return "reserved"; // 2001:db8::/32
  // 2001::/23 and 2002::/16 tunnel to an arbitrary IPv4 endpoint we never got
  // to validate, so the outer address tells us nothing about the destination.
  if (at(0) === 0x20 && at(1) === 0x01 && (at(2) & 0xfe) === 0x00) return "reserved";
  if (at(0) === 0x20 && at(1) === 0x02) return "reserved";
  // Global unicast is 2000::/3 and nothing else is, so an address that matched
  // no rule above is refused rather than assumed routable. Without this the
  // `::/96` hole is open: `http://[::127.0.0.1]/` normalises to `::7f00:1` and
  // `[::ffff:0:127.0.0.1]` to `::ffff:0:7f00:1` — the deprecated IPv4-compatible
  // and the IPv4-translated encodings of a loopback address — and both would
  // reach this line classified as public. Whether a given kernel routes them is
  // not something a guard should be betting on.
  if ((at(0) & 0xe0) !== 0x20) return "reserved";
  return "public";
}

export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return "reserved";
}

export function isBlockedAddress(ip: string, allowPrivate = false): boolean {
  const kind = classifyAddress(ip);
  if (kind === "public") return false;
  return !(allowPrivate && RELAXABLE.has(kind));
}

/* ── configuration ───────────────────────────────────────────────────────── */

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowPrivate: boolean;
  allowedPorts: number[];
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Test seam: lets a suite pin a hostname without touching a real resolver. */
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface FetchOptions extends Partial<FetchLimits> {
  producer?: string;
  userAgent?: string;
  now?: () => Date;
  resolver?: AddressResolver;
  env?: NodeJS.ProcessEnv;
}

export interface RemoteSource {
  sourceId: string;
  uri: string;
}

export interface InlineSource {
  sourceId: string;
  inlineText: string;
  /** Label the pasted text as if it came from here; the fetcher never dials it. */
  uri?: string;
}

export type SourceInput = RemoteSource | InlineSource;

function isInline(input: SourceInput): input is InlineSource {
  return typeof (input as InlineSource).inlineText === "string";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): FetchLimits {
  return {
    maxBytes: positiveInt(env.FETCH_MAX_BYTES, DEFAULT_MAX_BYTES),
    timeoutMs: positiveInt(env.FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRedirects: positiveInt(env.FETCH_MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS),
    // Anything other than the literal "1" leaves the guard on, so a typo or an
    // empty value fails closed.
    allowPrivate: env.FETCH_ALLOW_PRIVATE === "1",
    allowedPorts: [...DEFAULT_ALLOWED_PORTS],
  };
}

function resolveLimits(options: FetchOptions): FetchLimits {
  const base = limitsFromEnv(options.env ?? process.env);
  return {
    maxBytes: options.maxBytes ?? base.maxBytes,
    timeoutMs: options.timeoutMs ?? base.timeoutMs,
    maxRedirects: options.maxRedirects ?? base.maxRedirects,
    allowPrivate: options.allowPrivate ?? base.allowPrivate,
    allowedPorts: options.allowedPorts ?? base.allowedPorts,
  };
}

/* ── failures ────────────────────────────────────────────────────────────── */

/** Refused by policy — scheme, port, address class, or redirect budget. */
class SourceBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceBlocked";
  }
}

/** Reached, but did not answer usefully. */
class SourceUnavailable extends Error {
  readonly httpStatus: number | null;
  readonly headers: Record<string, string>;

  constructor(message: string, httpStatus: number | null = null, headers: Record<string, string> = {}) {
    super(message);
    this.name = "SourceUnavailable";
    this.httpStatus = httpStatus;
    this.headers = headers;
  }
}

/* ── text extraction ─────────────────────────────────────────────────────── */

/**
 * Removes `<script>` and `<style>` from text that is about to be stored, and
 * also removes an *unterminated* one: the byte cap can cut a document in the
 * middle of a script block, and the surviving half would otherwise be stored as
 * ordinary text.
 *
 * Scanned rather than matched. The regex this replaces — `<script\b[^>]*>` —
 * backtracks quadratically on a body that repeats `<script` and never supplies
 * a `>`: every occurrence rescans to the end of the input for a delimiter that
 * is not there. At the 512 KB byte cap that measured 45 s of blocked event loop
 * from one fetched URL, and htmlToText calls this twice per document. A forward
 * scan reaches the same answer in one pass because the delimiters are literals.
 */
export function stripActiveMarkup(input: string): string {
  return stripTagBlocks(stripTagBlocks(input, "script"), "style");
}

const GT = 0x3e;

/** `\b` after the tag name, so `<scriptable>` is not a script tag. */
function isWordByte(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z (input is lowercased)
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f // _
  );
}

function isSpaceByte(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/** Index just past a `</tag\s*>`, or -1 when the block never closes. */
function findClosingTag(lower: string, tag: string, from: number): number {
  const close = `</${tag}`;
  let at = from;
  for (;;) {
    const found = lower.indexOf(close, at);
    if (found === -1) return -1;
    let i = found + close.length;
    while (i < lower.length && isSpaceByte(lower.charCodeAt(i))) i += 1;
    if (lower.charCodeAt(i) === GT) return i + 1;
    at = found + close.length;
  }
}

function stripTagBlocks(input: string, tag: string): string {
  const open = `<${tag}`;
  const lower = input.toLowerCase();
  let out = "";
  let cursor = 0;

  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) break;

    const nameEnd = start + open.length;
    if (isWordByte(lower.charCodeAt(nameEnd))) {
      out += input.slice(cursor, nameEnd);
      cursor = nameEnd;
      continue;
    }

    // The open tag never closes, so no block after it can close either. Leaving
    // the remainder as text is what the regex did, and this is the early exit
    // that keeps the whole scan linear.
    const openEnd = lower.indexOf(">", nameEnd);
    if (openEnd === -1) break;

    const closeAt = findClosingTag(lower, tag, openEnd + 1);
    out += input.slice(cursor, start) + " ";
    if (closeAt === -1) return out; // cut mid-block by the byte cap: drop the tail
    cursor = closeAt;
  }

  return out + input.slice(cursor);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith("#")) {
      const code = key.startsWith("#x")
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[key] ?? whole;
  });
}

export function htmlToText(input: string): string {
  const stripped = stripActiveMarkup(input)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/, " ")
    .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/<[^>]*$/, " "); // a tag the byte cap cut in half

  // Decoding runs last, and the result is re-stripped: `&lt;script&gt;…` would
  // otherwise decode into a live-looking tag inside the text we store.
  return stripActiveMarkup(decodeEntities(stripped))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function charsetOf(contentType: string | null): string {
  const match = contentType ? /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType) : null;
  const label = (match?.[1] ?? "utf-8").toLowerCase();
  switch (label) {
    case "utf8":
    case "utf-8":
    case "us-ascii":
    case "ascii":
      return "utf-8";
    case "iso-8859-1":
    case "latin1":
    case "windows-1252":
    case "cp1252":
      return "windows-1252";
    default:
      return "utf-8";
  }
}

function decodeBody(body: Buffer, contentType: string | null): string {
  let text: string;
  try {
    text = new TextDecoder(charsetOf(contentType)).decode(body);
  } catch {
    text = body.toString("utf8");
  }
  // CRLF is normalised because the stored text is what verifiers quote spans
  // out of: a stray CR shifts every offset by one for no benefit.
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function looksLikeHtml(text: string, contentType: string | null): boolean {
  if (contentType && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) return true;
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
}

function toStoredText(body: Buffer, contentType: string | null): string {
  const decoded = decodeBody(body, contentType);
  return looksLikeHtml(decoded, contentType) ? htmlToText(decoded) : stripActiveMarkup(decoded);
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

/**
 * Response headers worth keeping in a public artifact. An allow-list rather
 * than a filter: the snapshot is uploaded to 0G Storage permanently, so
 * `set-cookie` and friends must not be able to arrive there by accident.
 */
const KEEP_HEADERS = ["content-type", "content-length", "content-language", "etag", "last-modified", "date"];

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function parseTarget(raw: string, limits: FetchLimits): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceBlocked(`${raw} is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceBlocked(`scheme ${url.protocol.replace(":", "")} is not allowed`);
  }
  // `http://trusted.example@169.254.169.254/` parses with host 169.254.169.254;
  // refusing userinfo outright removes the confusion rather than relying on it.
  if (url.username || url.password) {
    throw new SourceBlocked("credentials in the URL are not allowed");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!limits.allowedPorts.includes(port)) {
    throw new SourceBlocked(`port ${port} is not allowed`);
  }
  if (!stripBrackets(url.hostname)) {
    throw new SourceBlocked("the URL has no host");
  }
  return url;
}

async function resolveTarget(
  url: URL,
  limits: FetchLimits,
  resolver: AddressResolver | undefined,
): Promise<ResolvedAddress> {
  const host = stripBrackets(url.hostname);
  let answers: ResolvedAddress[];
  try {
    answers = resolver
      ? await resolver(host)
      : await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new SourceUnavailable(`${host} did not resolve: ${describe(error)}`);
  }
  if (!answers.length) throw new SourceBlocked(`${host} resolved to no addresses`);

  // Every answer must be public, not just the one we dial: a record that mixes
  // a public address with 127.0.0.1 would otherwise be a coin flip.
  for (const answer of answers) {
    const kind = classifyAddress(answer.address);
    if (kind !== "public" && !(limits.allowPrivate && RELAXABLE.has(kind))) {
      // The class, not the address. The snapshot's `error` is written into a
      // permanent public artifact, so naming the address the hostname RESOLVED
      // to let an anonymous caller point a source at a host it controls and read
      // the resolution back out — the SSRF guard answering as an internal-network
      // scanner. A creator needs to know the destination was refused and why in
      // kind; nobody outside needs the address.
      throw new SourceBlocked(
        `${host} resolves to ${CLASS_DESCRIPTION[kind]}`,
      );
    }
  }
  return answers[0] as ResolvedAddress;
}

/** Forces the socket onto the address we just validated, closing the rebind window. */
function pinnedLookup(target: ResolvedAddress): RequestOptions["lookup"] {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll =
      typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as RequestOptions["lookup"];
}

function sendRequest(
  url: URL,
  target: ResolvedAddress,
  signal: AbortSignal,
  userAgent: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: url.protocol,
        hostname: stripBrackets(url.hostname),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        lookup: pinnedLookup(target),
        headers: {
          host: url.host,
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
          // `identity` keeps the streaming cap honest: the bytes counted on the
          // wire are the bytes stored, with no decompression bomb in between.
          "accept-encoding": "identity",
          "user-agent": userAgent,
          connection: "close",
        },
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const room = maxBytes - size;
    if (buffer.length > room) {
      chunks.push(buffer.subarray(0, Math.max(room, 0)));
      truncated = true;
      break; // the async iterator destroys the stream, so the rest is never pulled
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  response.destroy();
  return { body: Buffer.concat(chunks), truncated };
}

function pickHeaders(response: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of KEEP_HEADERS) {
    const value = response.headers[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

interface HttpResult {
  finalUrl: URL;
  httpStatus: number;
  headers: Record<string, string>;
  contentType: string | null;
  body: Buffer;
  truncated: boolean;
  redirects: number;
}

async function fetchOverHttp(
  rawUri: string,
  limits: FetchLimits,
  options: FetchOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);

  try {
    let url = parseTarget(rawUri, limits);
    let redirects = 0;

    for (;;) {
      const target = await resolveTarget(url, limits, options.resolver);
      let response: IncomingMessage;
      try {
        response = await sendRequest(url, target, controller.signal, options.userAgent ?? DEFAULT_USER_AGENT);
      } catch (error) {
        if (timedOut) throw new SourceUnavailable(`timed out after ${limits.timeoutMs}ms`);
        throw new SourceUnavailable(describe(error));
      }

      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (REDIRECT_STATUS.has(status) && typeof location === "string" && location) {
        response.resume();
        response.destroy();
        if (redirects >= limits.maxRedirects) {
          throw new SourceBlocked(`more than ${limits.maxRedirects} redirects`);
        }
        redirects += 1;
        // Resolved against the *current* hop, then validated from scratch. This
        // is the line the threat model rests on: a public host cannot bounce
        // the fetcher into the metadata service.
        url = parseTarget(new URL(location, url).toString(), limits);
        continue;
      }

      const headers = pickHeaders(response);
      if (status < 200 || status >= 300) {
        response.resume();
        response.destroy();
        throw new SourceUnavailable(`HTTP ${status}`, status, headers);
      }

      let read: { body: Buffer; truncated: boolean };
      try {
        read = await readCapped(response, limits.maxBytes);
      } catch (error) {
        if (timedOut) throw new SourceUnavailable(`timed out after ${limits.timeoutMs}ms`, status, headers);
        throw new SourceUnavailable(describe(error), status, headers);
      }

      if (redirects > 0) {
        headers["x-proofrelay-final-url"] = url.toString();
        headers["x-proofrelay-redirects"] = String(redirects);
      }

      return {
        finalUrl: url,
        httpStatus: status,
        headers,
        contentType: headers["content-type"] ?? null,
        body: read.body,
        truncated: read.truncated,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/* ── snapshots ───────────────────────────────────────────────────────────── */

function baseSnapshot(sourceId: string, uri: string, producer: string, retrievedAt: string) {
  return {
    kind: "source-snapshot" as const,
    schemaVersion: SCHEMA_VERSION,
    producer,
    sourceId,
    uri,
    retrievedAt,
  };
}

function finish(
  base: ReturnType<typeof baseSnapshot>,
  fields: {
    status: SourceSnapshot["status"];
    httpStatus: number | null;
    contentType: string | null;
    headers: Record<string, string>;
    text: string;
    truncated: boolean;
    error: string | null;
  },
): SourceSnapshot {
  return {
    ...base,
    ...fields,
    byteLength: Buffer.byteLength(fields.text, "utf8"),
    // Hash the text that is actually stored, not the bytes that arrived: what a
    // verifier quotes and what the manifest commits to have to be the same thing.
    contentHash: contentHash(fields.text),
  };
}

function inlineSnapshot(
  input: InlineSource,
  limits: FetchLimits,
  producer: string,
  retrievedAt: string,
): SourceSnapshot {
  const normalised = input.inlineText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cleaned = looksLikeHtml(normalised, null)
    ? htmlToText(normalised)
    : stripActiveMarkup(normalised);

  let text = cleaned;
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    text = Buffer.from(text, "utf8").subarray(0, limits.maxBytes).toString("utf8");
    truncated = true;
  }

  return finish(baseSnapshot(input.sourceId, input.uri ?? `inline:${input.sourceId}`, producer, retrievedAt), {
    status: truncated ? "TRUNCATED" : "OK",
    // No request was made, so there is no status to report. The marker header
    // is how an inline source is told apart from a fetched one in the artifact.
    httpStatus: null,
    contentType: "text/plain; charset=utf-8",
    headers: { "x-proofrelay-source": "inline" },
    text,
    truncated,
    error: null,
  });
}

/**
 * Snapshots one source. Never throws: a task with one dead source must still be
 * creatable, so a failure is a snapshot carrying `status` and `error` rather
 * than an exception the caller has to unwind a half-built manifest around.
 */
export async function fetchSource(input: SourceInput, options: FetchOptions = {}): Promise<SourceSnapshot> {
  const limits = resolveLimits(options);
  const env = options.env ?? process.env;
  const producer = options.producer ?? env.PRODUCER_ID ?? DEFAULT_PRODUCER;
  const retrievedAt = (options.now?.() ?? new Date()).toISOString();

  if (isInline(input)) return inlineSnapshot(input, limits, producer, retrievedAt);

  const base = baseSnapshot(input.sourceId, input.uri, producer, retrievedAt);
  try {
    const result = await fetchOverHttp(input.uri, limits, options);
    const text = toStoredText(result.body, result.contentType);
    return finish(base, {
      status: result.truncated ? "TRUNCATED" : "OK",
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      headers: result.headers,
      text,
      truncated: result.truncated,
      error: null,
    });
  } catch (error) {
    const blocked = error instanceof SourceBlocked;
    const unavailable = error instanceof SourceUnavailable ? error : null;
    return finish(base, {
      status: blocked ? "REJECTED" : "SOURCE_UNAVAILABLE",
      httpStatus: unavailable?.httpStatus ?? null,
      contentType: null,
      headers: unavailable?.headers ?? {},
      text: "",
      truncated: false,
      error: `${blocked ? "SOURCE_BLOCKED" : "SOURCE_UNAVAILABLE"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/** Snapshots a whole source list, in order, without letting one failure stop the rest. */
export async function fetchSources(
  inputs: SourceInput[],
  options: FetchOptions = {},
): Promise<SourceSnapshot[]> {
  const out: SourceSnapshot[] = [];
  for (const input of inputs) out.push(await fetchSource(input, options));
  return out;
}
