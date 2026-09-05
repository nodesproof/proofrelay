/**
 * A verifier's identicon, derived from its address alone.
 *
 * The directory used to label every verifier with the first two hex characters
 * of its address — "EF", "E5", "DE", "8C". Legible, and useless: four operators
 * reduced to four pieces of noise nobody can hold in their head. An identicon is
 * the same information rendered as something the eye recognises without reading.
 *
 * Three decisions worth stating, because each has an obvious alternative that is
 * worse here:
 *
 * 1. **The pattern reads the bytes directly; the colour folds them.** An
 *    Ethereum address is the tail of a keccak hash, so any single byte is
 *    already uniform — good enough for one cell. Colour is different: it is the
 *    thing the eye resolves first at 29px, so it is folded over all twenty bytes
 *    rather than read off one, and no part of the address is ignored.
 *
 * 2. **A curated palette, not random hue.** The usual jazzicon picks hues off
 *    the whole wheel, which looks fine on a white page and fights every surface
 *    on this one — the app's ground is cream (#fffdf7) and its accent is a
 *    single lime. These sixteen pairs extend the four avatar tones the design
 *    already uses, so an identicon reads as part of the page rather than as
 *    something pasted onto it.
 *
 * 3. **Mirrored, not free.** A 5x5 grid of independent cells reads as noise. The
 *    same grid mirrored down its centre column reads as a sigil — the pattern
 *    the eye is already trained on by every other identicon scheme. Only three
 *    columns are derived; the outer two are reflections.
 *
 * Pure and address-only on purpose: a verifier that registers tomorrow gets an
 * icon with no configuration, no upload, and no metadata round-trip. That
 * matters because verifier metadata is written once at registration — see
 * `ensureRegistered` in the worker — so an operator-supplied icon could not be
 * retrofitted to a verifier that is already live without re-registering it.
 */

/**
 * Sixteen background/foreground pairs: the eight avatar hues the design already
 * uses, each in a soft and a deep variant.
 *
 * Sixteen rather than eight because the palette size, not the derivation, is
 * what decides collisions. Colour is drawn uniformly, so four verifiers drawing
 * from eight pairs collide 59% of the time — and they did: three of the first
 * four live verifiers came out the same coral, distinguishable only by pattern,
 * which at 29px reads as three identical blobs. Sixteen brings that to ~33%.
 *
 * The soft/deep split does the rest of the work. Two icons that land on the same
 * hue still differ in weight, and weight survives being 29 pixels wide in a way
 * that a five-by-five pattern does not.
 */
const PALETTE: ReadonlyArray<{ background: string; foreground: string }> = [
  { background: "#e8f7c4", foreground: "#6b8a42" }, // lime, soft
  { background: "#cfeb8a", foreground: "#40561f" }, // lime, deep
  { background: "#e2f2fb", foreground: "#5183a3" }, // sky, soft
  { background: "#bfe0f5", foreground: "#2f556f" }, // sky, deep
  { background: "#ffeae4", foreground: "#b06a5c" }, // coral, soft
  { background: "#ffd0c4", foreground: "#7e3f32" }, // coral, deep
  { background: "#e6ece8", foreground: "#4a6360" }, // ink, soft
  { background: "#c9d6d1", foreground: "#243634" }, // ink, deep
  { background: "#eef5e2", foreground: "#5f7f42" }, // moss, soft
  { background: "#d8ebba", foreground: "#3d5726" }, // moss, deep
  { background: "#eaeff4", foreground: "#5a6b7d" }, // slate, soft
  { background: "#ccd8e4", foreground: "#38475a" }, // slate, deep
  { background: "#faefe6", foreground: "#a06f4e" }, // clay, soft
  { background: "#f0dcc9", foreground: "#6d452a" }, // clay, deep
  { background: "#e6f5f0", foreground: "#4b8377" }, // teal, soft
  { background: "#c6e6dc", foreground: "#2c5449" }, // teal, deep
];

export const IDENTICON_GRID = 5;
/** Columns actually derived; the rest are mirrored. ceil(5 / 2). */
const DERIVED_COLUMNS = 3;
const DERIVED_CELLS = IDENTICON_GRID * DERIVED_COLUMNS; // 15

export interface Identicon {
  /** `IDENTICON_GRID`² cells, row-major. `true` paints the foreground. */
  cells: boolean[];
  background: string;
  foreground: string;
}

/** 20 address bytes, or null when the string is not one. */
function addressBytes(address: string): number[] | null {
  // Case-insensitive by construction: EIP-55 checksums the same address two
  // ways, and the directory row and the drawer must not disagree about which
  // icon a verifier has.
  const hex = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 40; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/**
 * The icon for `address`. Deterministic, and stable for the life of the address.
 *
 * An unparseable address still gets an icon rather than a hole — the directory
 * renders whatever the indexer hands it, and a missing avatar in one row is a
 * worse failure than a generic one.
 */
export function identiconFor(address: string): Identicon {
  const bytes = addressBytes(address);
  const source = bytes ?? new Array<number>(20).fill(0);

  const derived: boolean[] = [];
  for (let i = 0; i < DERIVED_CELLS; i += 1) {
    // Top bit of one byte per cell: a uniform byte gives an even fill.
    derived.push((source[i]! & 0x80) !== 0);
  }

  // All-on and all-off are both a blank circle. Each has probability 2^-15, so
  // this branch is nearly dead — but "nearly" is the wrong guarantee for the
  // only thing distinguishing two operators, and the fix is one flipped cell.
  const filled = derived.filter(Boolean).length;
  if (filled === 0 || filled === DERIVED_CELLS) {
    derived[Math.floor(DERIVED_CELLS / 2)] = !derived[Math.floor(DERIVED_CELLS / 2)];
  }

  const cells: boolean[] = [];
  for (let row = 0; row < IDENTICON_GRID; row += 1) {
    for (let column = 0; column < IDENTICON_GRID; column += 1) {
      // Mirror the outer columns onto the derived ones: 4 -> 0, 3 -> 1.
      const mirrored = column < DERIVED_COLUMNS ? column : IDENTICON_GRID - 1 - column;
      cells.push(derived[row * DERIVED_COLUMNS + mirrored]!);
    }
  }

  // Folded over every byte, not read from one. A single byte is uniform enough
  // on its own, but it lets three of twenty bytes decide the most visible thing
  // about the icon; folding means an address that differs anywhere differs in
  // colour. The fold starts past the cells the pattern used so the two are not
  // reading the same bits first.
  let mixed = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    mixed = (mixed ^ source[(i + DERIVED_CELLS) % source.length]!) >>> 0;
    mixed = Math.imul(mixed, 0x01000193) >>> 0;
  }
  const tone = PALETTE[mixed % PALETTE.length]!;
  return { cells, background: tone.background, foreground: tone.foreground };
}
