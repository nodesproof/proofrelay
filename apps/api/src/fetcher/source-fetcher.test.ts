import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { SourceSnapshot } from "@proofrelay/schemas";
import { classifyAddress, fetchSource, fetchSources, stripActiveMarkup, type FetchOptions } from "./source-fetcher.js";

/** Every snapshot in this suite is schema-checked; a partial one is a failure. */
function parse(snapshot: unknown) {
  return SourceSnapshot.parse(snapshot);
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * The ranges the threat model names, one row each. These run with the guard in
 * its default state — no FETCH_ALLOW_PRIVATE — and reach `fetchSource` through
 * the real code path: an IP literal still goes through dns.lookup, it just
 * resolves to itself.
 */
const BLOCKED_ADDRESSES: Array<[string, string]> = [
  ["127.0.0.1", "loopback"],
  ["127.1.2.3", "loopback"],
  ["10.0.0.5", "private"],
  ["172.16.0.1", "private"],
  ["172.31.255.254", "private"],
  ["192.168.1.1", "private"],
  ["169.254.169.254", "link-local"],
  ["169.254.0.1", "link-local"],
  ["100.64.0.1", "carrier-grade-nat"],
  ["100.127.255.255", "carrier-grade-nat"],
  ["0.0.0.0", "unspecified"],
  ["255.255.255.255", "broadcast"],
  ["224.0.0.1", "multicast"],
  ["240.0.0.1", "reserved"],
  ["198.18.0.1", "reserved"],
  ["::1", "loopback"],
  ["::", "unspecified"],
  ["fc00::1", "unique-local"],
  ["fd12:3456:789a::1", "unique-local"],
  ["fe80::1", "link-local"],
  ["ff02::1", "multicast"],
  ["::ffff:169.254.169.254", "ipv4-mapped"],
  ["::ffff:10.0.0.1", "ipv4-mapped"],
  ["2001:db8::1", "reserved"],
  // `[::127.0.0.1]` and `[::ffff:0:127.0.0.1]` are what a URL bar accepts; these
  // are the forms the WHATWG parser hands the guard. Neither is IPv4-mapped, so
  // only the 2000::/3 global-unicast rule refuses them.
  ["::7f00:1", "reserved"],
  ["::ffff:0:7f00:1", "reserved"],
  ["::a9fe:a9fe", "reserved"],
  ["::2", "reserved"],
];

const PUBLIC_ADDRESSES = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"];

describe("address classification", () => {
  it.each(BLOCKED_ADDRESSES)("classifies %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each(PUBLIC_ADDRESSES)("classifies %s as public", (address) => {
    expect(classifyAddress(address)).toBe("public");
  });
});

