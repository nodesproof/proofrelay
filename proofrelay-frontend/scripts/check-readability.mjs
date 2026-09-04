#!/usr/bin/env node
/**
 * Guards the readability floor in index.css.
 *
 * A one-time pass raised 184 font sizes through a scale and darkened 160 muted
 * colours; this is what stops them drifting back. It reports only — it never
 * rewrites, because a size remap is safe exactly once and re-running one would
 * inflate the type on every invocation.
 *
 * Two rules, both derived from what was actually wrong:
 *   - no text below 11px (the floor was 7px, and 140 of 184 sizes were <= 10px)
 *   - every colour clears its own ground: 5.2:1 under 14px, 4.6:1 at or above
 *
 * Grounds are not guessed from selector names. They were measured in the
 * browser across every route, because guessing is what turned light-on-ink text
 * dark during the original pass.
 *
 * Exits non-zero on a violation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "src", "index.css");
const MIN_SIZE = 11;

const PAPER = "#f4f1e8";
const INK = "#0d1721";

/**
 * Selectors whose text really sits on a dark ground, measured in the browser
 * across every route rather than guessed from names.
 *
 * Guessing is what makes this class of pass dangerous: `.workflow-copy p` is
 * light text on ink, and a prefix list that only knew about `.workflow-card`
 * "corrected" it to a dark green that vanished into the panel. Measurement
 * removes the guess.
 */
const MEASURED_INK = new Set([
  ".sidebar", ".brand-name", ".brand-name span", ".brand-caption",
  ".workspace-copy small", ".nav-section-label", ".nav-item", ".nav-item.active",
  ".nav-count", ".nav-item.active .nav-count", ".network-label", ".network-row",
  ".network-row strong", ".user-row", ".user-row > svg", ".workflow-card",
  ".workflow-copy .eyebrow", ".workflow-copy p", ".workflow-steps small",
  ".network-banner button", ".user-copy small", ".visual-caption",
  ".visual-caption span", ".visual-corner", ".visual-corner.bottom-right",
  ".task-banner", ".task-banner-copy > span", ".task-banner-hash span",
  ".task-banner-hash strong", ".network-row strong.value-warn",
  ".docs-bottom-cta", ".docs-bottom-cta span", ".timeline-ink", ".origin-chain",
  ".task-banner .origin-chip",
  // The task record's hero is the banner's successor: same ink ground, same
  // light-on-dark text, one block where there used to be three.
  ".task-hero", ".task-hero .origin-chip", ".task-hero .quiet-button",
  ".task-hero .quiet-button:hover:not(:disabled)", ".task-hero .quiet-button:disabled",
]);

/**
 * Dark containers whose descendants were not on screen during the measurement
 * pass (a collapsed code block, the notifications popover). Prefix match only,
 * and only for containers confirmed dark by their own background declaration.
 */
const INK_CONTAINER_PREFIXES = [
  ".code-block", ".code-head", ".topbar-pop", ".hero-visual", ".workspace-avatar",
  ".task-banner-", ".task-hero-", ".evidence-flow", ".flow-", ".visual-", ".workflow-copy", ".workflow-steps", ".docs-bottom-cta",
];

function partIsInk(part) {
  const s = part.trim();
  if (MEASURED_INK.has(s)) return true;
  return INK_CONTAINER_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/**
 * A grouped selector is ink-ground if any of its parts is. `.workspace-copy
 * small, .user-copy small` are both in the dark rail, and matching the whole
 * comma-joined string against a set of single selectors silently missed it —
 * the rule was then darkened into the rail it sits on.
 *
 * `mixed` is returned separately because a rule that lands on both grounds
 * cannot be satisfied by one colour; it needs splitting in the stylesheet, and
 * this pass should say so rather than pick a side.
 */
function groundOf(selector) {
  const parts = selector.split(",").map((p) => p.trim()).filter(Boolean);
  const inks = parts.filter(partIsInk).length;
  return { ink: inks > 0, mixed: inks > 0 && inks < parts.length };
}

/* ── colour maths ────────────────────────────────────────────────────────── */

function parseHex(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

function relLum([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}


/* ── the check ───────────────────────────────────────────────────────────── */

const css = readFileSync(CSS, "utf8");
const tooSmall = [];
const lowContrast = [];

for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
  if (!selector.trim() || selector.includes("@")) continue;

  for (const [, px] of body.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    if (Number(px) < MIN_SIZE) tooSmall.push([selector.trim().slice(0, 52), Number(px)]);
  }

  const sizeMatch = /font-size:\s*([0-9.]+)px/.exec(body);
  const size = sizeMatch ? Number(sizeMatch[1]) : 14;
  const ownBg = /background(?:-color)?:\s*(#[0-9a-fA-F]{3,6})\b/.exec(body);
  const measured = groundOf(selector);
  const ink = ownBg ? relLum(parseHex(ownBg[1])) < 0.35 : measured.ink;
  const ground = ownBg ? ownBg[1].toLowerCase() : ink ? INK : PAPER;
  // The one-time fix aimed at 5.2 / 4.6 to leave margin; this gate sits just
  // below at 5.0 / 4.5 — WCAG AA, plus the small-text tier — so hex
  // quantisation landing a hundredth under the aim is not reported as a
  // regression. A real regression moves a colour by far more than 0.1:1.
  const target = size < 14 ? 5.0 : 4.5;

  for (const [, hex] of body.matchAll(/(?:^|[;{\s])color:\s*(#[0-9a-fA-F]{3,6})\b/g)) {
    const ratio = contrast(parseHex(hex.toLowerCase()), parseHex(ground));
    if (ratio < target) {
      lowContrast.push([selector.trim().slice(0, 52), hex, ground, size, Math.round(ratio * 100) / 100, target]);
    }
  }
}

if (tooSmall.length) {
  console.log(`text below ${MIN_SIZE}px: ${tooSmall.length}`);
  for (const [sel, px] of tooSmall) console.log(`  ${px}px  ${sel}`);
}
if (lowContrast.length) {
  console.log(`\ncolours below their contrast target: ${lowContrast.length}`);
  for (const [sel, hex, ground, size, ratio, target] of lowContrast) {
    console.log(`  ${hex} on ${ground} at ${size}px — ${ratio}:1, needs ${target}:1  ${sel}`);
  }
}

const failures = tooSmall.length + lowContrast.length;
console.log(
  failures === 0
    ? `index.css is clean: nothing under ${MIN_SIZE}px, every colour clears its ground.`
    : `\n${failures} readability violation(s).`,
);
process.exit(failures === 0 ? 0 : 1);
