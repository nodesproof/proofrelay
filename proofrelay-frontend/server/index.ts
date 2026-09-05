import express from "express";
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { cardFromTask, defaultCardSvg, injectHead, siteMeta, taskCardSvg, taskMeta } from "./og.js";
import { available, cached, remember, renderPng } from "./og-render.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Where the ProofRelay API is, as seen from this process — not from the
 * browser. The two are only the same when the browser is on this machine.
 */
const API_ORIGIN = (process.env.API_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/+$/, "");

/**
 * The origin this app is reached at, for the absolute `og:url` and `og:image` a
 * crawler needs — a relative one is ignored. Derived from the forwarded headers
 * when it is not configured, because the process itself only knows it is
 * listening on a port.
 */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");

/** A share card is not worth making the page wait for. */
const OG_FETCH_TIMEOUT_MS = Number(process.env.OG_FETCH_TIMEOUT_MS ?? 2_500);

/** Hop-by-hop and body-framing headers, which belong to one connection. */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "keep-alive", "upgrade"]);
/** `fetch` has already decoded the body, so its encoding headers would lie. */
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function originOf(req: express.Request): string {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0]!.trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]!.trim();
  return host ? `${proto}://${host}` : "";
}

/**
 * A task id as it may appear in a URL: the 32-byte id the contract mints, or
 * the `PR-…` handle the indexer assigns. Anything else is refused here rather
 * than concatenated into the API's URL.
 */
function taskRef(value: string): string | null {
  return /^(0x[0-9a-fA-F]{64}|[A-Za-z]{2}-\d{1,12})$/.test(value) ? value : null;
}

/**
 * The task behind a share link, or null. Every failure — a slow API, a 404, a
 * body that is not a task — lands in the same place: the page is served from
 * the plain shell, exactly as it was before this existed.
 */
async function fetchTask(ref: string): Promise<ReturnType<typeof cardFromTask>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_ORIGIN}/v1/tasks/${encodeURIComponent(ref)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return cardFromTask(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  const app = express();

  // The app serves attacker-influenced content: task titles, claims, source URLs
  // and verifier report bodies all originate with users or with snapshotted
  // pages. Nothing here replaces escaping, but a CSP is the backstop for the
  // mistake that gets through, and it costs one middleware.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        // Vite emits a small inline bootstrap; styles are inlined by the build.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        // The API and the wallet's RPC. Same-origin plus the configured API.
        "connect-src *",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });
  const server = createServer(app);

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  /**
   * The API, on this origin.
   *
   * Built with `VITE_API_URL=/api`, the page asks its own origin for data
   * instead of an absolute address. That is what makes the app work through a
   * tunnel: `http://127.0.0.1:8080` compiled into the bundle names the
   * *visitor's* machine once the page is opened from anywhere else, and a
   * browser on an https page refuses an http call outright as mixed content.
   * Same-origin also means there is no CORS to configure and no second
   * hostname to route.
   *
   * Note for whoever reads the API's rate limits: every request now arrives
   * from this process, so without `trustProxy` on the Fastify side all visitors
   * share one bucket. The forwarded headers below are there so turning that on
   * is the only change needed.
   */
  app.use("/api", async (req, res) => {
    const target = `${API_ORIGIN}${req.url === "" ? "/" : req.url}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const forwarded = req.headers["x-forwarded-for"];
    const client = req.socket.remoteAddress ?? "";
    headers.set("x-forwarded-for", forwarded ? `${forwarded}, ${client}` : client);
    headers.set("x-forwarded-proto", (req.headers["x-forwarded-proto"] as string) ?? req.protocol);
    headers.set("x-forwarded-host", (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "");

    const sendsBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        // The request has not been parsed, so it is still a readable stream.
        // `duplex: "half"` is what lets fetch take one as a body.
        body: sendsBody ? (req as unknown as BodyInit) : undefined,
        ...(sendsBody ? { duplex: "half" } : {}),
        redirect: "manual",
      } as RequestInit);

      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name)) res.setHeader(name, value);
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (cause) {
      // The shape the client already knows how to render, rather than an HTML
      // error page it would fail to parse as JSON.
      res.status(502).json({
        error: {
          code: "CHAIN_UNAVAILABLE",
          message: `The ProofRelay API at ${API_ORIGIN} did not answer.`,
          detail: { cause: String((cause as Error)?.message ?? cause).slice(0, 200) },
        },
      });
    }
  });

  /**
   * The built shell, read once. The build does not change under a running
   * process, and re-reading it per request would put a synchronous file read in
   * front of every page view.
   */
  const shellPath = path.join(staticPath, "index.html");
  let shell: string | null = null;
  const readShell = (): string => (shell ??= fs.readFileSync(shellPath, "utf-8"));

  const sendPng = (res: express.Response, png: Buffer) => {
    res
      // Public, because the whole point is that a crawler and its CDN keep it.
      // Short, because a card changes while its task is still moving.
      .setHeader("Cache-Control", "public, max-age=300, s-maxage=300")
      .type("image/png")
      .end(png);
  };

  app.get("/og/default.png", async (_req, res) => {
    const hit = cached("default");
    if (hit) return sendPng(res, hit);
    const png = await renderPng(defaultCardSvg());
    if (!png) return res.status(404).end();
    remember("default", png);
    return sendPng(res, png);
  });

  app.get("/og/task/:taskId.png", async (req, res) => {
    const ref = taskRef(String(req.params.taskId ?? ""));
    if (!ref) return res.status(400).end();

    const card = await fetchTask(ref);
    if (!card) return res.status(404).end();

    // Keyed on what the card actually draws, not on the task id: a reveal
    // landing has to produce a new image, and an id alone would serve the
    // pre-reveal card for the whole TTL.
    const key = `${card.taskId}:${card.status}:${card.revealedCount}:${card.claimCount}:${card.agreementLabel}`;
    const hit = cached(key);
    if (hit) return sendPng(res, hit);

    const png = await renderPng(taskCardSvg(card));
    if (!png) return res.status(404).end();
    remember(key, png);
    return sendPng(res, png);
  });

  /**
   * The one route where the shell is rebuilt around real data. Everything else
   * gets the site card, which needs no fetch.
   */
  app.get("/task/:taskId", async (req, res) => {
    const ref = taskRef(String(req.params.taskId ?? ""));
    const origin = originOf(req);
    if (!ref || !origin) return res.type("html").send(readShell());

    const [card, images] = await Promise.all([fetchTask(ref), available()]);
    const head = card ? taskMeta(card, origin, images) : siteMeta(origin, req.path, images);
    return res.type("html").send(injectHead(readShell(), head));
  });

  // `index: false` so the shell only ever leaves through the handlers above and
  // below. Without it express.static answers `/` itself, and the site card
  // never reaches the one page most links point at.
  app.use(express.static(staticPath, { index: false }));

  // wouter does the routing; every unknown path is a page, not a 404.
  app.get("*", async (req, res) => {
    const origin = originOf(req);
    if (!origin) return res.type("html").send(readShell());
    return res.type("html").send(injectHead(readShell(), siteMeta(origin, req.path, await available())));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log(`  /api  ->  ${API_ORIGIN}`);
  });
}

startServer().catch(console.error);
