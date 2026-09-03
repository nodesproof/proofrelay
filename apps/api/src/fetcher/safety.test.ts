import { describe, expect, it } from "vitest";
import { screenForPersonalData, type PersonalDataKind } from "./safety.js";

function kinds(fields: Record<string, string>): PersonalDataKind[] {
  return screenForPersonalData(fields).matches.map((m) => m.kind);
}

describe("personal data that must be rejected", () => {
  const REJECTED: Array<[string, PersonalDataKind, Record<string, string>]> = [
    ["an email address", "email", { question: "Did alice.smith@example.co.uk approve the release?" }],
    ["an email with a plus tag", "email", { answerText: "Reply went to ops+alerts@acme.dev." }],
    ["the canonical Visa test card", "payment-card", { claim: "Charged 4111111111111111 on file." }],
    ["a spaced Visa number", "payment-card", { claim: "Card 4012 8888 8888 1881 was declined." }],
    ["a dashed Mastercard", "payment-card", { claim: "Used 5555-5555-5555-4444 for the refund." }],
    ["an Amex number", "payment-card", { claim: "The Amex 378282246310005 was on file." }],
    ["a phone number with context", "phone", { question: "Call the team on +62 812 3456 7890." }],
    ["a phone number in parentheses", "phone", { notes: "Phone: (415) 555-2671 during office hours." }],
    ["a phone number from the field name", "phone", { phone: "081234567890" }],
    ["a formatted US SSN", "national-id", { answerText: "The filing lists 123-45-6789 as the taxpayer." }],
    ["a bare SSN with context", "national-id", { answerText: "SSN 123456789 was on the form." }],
    ["a structurally valid NIK", "national-id", { claim: "Registered under 3204021709900001." }],
    ["a NIK by context", "national-id", { claim: "NIK 9999888877776666 is on the card." }],
    ["an NPWP", "national-id", { claim: "Tax id 09.254.294.3-407.000 was used." }],
    [
      "a PEM private key",
      "private-key",
      { answerText: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----" },
    ],
    [
      "a hex private key with context",
      "private-key",
      {
        answerText:
          "The deployer private key is 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318.",
      },
    ],
    [
      "a hex key named by the field",
      "private-key",
      { privateKey: "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" },
    ],
    [
      "a recovery phrase with context",
      "private-key",
      {
        answerText:
          "mnemonic: legal winner thank year wave sausage worth useful legal winner thank yellow",
      },
    ],
  ];

  it.each(REJECTED)("rejects %s", (_label, kind, fields) => {
    const result = screenForPersonalData(fields);
    expect(result.ok).toBe(false);
    expect(result.matches.map((m) => m.kind)).toContain(kind);
  });
});

describe("false positives the screen must not produce", () => {
  const ACCEPTED: Array<[string, Record<string, string>]> = [
    ["a semantic version", { changelog: "Release 1.4.0 shipped after 1.3.2 and 1.3.0." }],
    [
      "a version number even next to contact wording",
      { support: "Phone support covers version 1.4.0.1234 onwards." },
    ],
    ["an ISO date", { answerText: "The release landed on 2026-08-10 as planned." }],
    ["a build number", { changelog: "Build 20260810123 is the one under test." }],
    ["a 16-digit order id that fails Luhn", { claim: "Order 9999888877776665 was refunded." }],
    ["a block number", { answerText: "Observed in block 5482991 on Galileo." }],
    ["a byte count", { answerText: "The snapshot was 524288 bytes before truncation." }],
    [
      "a task id hash",
      {
        answerText:
          "taskId 0x9d3b81a0dbe6a8f8bd6c4dc2f0f5db2a5f1c9c3f4b6cf2e0a1d2c3b4a5968778 settled.",
      },
    ],
    [
      "a hotel reference, which is not a telephone",
      { answerText: "The hotel booking 12345678 was cancelled." },
    ],
    ["a wallet address", { answerText: "Sent to 0xc1E353cb44eA09729143f06Af97E51FB952b33D7." }],
    ["a percentage and a price", { answerText: "Coverage rose 12.5% and the fee is 0.25 0G." }],
    ["an npm range", { answerText: "Requires node >=20.11.1 and viem ^2.21.55." }],
  ];

  it.each(ACCEPTED)("accepts %s", (_label, fields) => {
    const result = screenForPersonalData(fields);
    expect(result.matches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does not read a version number as a phone number", () => {
    expect(kinds({ support: "Phone support covers version 1.4.0.1234 onwards." })).not.toContain("phone");
  });

  it("does not read a plain 16-digit id as a card", () => {
    // Luhn is the difference: this and 4111111111111111 are the same shape.
    expect(kinds({ claim: "Order 9999888877776665 was refunded." })).not.toContain("payment-card");
    expect(kinds({ claim: "Charged 4111111111111111 on file." })).toContain("payment-card");
  });

  it("does not read a content hash as a private key", () => {
    const hash = "0x9d3b81a0dbe6a8f8bd6c4dc2f0f5db2a5f1c9c3f4b6cf2e0a1d2c3b4a5968778";
    expect(kinds({ answerText: `manifestHash ${hash}` })).not.toContain("private-key");
    expect(kinds({ answerText: `private key ${hash}` })).toContain("private-key");
  });

  it("needs contact wording before calling a number a phone number", () => {
    expect(kinds({ answerText: "The reference is 081234567890." })).not.toContain("phone");
    expect(kinds({ answerText: "Call them on 081234567890." })).toContain("phone");
  });
});

describe("warnings", () => {
  it("warns about a card-shaped number that is not a card", () => {
    const result = screenForPersonalData({ claim: "Order 9999888877776665 was refunded." });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("not a valid payment card");
  });

  it("warns about a 64-hex string that carries no key wording", () => {
    const result = screenForPersonalData({
      answerText: "reportHash 0x9d3b81a0dbe6a8f8bd6c4dc2f0f5db2a5f1c9c3f4b6cf2e0a1d2c3b4a5968778",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("64-character hex string");
  });

  it("says nothing about ordinary prose", () => {
    expect(screenForPersonalData({ question: "Does acme-widgets v1.4.0 support Node 20?" })).toEqual({
      ok: true,
      matches: [],
      warnings: [],
    });
  });

  it("deduplicates repeated warnings within a field", () => {
    const result = screenForPersonalData({
      claim: "Orders 9999888877776665, 1234567890123456 and 1111222233334445 were refunded.",
    });
    expect(new Set(result.warnings).size).toBe(result.warnings.length);
  });

  it("drops the near-miss warning once the number is a real match", () => {
    const result = screenForPersonalData({ claim: "Charged 4111111111111111 on file." });
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("redaction", () => {
  const CARD = "4111111111111111";
  const EMAIL = "alice.smith@example.co.uk";

  it("never echoes the matched value", () => {
    const result = screenForPersonalData({
      claim: `Charged ${CARD} to ${EMAIL} on Tuesday.`,
    });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(CARD);
    expect(serialised).not.toContain(EMAIL);
    expect(serialised).not.toContain("4111");
  });

  it("keeps enough surrounding text to locate the value", () => {
    const result = screenForPersonalData({ claim: `Charged ${CARD} on Tuesday.` });
    expect(result.matches[0]?.excerpt).toContain("Charged");
    expect(result.matches[0]?.excerpt).toContain("[REDACTED payment card number");
    expect(result.matches[0]?.excerpt).toContain("on Tuesday");
  });

  it("does not leak a second secret through the window around the first", () => {
    const result = screenForPersonalData({ claim: `${CARD} ${EMAIL}` });
    expect(result.matches).toHaveLength(2);
    for (const match of result.matches) {
      expect(match.excerpt).not.toContain(EMAIL);
      expect(match.excerpt).not.toContain(CARD);
    }
  });

  it("names the field each match came from", () => {
    const result = screenForPersonalData({
      title: "Quarterly report",
      question: `Was ${CARD} charged?`,
    });
    expect(result.matches).toEqual([
      { field: "question", kind: "payment-card", excerpt: expect.stringContaining("[REDACTED") },
    ]);
  });
});

describe("multiple fields", () => {
  it("screens every field and reports all of them", () => {
    const result = screenForPersonalData({
      title: "Refund dispute",
      question: "Did the refund to alice@example.com clear?",
      "claims[0]": "The card 4111111111111111 was charged twice.",
      "claims[1]": "The order shipped on 2026-08-10.",
    });
    expect(result.ok).toBe(false);
    expect(result.matches.map((m) => [m.field, m.kind])).toEqual([
      ["question", "email"],
      ["claims[0]", "payment-card"],
    ]);
  });

  it("ignores empty and non-string values without throwing", () => {
    const result = screenForPersonalData({
      question: "",
      answerText: undefined as unknown as string,
      claim: "clean",
    });
    expect(result).toEqual({ ok: true, matches: [], warnings: [] });
  });
});

describe("screening cost", () => {
  /**
   * POST /v1/tasks/prepare screens before it fetches anything and needs no
   * session, so a detector that backtracks is a denial-of-service primitive
   * anyone can reach. `a@` followed by a run of `a-` is host-shaped but never
   * terminates, which is the shape the unbounded EMAIL pattern choked on:
   * 45 ms at 8 KB, and inlineText is allowed to be 200 KB.
   */
  it("stays linear on a host-shaped run that never terminates", () => {
    const payload = `a@${"a-".repeat(100_000)}`; // 200 KB, the inlineText cap
    const started = process.hrtime.bigint();
    screenForPersonalData({ inlineText: payload });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  it("still finds the addresses the bounded pattern has to keep finding", () => {
    expect(kinds({ f: "budi.santoso+tag@mail.example.co.id" })).toContain("email");
    expect(kinds({ f: "a@b.io" })).toContain("email");
    expect(kinds({ f: "no-address-here" })).not.toContain("email");
  });
});
