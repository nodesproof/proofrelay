import { describe, expect, it } from "vitest";
import { selectSpans } from "./local.js";

const at = "2026-09-06T02:00:00.000Z";

/** RFC 2119's shape: several definitions that differ in one word, one document. */
const RFC = [
  "1. MUST   This word, or the terms REQUIRED or SHALL, mean that the definition is an absolute requirement of the specification.",
  "2. MUST NOT   This phrase, or the phrase SHALL NOT, mean that the definition is an absolute prohibition of the specification.",
  "3. SHOULD   This word, or the adjective RECOMMENDED, mean that there may exist valid reasons to ignore a particular item.",
  "5. MAY   This word, or the adjective OPTIONAL, mean that an item is truly optional.",
].join("\n\n");

const CHANGELOG = ["Changelogs are for humans, not machines.", "The latest version comes first."].join("\n\n");

const source = (id: string, text: string, hash: string) => ({
  sourceId: id,
  uri: `https://example.invalid/${id}`,
  snapshotObjectId: `obj-${id}`,
  contentHash: hash,
  text,
  retrievedAt: at,
});

const RFC_SOURCE = source("rfc", RFC, `sha256:${"a1".repeat(32)}`);
const KAC_SOURCE = source("kac", CHANGELOG, `sha256:${"b2".repeat(32)}`);

const MUST_NOT = "In RFC 2119, MUST NOT means the definition is an absolute prohibition of the specification.";

describe("selectSpans", () => {
  /**
   * The failure this exists for. Taking only the best span per source meant a
   * one-source task showed the model a single paragraph of the document,
   * whatever evidenceDepth said. On mainnet task 0xaca56aee… every verifier was
   * handed RFC 2119's definition of MUST and asked about MUST NOT; each
   * answered correctly about the wrong paragraph.
   */
  it("fills the budget from one source when there is only one", () => {
    expect(selectSpans(MUST_NOT, [RFC_SOURCE], 1)).toHaveLength(1);
    expect(selectSpans(MUST_NOT, [RFC_SOURCE], 3)).toHaveLength(3);
  });

  it("surfaces the paragraph that answers the claim, not just the closest one", () => {
    const quoted = selectSpans(MUST_NOT, [RFC_SOURCE], 3).map((span) => span.quotedSpan);
    expect(quoted.some((span) => span.includes("MUST NOT"))).toBe(true);
  });

  /**
   * Diversity still comes first: evidence overlap downstream is only meaningful
   * if two verifiers citing two different documents beats two citing one twice.
   */
  it("gives every source a slot before taking a second from any", () => {
    const chosen = selectSpans(MUST_NOT, [RFC_SOURCE, KAC_SOURCE], 2);
    expect(new Set(chosen.map((span) => span.sourceId))).toEqual(new Set(["rfc", "kac"]));
  });

  it("behaves exactly as before when there are at least as many sources as slots", () => {
    const chosen = selectSpans(MUST_NOT, [RFC_SOURCE, KAC_SOURCE], 1);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.sourceId).toBe("rfc");
  });

  it("never returns more than the budget", () => {
    expect(selectSpans(MUST_NOT, [RFC_SOURCE, KAC_SOURCE], 3).length).toBeLessThanOrEqual(3);
  });

  it("orders by score, strongest first", () => {
    const scores = selectSpans(MUST_NOT, [RFC_SOURCE, KAC_SOURCE], 4).map((span) => span.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  /** The report is hashed and replayed, so corpus order must not change it. */
  it("does not depend on the order the corpus arrives in", () => {
    const forward = selectSpans(MUST_NOT, [RFC_SOURCE, KAC_SOURCE], 3);
    const reversed = selectSpans(MUST_NOT, [KAC_SOURCE, RFC_SOURCE], 3);
    expect(reversed.map((s) => s.quotedSpan)).toEqual(forward.map((s) => s.quotedSpan));
  });

  it("returns nothing for an empty corpus rather than throwing", () => {
    expect(selectSpans(MUST_NOT, [], 3)).toEqual([]);
  });
});
