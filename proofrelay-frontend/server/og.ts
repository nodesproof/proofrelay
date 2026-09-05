/**
 * Open Graph cards for a task page.
 *
 * The app is a Vite SPA: one `index.html` with one `<title>`, served for every
 * route. That is fine for a browser, which runs the bundle and renders the
 * page — and useless for a crawler, which reads the bytes and stops. A task
 * link pasted into X, Discord, Slack or Telegram therefore arrived naked: no
 * title, no verdict, no image, on a product whose entire output is a result
 * worth showing.
 *
 * Nothing here needs SSR. The page already has its own Express server, so the
 * fix is to read the task the URL names, rebuild the `<head>` around it, and
 * serve the same bundle. Two rules make that safe:
 *
 * 1. **Every interpolated value is escaped.** Titles, questions and source URLs
 *    all originate with whoever created the task. `index.ts` says the same
 *    thing about its CSP; this is the layer that must not need it.
 * 2. **A failure falls through to the plain shell.** The API being slow or down
 *    degrades a share card. It must never turn `/task/0x…` into an error page,
 *    because the bundle would have rendered the task perfectly well on its own.
 */

/* ── the fields a card actually needs ────────────────────────────────────── */

export type CardTone = "lime" | "sky" | "coral" | "ink";

export interface TaskCard {
  taskId: string;
  ref: string;
  title: string;
  question: string;
  status: string;
  tone: CardTone;
  bountyFormatted: string;
  verifierCount: number;
  revealedCount: number;
  claimCount: number;
  agreementLabel: string;
}

const TONES = new Set<CardTone>(["lime", "sky", "coral", "ink"]);

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Reads a `GET /v1/tasks/:taskId` body into the card's fields, and returns null
 * when the body is not one.
 *
 * Deliberately structural rather than a zod parse of `TaskSummary`: the server
 * bundle does not depend on the workspace packages (see `lib/wagmi.ts` for the
 * same boundary), and a card is not worth failing over a field it never reads.
 * A response that is missing `taskId` is not a task, and that is the only field
 * treated as required.
 */
export function cardFromTask(body: unknown): TaskCard | null {
  if (!body || typeof body !== "object") return null;
  const task = body as Record<string, unknown>;
  const taskId = str(task.taskId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(taskId)) return null;

  const tone = str(task.tone) as CardTone;
  return {
    taskId,
    ref: str(task.ref, `${taskId.slice(0, 10)}…`),
    title: str(task.title, "Verification task"),
    question: str(task.question),
    status: str(task.status, "IN REVIEW"),
    tone: TONES.has(tone) ? tone : "sky",
    bountyFormatted: str(task.bountyFormatted, "—"),
    verifierCount: int(task.verifierCount),
    revealedCount: int(task.revealedCount),
    claimCount: int(task.claimCount),
    agreementLabel: str(task.agreementLabel),
  };
}

/* ── escaping ────────────────────────────────────────────────────────────── */

/**
 * For an HTML attribute value. `&` first, or the ampersands this function
 * introduces get escaped a second time and `&amp;` reaches the crawler as
 * `&amp;amp;`.
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** For text between tags — `<title>` is the only one here. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * XML text and attribute content for the SVG card. `'` is left alone because
 * every attribute in the card is double-quoted, and an apostrophe surviving as
 * itself is what a title with one in it should look like.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collapses the whitespace a title or question may carry from a form field. */