describe("SSRF guard", () => {
  const url = (host: string) => (host.includes(":") ? `http://[${host}]/` : `http://${host}/`);

  it.each(BLOCKED_ADDRESSES)("refuses %s (%s)", async (address, kind) => {
    const snapshot = parse(await fetchSource({ sourceId: "s1", uri: url(address) }));
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("SOURCE_BLOCKED");
    expect(snapshot.error?.toLowerCase()).toContain(kind);
    expect(snapshot.text).toBe("");
    expect(snapshot.httpStatus).toBeNull();
  });

  // The forms an attacker actually types, before the URL parser rewrites them:
  // 0177./decimal IPv4 collapse to 127.0.0.1, and the two zero-prefixed IPv6
  // encodings of a loopback address collapse to ::7f00:1 and ::ffff:0:7f00:1.
  it.each([
    "http://0177.0.0.1/",
    "http://2130706433/",
    "http://127.1/",
    "http://[::127.0.0.1]/",
    "http://[::ffff:0:127.0.0.1]/",
    "http://[0:0:0:0:0:0:7f00:1]/",
  ])("refuses %s however it is spelled", async (uri) => {
    const snapshot = parse(await fetchSource({ sourceId: "s1", uri }));
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("SOURCE_BLOCKED");
  });

  it("refuses a hostname that resolves to a private address", async () => {
    // `localhost` is a real name going through the real resolver; the guard has
    // to reject on the answer, not on the spelling of the host.
    const snapshot = parse(await fetchSource({ sourceId: "s1", uri: "http://localhost/" }));
    expect(snapshot.status).toBe("REJECTED");
    // The class, never the address it resolved to: this string is written into
    // a permanent public artifact, and naming the resolution would let an
    // anonymous caller read the guard's DNS answer back out.
    expect(snapshot.error).toContain("localhost resolves to a loopback address");
    expect(snapshot.error).not.toMatch(/127\.0\.0\.1|::1/);
  });

  it("refuses a hostname whose answer set mixes a public and a private address", async () => {
    const snapshot = parse(
      await fetchSource(
        { sourceId: "s1", uri: "http://mixed.example/" },
        {
          resolver: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "169.254.169.254", family: 4 },
          ],
        },
      ),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("a link-local address");
    expect(snapshot.error).not.toContain("169.254.169.254");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "data:text/plain,hi"])(
    "refuses the %s scheme",
    async (uri) => {
      const snapshot = parse(await fetchSource({ sourceId: "s1", uri }));
      expect(snapshot.status).toBe("REJECTED");
      expect(snapshot.error).toContain("is not allowed");
    },
  );

  it.each([22, 25, 3306, 6379, 11211, 5432])("refuses port %i", async (port) => {
    const snapshot = parse(await fetchSource({ sourceId: "s1", uri: `http://example.com:${port}/` }));
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain(`port ${port} is not allowed`);
  });

  it("refuses credentials in the URL", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "s1", uri: "http://user:pass@example.com/" }));
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("credentials");
  });

  it("is not fooled by userinfo dressed up as a public host", async () => {
    // The real host here is 169.254.169.254; refusing userinfo outright means
    // the guard never has to be right about which half of the string is the host.
    const snapshot = parse(
      await fetchSource({ sourceId: "s1", uri: "http://example.com@169.254.169.254/latest/meta-data/" }),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("credentials in the URL");
  });

  it("keeps link-local blocked even with the FETCH_ALLOW_PRIVATE escape hatch on", async () => {
    const snapshot = parse(
      await fetchSource(
        { sourceId: "s1", uri: "http://169.254.169.254/latest/meta-data/" },
        { allowPrivate: true },
      ),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("link-local");
  });

  it("leaves the guard on for any FETCH_ALLOW_PRIVATE value other than 1", async () => {
    for (const value of ["0", "", "true", "yes"]) {
      const snapshot = parse(
        await fetchSource(
          { sourceId: "s1", uri: "http://127.0.0.1/" },
          { env: { FETCH_ALLOW_PRIVATE: value } as NodeJS.ProcessEnv },
        ),
      );
      expect(snapshot.status, value).toBe("REJECTED");
    }
  });
});

