/**
 * SVG → PNG for the share cards.
 *
 * Kept apart from `og.ts` on purpose. Everything that decides what a card says
 * is pure and has no dependency; this file is the one that needs a rasteriser,
 * and a machine without one has to degrade rather than fail — `available()` is
 * what the head builder asks before it advertises an `og:image` at all. A tag
 * pointing at an image that cannot be produced is worse than no tag: the
 * crawler shows an empty frame instead of a text card.
 *
 * PNG and not SVG because X, Facebook and LinkedIn all refuse SVG for
 * `og:image`. There is no format here that skips the rasteriser.
 *
 * Fonts: resvg draws nothing it cannot find a face for, and a slim container
 * has no fonts at all — so text would come out blank with no error anywhere.
 * System fonts are used when they exist, and OG_FONT_FILES names explicit
 * files for the deployment where they do not.
 */
import { CARD_WIDTH } from "./og.js";

type ResvgModule = typeof import("@resvg/resvg-js");

const FONT_FILES = (process.env.OG_FONT_FILES ?? "")
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);

let loading: Promise<ResvgModule | null> | null = null;

/**
 * The rasteriser, or null when this deployment has none. Memoised on the
 * promise rather than the result, so a burst of crawler requests on a cold
 * process performs one import instead of one per request.
 */
function load(): Promise<ResvgModule | null> {
  loading ??= import("@resvg/resvg-js")
    .then((module) => module)
    .catch((error: unknown) => {
      process.stderr.write(
        `og: @resvg/resvg-js could not be loaded, share cards will carry no image (${String(
          (error as Error)?.message ?? error,
        ).slice(0, 200)})\n`,
      );
      return null;
    });
  return loading;
}

export async function available(): Promise<boolean> {
  return (await load()) !== null;
}

export async function renderPng(svg: string): Promise<Buffer | null> {
  const module = await load();
  if (!module) return null;
  try {
    const image = new module.Resvg(svg, {
      fitTo: { mode: "width", value: CARD_WIDTH },
      font: {
        loadSystemFonts: true,
        ...(FONT_FILES.length > 0 ? { fontFiles: FONT_FILES } : {}),
        // Named rather than left to resvg's own default, which is the first
        // face it happens to enumerate — on one machine a serif, on another a
        // symbol font. The card's family list is a fallback chain and this is
        // its last link.
        defaultFontFamily: process.env.OG_FONT_FAMILY ?? "DejaVu Sans",
      },
    });
    return Buffer.from(image.render().asPng());
  } catch (error) {
    process.stderr.write(
      `og: render failed (${String((error as Error)?.message ?? error).slice(0, 200)})\n`,
    );
    return null;
  }
}

/**
 * A bounded cache of rendered cards.
 *
 * A card changes while its task is still moving — a reveal lands, consensus
 * settles — so an entry expires rather than living for the life of the process.
 * The cap is what stops a crawl of every task from holding every PNG in memory
 * at once; eviction is oldest-first, which for this access pattern is close
 * enough to LRU to not be worth a linked list.
 */
const MAX_ENTRIES = 64;
const TTL_MS = 5 * 60_000;

interface Entry {
  png: Buffer;
  at: number;
}

const cache = new Map<string, Entry>();

export function cached(key: string, now = Date.now()): Buffer | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.png;
}

export function remember(key: string, png: Buffer, now = Date.now()): void {
  // Re-inserting moves the key to the end of the iteration order, which is what
  // makes the oldest-first eviction below mean anything.
  cache.delete(key);
  cache.set(key, { png, at: now });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
