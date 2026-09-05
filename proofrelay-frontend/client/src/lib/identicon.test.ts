import { describe, expect, it } from "vitest";
import { IDENTICON_GRID, identiconFor } from "./identicon";

/** The four verifiers live on 0G mainnet, as the directory renders them. */
const VERIFIER_A = "0xeFf4313AD00b3aD7f3Be18c75Bc862CaA3d1e8FA";
const VERIFIER_B = "0xE51DB46739F04cb4f80Ed99e5FC0Fc438f117Cca";
const VERIFIER_C = "0xDE8d7E40f68627d0A90d52900a65FcC2A5687D5a";
const VERIFIER_D = "0x8C4C8332674583b44A26CA8f605465D77c354c41";
const ALL = [VERIFIER_A, VERIFIER_B, VERIFIER_C, VERIFIER_D];

const signature = (address: string) => {
  const icon = identiconFor(address);
  return `${icon.cells.map((on) => (on ? "1" : "0")).join("")}|${icon.background}|${icon.foreground}`;
};

describe("identiconFor", () => {
  it("fills the whole grid", () => {
    expect(identiconFor(VERIFIER_A).cells).toHaveLength(IDENTICON_GRID * IDENTICON_GRID);
  });

  it("is stable for one address", () => {
    expect(signature(VERIFIER_C)).toBe(signature(VERIFIER_C));
  });

  /**
   * The load-bearing one. EIP-55 lets the same address arrive checksummed from
   * the chain read and lowercased from the indexer; if those produced different
   * icons, the directory row and the operator drawer would disagree about who
   * you are looking at.
   */
  it("ignores address casing", () => {
    expect(signature(VERIFIER_C.toLowerCase())).toBe(signature(VERIFIER_C.toUpperCase().replace("0X", "0x")));
    expect(signature(VERIFIER_C)).toBe(signature(VERIFIER_C.toLowerCase()));
  });

  it("gives the four live verifiers four different icons", () => {
    expect(new Set(ALL.map(signature)).size).toBe(ALL.length);
  });

  it("mirrors each row about its centre column", () => {
    for (const address of ALL) {
      const { cells } = identiconFor(address);
      for (let row = 0; row < IDENTICON_GRID; row += 1) {
        for (let column = 0; column < IDENTICON_GRID; column += 1) {
          const mirrored = IDENTICON_GRID - 1 - column;
          expect(cells[row * IDENTICON_GRID + column]).toBe(cells[row * IDENTICON_GRID + mirrored]);
        }
      }
    }
  });

  it("never renders a blank circle", () => {
    // Includes the degenerate inputs the all-on/all-off guard exists for.
    for (const address of [...ALL, `0x${"00".repeat(20)}`, `0x${"ff".repeat(20)}`]) {
      const on = identiconFor(address).cells.filter(Boolean).length;
      expect(on).toBeGreaterThan(0);
      expect(on).toBeLessThan(IDENTICON_GRID * IDENTICON_GRID);
    }
  });

  it("still returns an icon for a string that is not an address", () => {
    // The directory renders whatever the indexer hands it; one missing avatar
    // is a worse failure than a generic one.
    for (const bad of ["", "0x", "not-an-address", "0xdeadbeef"]) {
      expect(identiconFor(bad).cells).toHaveLength(IDENTICON_GRID * IDENTICON_GRID);
      expect(identiconFor(bad).foreground).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("spreads colour across the whole palette", () => {
    // 256 addresses differing in one byte must reach all sixteen pairs. The
    // first version of this test varied only the LAST byte and asserted eight
    // tones, which passed while three of the four live verifiers were rendering
    // the same coral — it tested the lookup, not the distribution. Vary a byte
    // in the middle, so it also proves the fold reads more than the tail.
    const tones = new Set<string>();
    for (let i = 0; i < 256; i += 1) {
      const byte = i.toString(16).padStart(2, "0");
      tones.add(identiconFor(`0x${"11".repeat(9)}${byte}${"11".repeat(10)}`).background);
    }
    expect(tones.size).toBe(16);
  });

  it("changes colour when any byte changes, not just the last three bits", () => {
    // The failure this replaces: tone came from source[19] % 8, so two addresses
    // agreeing in their low three bits shared a colour however different the
    // rest was.
    const base = `0x${"11".repeat(20)}`;
    const firstByteDiffers = `0x22${"11".repeat(19)}`;
    expect(identiconFor(base).background).not.toBe(identiconFor(firstByteDiffers).background);
  });
});