describe("fetching a real response", () => {
  let server: Server;
  let port = 0;
  const sockets = new Set<Socket>();
  const BODY = "# acme-widgets\n\nThe current stable release is v1.4.0.\n";

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    switch (path) {
      case "/plain":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "set-cookie": "a=b" });
        res.end(BODY);
        return;
      case "/html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><head><title>acme</title>" +
            "<style>body{color:red}</style>" +
            "<script>alert('xss')</script></head>" +
            "<body><p>Release v1.4.0 ships today.</p>" +
            "<p>Escaped: &lt;script&gt;alert('nested')&lt;/script&gt;</p>" +
            "<script src='/x.js'></script></body></html>",
        );
        return;
      case "/big":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("a".repeat(2 * 1024 * 1024));
        return;
      case "/cut-script":
        // A script block that the byte cap will slice in half.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body><p>lead</p><script>${"var x=1;".repeat(500)}</script></body></html>`);
        return;
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      case "/to-hostname":
        res.writeHead(302, { location: "http://metadata.evil.example/latest/meta-data/" });
        res.end();
        return;
      case "/to-file":
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
        return;
      case "/to-plain":
        res.writeHead(302, { location: "/plain" });
        res.end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      case "/missing":
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
        return;
      case "/slow":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("start");
        return; // never ends
      default:
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    }
  };

  beforeAll(async () => {
    server = createServer(handle);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * The harness options stand in for `FETCH_ALLOW_PRIVATE=1` plus a port the
   * OS was willing to hand out; the default policy is asserted separately above.
   */
  const harness = (extra: FetchOptions = {}): FetchOptions => ({
    allowPrivate: true,
    allowedPorts: [port, 80, 443],
    ...extra,
  });

  const at = (path: string) => `http://127.0.0.1:${port}${path}`;

  it("stores the body and hashes exactly what it stored", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/plain") }, harness()));
    expect(snapshot.status).toBe("OK");
    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.text).toBe(BODY);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.contentHash).toBe(sha256(snapshot.text));
    expect(snapshot.byteLength).toBe(Buffer.byteLength(snapshot.text, "utf8"));
    expect(snapshot.contentType).toBe("text/plain; charset=utf-8");
    expect(new Date(snapshot.retrievedAt).toISOString()).toBe(snapshot.retrievedAt);
  });

  it("records an allow-list of headers and never a set-cookie", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/plain") }, harness()));
    expect(snapshot.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(Object.keys(snapshot.headers)).not.toContain("set-cookie");
  });

  it("strips script and style before storing", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/html") }, harness()));
    expect(snapshot.status).toBe("OK");
    expect(snapshot.text).toContain("Release v1.4.0 ships today.");
    expect(snapshot.text).not.toContain("alert(");
    expect(snapshot.text).not.toContain("color:red");
    expect(snapshot.text.toLowerCase()).not.toContain("<script");
    expect(snapshot.text.toLowerCase()).not.toContain("<style");
    expect(snapshot.contentHash).toBe(sha256(snapshot.text));
  });

  it("strips a script block the byte cap cut in half", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-001", uri: at("/cut-script") }, harness({ maxBytes: 256 })),
    );
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toContain("lead");
    expect(snapshot.text).not.toContain("var x=1;");
  });

  it("truncates at the byte cap instead of buffering the whole response", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-001", uri: at("/big") }, harness({ maxBytes: 1024 })),
    );
    expect(snapshot.status).toBe("TRUNCATED");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.byteLength).toBeLessThanOrEqual(1024);
    expect(snapshot.text).toBe("a".repeat(snapshot.byteLength));
    expect(snapshot.contentHash).toBe(sha256(snapshot.text));
  });

  it("refuses a redirect from a reachable host into the metadata service", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-001", uri: at("/to-metadata") }, harness()),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("a link-local address");
    // The host here IS the literal the caller wrote, so echoing it back
    // discloses nothing they did not already supply. What must never appear
    // is an address the guard RESOLVED from a hostname.
    expect(snapshot.error).toContain("link-local");
    expect(snapshot.text).toBe("");
  });

  it("re-resolves a redirect target hostname rather than trusting the first hop", async () => {
    // The hop is a name, not a literal, so the guard has to run DNS again on it.
    const snapshot = parse(
      await fetchSource(
        { sourceId: "src-001", uri: at("/to-hostname") },
        harness({
          resolver: async (hostname) =>
            hostname === "metadata.evil.example"
              ? [{ address: "169.254.169.254", family: 4 }]
              : [{ address: "127.0.0.1", family: 4 }],
        }),
      ),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("metadata.evil.example resolves to a link-local address");
    expect(snapshot.error).not.toContain("169.254.169.254");
  });

  it("refuses a redirect that changes scheme", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/to-file") }, harness()));
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("scheme file is not allowed");
  });

  it("produces exactly the fields the artifact schema stores", async () => {
    // Extra keys would silently change the canonical hash of every snapshot.
    const raw = await fetchSource({ sourceId: "src-001", uri: at("/plain") }, harness());
    expect(Object.keys(raw as object).sort()).toEqual(Object.keys(SourceSnapshot.shape).sort());
  });

  it("follows a redirect that stays allowed and records where it landed", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/to-plain") }, harness()));
    expect(snapshot.status).toBe("OK");
    expect(snapshot.text).toBe(BODY);
    expect(snapshot.headers["x-proofrelay-final-url"]).toBe(at("/plain"));
    expect(snapshot.headers["x-proofrelay-redirects"]).toBe("1");
  });

  it("gives up after the redirect budget", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-001", uri: at("/loop") }, harness({ maxRedirects: 3 })),
    );
    expect(snapshot.status).toBe("REJECTED");
    expect(snapshot.error).toContain("more than 3 redirects");
  });

  it("returns SOURCE_UNAVAILABLE for a non-2xx instead of throwing", async () => {
    const snapshot = parse(await fetchSource({ sourceId: "src-001", uri: at("/missing") }, harness()));
    expect(snapshot.status).toBe("SOURCE_UNAVAILABLE");
    expect(snapshot.httpStatus).toBe(404);
    expect(snapshot.error).toContain("HTTP 404");
    expect(snapshot.text).toBe("");
    expect(snapshot.contentHash).toBe(sha256(""));
  });

  it("returns SOURCE_UNAVAILABLE when nothing is listening", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const snapshot = parse(
      await fetchSource(
        { sourceId: "src-001", uri: `http://127.0.0.1:${deadPort}/` },
        harness({ allowedPorts: [deadPort] }),
      ),
    );
    expect(snapshot.status).toBe("SOURCE_UNAVAILABLE");
    expect(snapshot.error).toContain("ECONNREFUSED");
  });

  it("gives up on a response that never ends", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-001", uri: at("/slow") }, harness({ timeoutMs: 300 })),
    );
    expect(snapshot.status).toBe("SOURCE_UNAVAILABLE");
    expect(snapshot.error).toContain("timed out after 300ms");
  });
});

