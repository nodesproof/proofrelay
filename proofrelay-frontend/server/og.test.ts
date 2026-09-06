/**
 * The share card, without a rasteriser.
 *
 * Everything asserted here is pure string work, which is the reason `og.ts`
 * holds no dependency: a machine that cannot render a PNG can still prove the
 * head is well-formed and that a hostile title cannot reach a crawler as
 * markup.
 */
import { describe, expect, it } from "vitest";
import {
  cardFromTask,
  claimReviewLd,
  escapeAttr,
  injectHead,
  siteMeta,
  taskCardSvg,
  taskMeta,
  truncate,
  wrapText,
  type TaskCard,
} from "./og.js";

const TASK_ID = `0x${"a1".repeat(32)}`;

const CARD: TaskCard = {
  taskId: TASK_ID,
  ref: "PR-1048",
  title: "0G Storage standalone availability",
  question: "Is 0G Storage usable without a blockchain integration, per the official documentation?",
  status: "VERIFIED",
  tone: "lime",
  bountyFormatted: "0.002 0G",
  verifierCount: 2,
  revealedCount: 2,
  claimCount: 2,
  agreementLabel: "2 of 2 agree",
};

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>ProofRelay — Verifiable AI Evidence Market</title>
    <meta name="description" content="the build's own copy" />
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("cardFromTask", () => {
  it("reads the fields a card draws", () => {
    const card = cardFromTask({ ...CARD, extra: "ignored" });
    expect(card).not.toBeNull();
    expect(card?.ref).toBe("PR-1048");
    expect(card?.revealedCount).toBe(2);
  });

  it("refuses a body that is not a task", () => {
    expect(cardFromTask(null)).toBeNull();
    expect(cardFromTask({ error: { code: "TASK_NOT_FOUND" } })).toBeNull();
    expect(cardFromTask({ taskId: "PR-1048" })).toBeNull();
  });

  it("falls back rather than dropping the card when a field is missing", () => {
    const card = cardFromTask({ taskId: TASK_ID });
    expect(card?.title).toBe("Verification task");
    expect(card?.tone).toBe("sky");
    expect(card?.claimCount).toBe(0);
  });

  it("refuses a tone it does not have a colour for", () => {
    expect(cardFromTask({ taskId: TASK_ID, tone: "chartreuse" })?.tone).toBe("sky");
  });
});

describe("injectHead", () => {
  it("replaces the build's title rather than adding a second one", () => {
    const html = injectHead(SHELL, taskMeta(CARD, "https://proofrelay.nectiq.xyz", true));
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain("VERIFIED · 0G Storage standalone availability");
  });

  it("keeps the bundle intact", () => {
    const html = injectHead(SHELL, siteMeta("https://proofrelay.nectiq.xyz", "/", true));
    expect(html).toContain('<div id="root">');
    expect(html).toContain('<meta charset="UTF-8" />');
  });

  it("serves the document unchanged when it has no head to inject into", () => {
    expect(injectHead("<p>not the shell</p>", "<title>x</title>")).toBe("<p>not the shell</p>");
  });
});

describe("meta tags", () => {
  it("points og:url and og:image at absolute addresses", () => {
    const head = taskMeta(CARD, "https://proofrelay.nectiq.xyz", true);
    expect(head).toContain(`content="https://proofrelay.nectiq.xyz/task/${TASK_ID}"`);
    expect(head).toContain(`content="https://proofrelay.nectiq.xyz/og/task/${TASK_ID}.png"`);
    expect(head).toContain('content="summary_large_image"');
  });

  /**
   * The tag and the image are one decision. Advertising an image this
   * deployment cannot render makes X draw an empty frame instead of falling
   * back to the text card, which is strictly worse than saying nothing.
   */
  it("drops og:image entirely when nothing can render one", () => {
    const head = taskMeta(CARD, "https://proofrelay.nectiq.xyz", false);
    expect(head).not.toContain("og:image");
    expect(head).toContain('content="summary"');
    expect(head).not.toContain("summary_large_image");
  });

  it("describes a task by its question", () => {
    expect(taskMeta(CARD, "https://x.test", true)).toContain("Is 0G Storage usable without a blockchain");
  });

  it("falls back to the verifier count when the task carries no question", () => {
    const head = taskMeta({ ...CARD, question: "" }, "https://x.test", true);
    expect(head).toContain("2/2 verifiers reported on 2 claims");
  });
});

