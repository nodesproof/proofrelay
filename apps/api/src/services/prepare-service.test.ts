import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "@proofrelay/schemas";
import { screenSnapshots } from "./prepare-service.js";

const snapshot = (text: string, sourceId = "src-000"): SourceSnapshot => ({
  kind: "source-snapshot",
  schemaVersion: "1.0.0",
  producer: "test",
  sourceId,
  uri: `https://example.invalid/${sourceId}`,
  status: "OK",
  httpStatus: 200,
  contentType: "text/plain",
  headers: {},
  text,
  byteLength: Buffer.byteLength(text),
  contentHash: `sha256:${"ab".repeat(32)}`,
  truncated: false,
  error: null,
  retrievedAt: "2026-09-06T00:00:00.000Z",
});

describe("screenSnapshots", () => {
  it("says a clean page is clean", () => {
    const result = screenSnapshots([snapshot("The most specific match found MUST be used.")]);
    expect(result.publicDataOnly).toBe(true);
    expect(result.redactions).toEqual([]);
  });

  /**
   * The defect this exists for. The screen ran over the creator's typed fields
   * only, and before the fetch, so `publicDataOnly: true` and `redactions: []`
   * were literals about bytes nothing had read. Mainnet task 0x88218974…
   * published a snapshot in which this project's own detector finds four
   * addresses, under `publicDataOnly: true`.
   */
  it("stops calling a page public-data-only when it is not", () => {
    const result = screenSnapshots([
      snapshot("Contact the editor at m.koster@greenhills.example for corrections."),
    ]);
    expect(result.publicDataOnly).toBe(false);
    expect(result.redactions).toHaveLength(1);
  });

  /** Recording a finding must never be a second copy of it. */
  it("records the match already redacted", () => {
    const result = screenSnapshots([snapshot("Write to alice.smith@example.org today.")]);
    expect(result.redactions[0]).toContain("REDACTED");
    expect(result.redactions.join(" ")).not.toContain("alice.smith@example.org");
  });

  it("names the source the match came from", () => {
    const result = screenSnapshots([snapshot("mail bob@example.org", "src-007")]);
    expect(result.redactions[0]).toContain("src-007");
    expect(result.redactions[0]).toContain("email");
  });

  /**
   * A fetched page is a third party's published document. Refusing every one
   * that carries a contact address would refuse most of the standards web —
   * RFC 9309 names four in its own acknowledgements.
   */
  it("does not refuse a page merely for carrying an address", () => {
    expect(() => screenSnapshots([snapshot("Reach us at ops@example.org.")])).not.toThrow();
  });

  /**
   * A key is different: copying it into content-addressed storage is the harm,
   * whoever published it first, and no takedown reaches an object addressed by
   * its own hash.
   */
  it("refuses a page carrying a private key", () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADAN".repeat(8)}\n-----END PRIVATE KEY-----`;
    expect(() => screenSnapshots([snapshot(key)])).toThrow(/personal data/i);
  });

  it("screens every source, not just the first", () => {
    const result = screenSnapshots([
      snapshot("clean text with no contact details at all", "src-000"),
      snapshot("mail carol@example.org", "src-001"),
    ]);
    expect(result.publicDataOnly).toBe(false);
    expect(result.redactions[0]).toContain("src-001");
  });

  it("bounds the note list and says when it truncated", () => {
    const many = Array.from({ length: 60 }, (_, i) => `user${i}@example.org`).join(" and also ");
    const result = screenSnapshots([snapshot(many)]);
    expect(result.redactions.length).toBeLessThanOrEqual(33);
    expect(result.redactions.at(-1)).toMatch(/more matches not listed/);
  });

  it("survives a snapshot whose fetch returned nothing", () => {
    const empty = { ...snapshot(""), status: "UNAVAILABLE" as const, error: "host down" };
    expect(screenSnapshots([empty]).publicDataOnly).toBe(true);
  });
});