export function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max: number): string {
  const flat = flatten(value);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/* ── the head ────────────────────────────────────────────────────────────── */

export interface MetaInput {
  title: string;
  description: string;
  /** Absolute — a relative og:url or og:image is ignored by most crawlers. */
  url: string;
  image: string | null;
  imageAlt: string;
}

const SITE_NAME = "ProofRelay";

/**
 * The tags themselves. `twitter:card` is `summary_large_image` only when there
 * is an image: with the value set and no image, X renders an empty frame rather
 * than falling back to the small card.
 */
export function metaTags(input: MetaInput): string {
  const tags = [
    `<title>${escapeText(input.title)}</title>`,
    `<meta name="description" content="${escapeAttr(input.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${escapeAttr(input.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(input.description)}" />`,
    `<meta property="og:url" content="${escapeAttr(input.url)}" />`,
    `<meta name="twitter:title" content="${escapeAttr(input.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(input.description)}" />`,
  ];
  if (input.image) {
    tags.push(
      `<meta property="og:image" content="${escapeAttr(input.image)}" />`,
      `<meta property="og:image:width" content="${CARD_WIDTH}" />`,
      `<meta property="og:image:height" content="${CARD_HEIGHT}" />`,
      `<meta property="og:image:alt" content="${escapeAttr(input.imageAlt)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${escapeAttr(input.image)}" />`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`);
  }
  return tags.join("\n    ");
}

/**
 * Puts the tags in the shipped `index.html`.
 *
 * The build's own `<title>` and `<meta name="description">` are removed first.
 * Appending without removing leaves two of each in the document, and which one
 * a crawler keeps is not something to find out from a share preview.
 */
export function injectHead(html: string, tags: string): string {
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, "");
  const close = stripped.search(/<\/head>/i);
  // No </head> means this is not the document we think it is; serving it
  // unchanged is the honest outcome, and the page still works.
  if (close === -1) return html;
  return `${stripped.slice(0, close)}    ${tags}\n  ${stripped.slice(close)}`;
}

/** The card for one task. */
export function taskMeta(card: TaskCard, origin: string, imagesAvailable: boolean): string {
  const revealed = `${card.revealedCount}/${card.verifierCount} verifiers`;
  return metaTags({
    title: `${card.status} · ${truncate(card.title, 90)} — ${SITE_NAME}`,
    description: card.question
      ? truncate(card.question, 200)
      : `${revealed} reported on ${card.claimCount} claim${card.claimCount === 1 ? "" : "s"}. Every source is snapshotted, hashed and settled on 0G.`,
    url: `${origin}/task/${card.taskId}`,
    image: imagesAvailable ? `${origin}/og/task/${card.taskId}.png` : null,
    imageAlt: `${card.ref} — ${card.status}, ${revealed}`,
  });
}

/** The card for every page that is not a task. */
export function siteMeta(origin: string, path: string, imagesAvailable: boolean): string {
  return metaTags({
    title: "ProofRelay — an onchain evidence market for AI claims",
    description:
      "Post a claim and a bounty. Independent verifiers fetch the same snapshotted sources and commit their answers before any of them can see another's. 0G stores the artifacts and settles the result onchain.",
    url: `${origin}${path}`,
    image: imagesAvailable ? `${origin}/og/default.png` : null,
    imageAlt: "ProofRelay — evidence onchain",
  });
}

/* ── the image ───────────────────────────────────────────────────────────── */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** Evidence Ledger, on the dark ground. `ink` is a slate here — the real Ledger
 *  Ink is the background, and a status drawn in it would be invisible. */
const TONE_COLOR: Record<CardTone, string> = {
  lime: "#C7F36B",
  sky: "#A9D8FF",
  coral: "#FF765D",
  ink: "#8FA3B5",
};

const INK = "#0D1721";
const PAPER = "#F4F1E8";
const MUTED = "#7C8B99";

/**
 * Approximate advance width of a glyph, as a fraction of the font size.
 *
 * The card is laid out before any font is loaded, so the exact metrics are not
 * available and the alternative — rendering, measuring, re-rendering — is not
 * worth it for a share image. These weights are a sans-serif average; they only
 * have to be good enough that a wrapped line does not overrun the canvas, which
 * is why the wrap budget below is the drawable width and not the full 1200.
 */
function advance(char: string): number {
  if ("iljItf.,:;'|!".includes(char)) return 0.30;
  if ("mwMW—".includes(char)) return 0.86;
  if (char === " ") return 0.28;
  if (char >= "A" && char <= "Z") return 0.62;
  if (char >= "0" && char <= "9") return 0.56;
  return 0.52;
}

/**
 * Wrap budgets, measured off a rendered card rather than derived.
 *
 * The drawable column is 944px (x=128 to x=1072). The question, drawn at the
 * regular weight, comes out within 2% of what `textWidth` predicts. The title
 * does not: at 700 weight the real advances run about 11% wider, and a budget
 * of 900 produced a line that overran the right margin by 60px. So the title's
 * budget is the column scaled by that measured ratio, and the question's is
 * the column itself.
 */
const TITLE_WIDTH = 820;
const QUESTION_WIDTH = 880;

export function textWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const char of text) total += advance(char) * fontSize;
  return total;
}

/**
 * Greedy word wrap with a hard line budget. The last kept line is ellipsised
 * when text remains, so a long title reads as truncated rather than as one that
 * merely happened to end there.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const words = flatten(text).split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, fontSize) <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);

  const consumed = lines.join(" ").length;
  if (consumed < flatten(text).length && lines.length > 0) {
    const last = lines.length - 1;
    let tail = `${lines[last]}…`;
    while (tail.length > 1 && textWidth(tail, fontSize) > maxWidth) {
      tail = `${tail.slice(0, -2)}…`;
    }
    lines[last] = tail;
  }
  return lines;
}

interface Stat {
  label: string;
  value: string;
}

function statBlock(stats: Stat[], x: number, y: number): string {
  let cursor = x;
  const parts: string[] = [];
  for (const stat of stats) {
    parts.push(
      `<text x="${cursor}" y="${y}" font-size="19" letter-spacing="1.6" fill="${MUTED}">${escapeXml(stat.label.toUpperCase())}</text>`,
      `<text x="${cursor}" y="${y + 36}" font-size="30" font-weight="600" fill="${PAPER}">${escapeXml(stat.value)}</text>`,
    );
    // Column pitch from the wider of the two rows, so a long bounty does not
    // slide under the next label.
    const label = stat.label.toUpperCase();
    cursor += Math.max(textWidth(label, 19) + 1.6 * label.length, textWidth(stat.value, 30)) + 64;
  }
  return parts.join("\n  ");
}

/**
 * The task card, as SVG.
 *
 * Hand-written rather than laid out by satori: the composition is fixed, so the
 * only thing a JSX layout engine would add here is a dependency.
 */
export function taskCardSvg(card: TaskCard): string {
  const accent = TONE_COLOR[card.tone];
  const titleLines = wrapText(card.title, 62, TITLE_WIDTH, 3);
  const questionLines = titleLines.length >= 3 ? [] : wrapText(card.question, 26, QUESTION_WIDTH, 3 - titleLines.length);

  // Short titles sit lower so the card is not top-heavy, but never above 262:
  // the ref and status pills end at y=192, and a 62px line has about 45px of
  // cap above its baseline. Centring a three-line title without this floor put
  // its first line straight through both pills.
  const titleTop = Math.max(262, 300 - (titleLines.length - 1) * 38);
  const title = titleLines
    .map((line, index) => `<text x="128" y="${titleTop + index * 76}" font-size="62" font-weight="700" fill="${PAPER}">${escapeXml(line)}</text>`)
    .join("\n  ");
  const question = questionLines
    .map((line, index) => `<text x="128" y="${titleTop + titleLines.length * 76 + 8 + index * 38}" font-size="26" fill="${MUTED}">${escapeXml(line)}</text>`)
    .join("\n  ");

  const pillWidth = Math.round(textWidth(card.status, 24) + 2.4 * card.status.length + 44);
  const refWidth = Math.round(textWidth(card.ref, 24) + 36);

  const stats = statBlock(
    [
      { label: "Verifiers", value: `${card.revealedCount}/${card.verifierCount}` },
      { label: "Claims", value: String(card.claimCount) },
      { label: "Bounty", value: card.bountyFormatted },
      ...(card.agreementLabel ? [{ label: "Agreement", value: card.agreementLabel }] : []),
    ],
    128,
    500,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="DM Sans, Inter, Lato, Helvetica, Arial, sans-serif">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${INK}" />
  <rect x="0" y="0" width="${CARD_WIDTH}" height="6" fill="${accent}" />
  <rect x="80" y="96" width="3" height="438" fill="${accent}" opacity="0.55" />
  <circle cx="81.5" cy="150" r="7" fill="${accent}" />
  <circle cx="81.5" cy="316" r="7" fill="${accent}" opacity="0.5" />
  <circle cx="81.5" cy="482" r="7" fill="${accent}" opacity="0.3" />

  <text x="128" y="122" font-size="20" letter-spacing="4" font-weight="600" fill="${accent}">PROOFRELAY</text>
  <text x="${Math.round(128 + textWidth("PROOFRELAY", 20) + "PROOFRELAY".length * 4 + 24)}" y="122" font-size="20" letter-spacing="4" fill="${MUTED}">EVIDENCE LEDGER</text>

  <rect x="128" y="150" width="${refWidth}" height="42" rx="21" fill="${PAPER}" opacity="0.08" />
  <text x="${128 + refWidth / 2}" y="178" font-size="24" font-weight="600" text-anchor="middle" fill="${PAPER}">${escapeXml(card.ref)}</text>
  <rect x="${128 + refWidth + 14}" y="150" width="${pillWidth}" height="42" rx="21" fill="${accent}" opacity="0.16" />
  <text x="${128 + refWidth + 14 + pillWidth / 2}" y="178" font-size="24" letter-spacing="2.4" font-weight="600" text-anchor="middle" fill="${accent}">${escapeXml(card.status)}</text>

  ${title}
  ${question}

  <rect x="128" y="452" width="944" height="1" fill="${PAPER}" opacity="0.12" />
  ${stats}

  <text x="1072" y="122" font-size="20" text-anchor="end" fill="${MUTED}">0G mainnet</text>
</svg>`;
}

/** The generic card, for every page that is not one task. */
export function defaultCardSvg(): string {
  const accent = TONE_COLOR.lime;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="DM Sans, Inter, Lato, Helvetica, Arial, sans-serif">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${INK}" />
  <rect x="0" y="0" width="${CARD_WIDTH}" height="6" fill="${accent}" />
  <rect x="80" y="120" width="3" height="390" fill="${accent}" opacity="0.55" />
  <text x="128" y="146" font-size="20" letter-spacing="4" font-weight="600" fill="${accent}">PROOFRELAY</text>
  <text x="128" y="272" font-size="72" font-weight="700" fill="${PAPER}">Don't trust the answer.</text>
  <text x="128" y="356" font-size="72" font-weight="700" fill="${accent}">Check the evidence.</text>
  <text x="128" y="424" font-size="28" fill="${MUTED}">An onchain evidence market for AI claims, on 0G.</text>
  <rect x="128" y="470" width="944" height="1" fill="${PAPER}" opacity="0.12" />
  <text x="128" y="516" font-size="22" fill="${MUTED}">Snapshotted sources · commit before reveal · settled on 0G Chain</text>
</svg>`;
}
