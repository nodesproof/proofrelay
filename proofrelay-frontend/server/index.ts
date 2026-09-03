import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Where the ProofRelay API is, as seen from this process — not from the
 * browser. The two are only the same when the browser is on this machine.
 */
const API_ORIGIN = (process.env.API_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/+$/, "");

/** Hop-by-hop and body-framing headers, which belong to one connection. */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "keep-alive", "upgrade"]);
/** `fetch` has already decoded the body, so its encoding headers would lie. */
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

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

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log(`  /api  ->  ${API_ORIGIN}`);
  });
}

startServer().catch(console.error);
