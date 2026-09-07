/**
 * Which unmatched paths are pages and which are missing files.
 *
 * The SPA needs a catch-all: wouter does the routing, so `/tasks`, `/task/0x…`
 * and everything else must return the shell rather than a 404. But the same
 * catch-all sat behind `express.static`, so a request for a file that no longer
 * exists got the shell too — HTML, with status 200, under a `.js` URL.
 *
 * That turns a recoverable mistake into a silent outage. Vite names its output
 * by content hash, so rebuilding the client while a server is running replaces
 * every asset filename. A server holding the previous `index.html` then serves
 * a page whose script tag points at a file that was deleted; the browser is
 * handed `<!doctype html>`, tries to parse it as JavaScript, fails on the first
 * character, and renders nothing. Network shows 200 for every request. There is
 * no error anywhere to find.
 *
 * A 404 says it in one line instead.
 */

/**
 * Extensions the client can request. Deliberately an allowlist rather than
 * "contains a dot": a page route is free to carry one — `/claims/v1.2` is a
 * path, not a file — and guessing wrong would 404 a real page, which is the
 * worse failure of the two.
 */
const ASSET_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "css",
  "map",
  "json",
  "txt",
  "xml",
  "webmanifest",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "wasm",
]);

/**
 * True when a path that reached the catch-all was asking for a file.
 *
 * Reached only after `express.static` has declined, so a true here means the
 * file is genuinely absent — stale, mistyped, or deleted by a rebuild.
 */
export function looksLikeAsset(pathname: string): boolean {
  // Vite's own output directory. Nothing under it is ever a page, whatever it
  // is named, so this holds even for a hash that happens to contain no dot.
  if (pathname.startsWith("/assets/")) return true;

  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return false;
  return ASSET_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}