describe("escaping", () => {
  /**
   * Titles are written by whoever created the task. This is the layer that has
   * to hold: a crawler reads the bytes, so a title that closes the attribute
   * and opens a tag is markup by the time anything else could intervene.
   */
  it("neutralises a title that tries to close its own attribute", () => {
    const hostile = '"><script>alert(1)</script><meta content="';
    const head = taskMeta({ ...CARD, title: hostile }, "https://x.test", true);
    expect(head).not.toContain("<script>");
    expect(head).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("escapes the ampersand once", () => {
    expect(escapeAttr("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeAttr("&lt;")).toBe("&amp;lt;");
  });

  it("keeps hostile text out of the SVG as markup", () => {
    const svg = taskCardSvg({ ...CARD, title: "</text><script>x</script>", ref: "<PR>" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/text&gt;");
    expect(svg).toContain("&lt;PR&gt;");
  });
});

describe("wrapText", () => {
  it("breaks on words and stays inside the budget", () => {
    const lines = wrapText("Does the documentation state an exact number of ecosystem partners", 62, 900, 3);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join(" ")).toContain("Does the documentation");
  });

  it("marks a title it had to cut", () => {
    const lines = wrapText("word ".repeat(80), 62, 900, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith("…")).toBe(true);
  });

  it("does not mark a title that fit", () => {
    const lines = wrapText("Short title", 62, 900, 3);
    expect(lines).toEqual(["Short title"]);
  });

  it("keeps a single word longer than the line rather than looping forever", () => {
    expect(wrapText("A".repeat(200), 62, 900, 3)).toHaveLength(1);
  });

  it("has nothing to wrap when there is no text", () => {
    expect(wrapText("   ", 62, 900, 3)).toEqual([]);
  });
});

describe("truncate", () => {
  it("collapses the whitespace a form field carries", () => {
    expect(truncate("a\n\n  b   c", 40)).toBe("a b c");
  });

  it("marks what it cut", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("taskCardSvg", () => {
  it("draws the card at the size the meta tags promise", () => {
    const svg = taskCardSvg(CARD);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("PR-1048");
    expect(svg).toContain("VERIFIED");
    expect(svg).toContain("0.002 0G");
  });

  it("colours a conflict differently from an agreement", () => {
    expect(taskCardSvg(CARD)).toContain("#C7F36B");
    expect(taskCardSvg({ ...CARD, tone: "coral", status: "CONFLICT" })).toContain("#FF765D");
  });

  it("omits the agreement stat when the task has no label for it", () => {
    expect(taskCardSvg({ ...CARD, agreementLabel: "" })).not.toContain("AGREEMENT");
  });
});

describe("ClaimReview structured data", () => {
  const settled = (over = {}) => ({
    taskId: `0x${"11".repeat(32)}`,
    consensus: { outcome: "CONSENSUS", evaluatedAt: "2026-09-06T03:34:32.000Z" },
    claims: [
      { claimText: "The most specific match found must be used.", displayVerdict: "SUPPORTED" },
      { claimText: "The URI is disallowed when nothing matches.", displayVerdict: "CONTRADICTED" },
    ],
    ...over,
  });

  const parse = (html: string) =>
    JSON.parse(html.replace(/^<script type="application\/ld\+json">/, "").replace(/<\/script>$/, ""));

  it("emits one ClaimReview per rated claim", () => {
    const reviews = parse(claimReviewLd(settled(), "https://proofrelay.nectiq.xyz"));
    expect(reviews).toHaveLength(2);
    expect(reviews[0]["@type"]).toBe("ClaimReview");
    expect(reviews[1].reviewRating.alternateName).toMatch(/Contradicted/);
  });

  /**
   * `author` is an accountability field: it names who can be told the rating is
   * wrong. The deployment signs its own ratings, so a fork running its own
   * instance does not publish under this one's name.
   */
  it("names the deployment it is served from as the author", () => {
    const [review] = parse(claimReviewLd(settled(), "https://proofrelay.nectiq.xyz"));
    expect(review.author).toEqual({
      "@type": "Organization",
      name: "proofrelay.nectiq.xyz",
      url: "https://proofrelay.nectiq.xyz",
    });
    const [forked] = parse(claimReviewLd(settled(), "https://someone-else.example"));
    expect(forked.author.name).toBe("someone-else.example");
  });

  /**
   * The load-bearing one. `claimText` is whatever the task creator typed, and
   * JSON.stringify will emit `</script>` from it verbatim — which closes the
   * block and starts an injection on a page whose head is assembled by hand.
   */
  it("cannot be escaped out of by a hostile claim", () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    const html = claimReviewLd(
      settled({ claims: [{ claimText: hostile, displayVerdict: "SUPPORTED" }] }),
      "https://proofrelay.nectiq.xyz",
    );
    expect(html).not.toContain("</script><img");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    // Still valid JSON, and the text survives intact once parsed.
    expect(parse(html)[0].claimReviewed).toBe(hostile);
  });

  /** A claim nobody has reported on has no rating to publish. */
  it("says nothing about an unsettled task", () => {
    expect(claimReviewLd(settled({ consensus: null }), "https://proofrelay.nectiq.xyz")).toBe("");
    expect(
      claimReviewLd(
        settled({ claims: [{ claimText: "x", displayVerdict: "PENDING" }] }),
        "https://proofrelay.nectiq.xyz",
      ),
    ).toBe("");
  });

  /** A body that is not a task must degrade to silence, never to an error. */
  it("returns nothing rather than throwing on a body it does not recognise", () => {
    for (const body of [null, undefined, 42, "task", {}, { taskId: "nope" }]) {
      expect(claimReviewLd(body, "https://proofrelay.nectiq.xyz")).toBe("");
    }
  });

  /**
   * No numeric ratingValue. Mapping three verdicts onto a truth scale would
   * invent a precision this pipeline does not have.
   */
  it("publishes a textual rating and no invented number", () => {
    const [review] = parse(claimReviewLd(settled(), "https://proofrelay.nectiq.xyz"));
    expect(review.reviewRating.ratingValue).toBeUndefined();
    expect(review.reviewRating.alternateName).toMatch(/Supported by the cited sources/);
  });
});