describe("inline sources", () => {
  const README =
    "# acme-widgets\n\nacme-widgets is a client library maintained by the core team.\n" +
    "The current stable release is v1.4.0 and it requires Node.js 20 or newer.\n" +
    "Installation instructions and the migration guide live in the docs directory.\n" +
    "The project publishes a release roughly every month.";

  it("reproduces a snapshot that is already in 0G Storage", async () => {
    // Pinned against .proofrelay/storage/05/1f/051f0933…json, an artifact that
    // was really produced and hashed: a change here changes the content hash of
    // every stored snapshot, which is why it is asserted rather than derived.
    const snapshot = parse(
      await fetchSource({
        sourceId: "src-002",
        uri: "https://example.org/acme-widgets/README.md",
        inlineText: README,
      }),
    );
    expect(snapshot.contentHash).toBe(
      "sha256:f76d898e970ece4b1bfb9e6f57ba9ae2732db0425ccfb91d7ae236a44c1b6d70",
    );
    expect(snapshot.byteLength).toBe(282);
    expect(snapshot.status).toBe("OK");
    expect(snapshot.httpStatus).toBeNull();
    expect(snapshot.headers).toEqual({ "x-proofrelay-source": "inline" });
    expect(snapshot.contentType).toBe("text/plain; charset=utf-8");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.error).toBeNull();
  });

  it("strips script from pasted HTML too", async () => {
    const snapshot = parse(
      await fetchSource({
        sourceId: "src-003",
        inlineText: "<html><body><p>hello</p><script>alert(1)</script></body></html>",
      }),
    );
    expect(snapshot.text).toBe("hello");
    expect(snapshot.uri).toBe("inline:src-003");
  });

  it("caps pasted text at the byte limit", async () => {
    const snapshot = parse(
      await fetchSource({ sourceId: "src-004", inlineText: "x".repeat(5000) }, { maxBytes: 100 }),
    );
    expect(snapshot.status).toBe("TRUNCATED");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.byteLength).toBe(100);
    expect(snapshot.contentHash).toBe(sha256(snapshot.text));
  });

  it("never reaches the network, so no address check applies", async () => {
    const snapshot = parse(
      await fetchSource({
        sourceId: "src-005",
        uri: "http://169.254.169.254/latest/meta-data/",
        inlineText: "pasted by hand",
      }),
    );
    expect(snapshot.status).toBe("OK");
    expect(snapshot.text).toBe("pasted by hand");
  });
});

describe("a source list", () => {
  it("survives one dead source so the task is still creatable", async () => {
    const snapshots = await fetchSources([
      { sourceId: "src-001", inlineText: "first source" },
      { sourceId: "src-002", uri: "http://169.254.169.254/latest/meta-data/" },
      { sourceId: "src-003", inlineText: "third source" },
    ]);
    expect(snapshots.map((s) => s.status)).toEqual(["OK", "REJECTED", "OK"]);
    expect(snapshots.map((s) => s.sourceId)).toEqual(["src-001", "src-002", "src-003"]);
    for (const snapshot of snapshots) parse(snapshot);
  });
});

describe("stripActiveMarkup", () => {
  /**
   * The body an attacker serves to make markup stripping the expensive part of
   * a fetch: `<script` repeated to the byte cap with no `>` anywhere, so every
   * occurrence looks like the start of a tag that never ends. The regex this
   * replaced backtracked over the whole remaining input at each one — measured
   * at ~45 s for this exact input, on an event loop the whole API shares.
   */
  it("stays linear on a body that repeats an unterminated tag to the byte cap", () => {
    const input = "<script".repeat(74_898); // 524,286 B — DEFAULT_MAX_BYTES
    const started = process.hrtime.bigint();
    const output = stripActiveMarkup(input);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // No `>` means no tag ever opens, so nothing is stripped.
    expect(output).toBe(input);
    expect(elapsedMs).toBeLessThan(100);
  });

  /** A single leading `>` defeats a "does the body contain a delimiter" shortcut. */
  it("stays linear when a delimiter exists but never closes a tag", () => {
    const input = `>${"<script".repeat(74_898)}`;
    const started = process.hrtime.bigint();
    stripActiveMarkup(input);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(100);
  });

  it("still strips the blocks and the tail the byte cap cut in half", () => {
    expect(stripActiveMarkup("a<script src='x'>evil()</script>b")).toBe("a b");
    expect(stripActiveMarkup("a<style>p{}</style>b")).toBe("a b");
    expect(stripActiveMarkup("a<script>var x = 1; // cut here")).toBe("a ");
    expect(stripActiveMarkup("a<SCRIPT>evil()</SCRIPT   >b")).toBe("a b");
    expect(stripActiveMarkup("<scriptable>kept</scriptable>")).toBe("<scriptable>kept</scriptable>");
  });
});
