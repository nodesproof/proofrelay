import { IDENTICON_GRID, identiconFor } from "@/lib/identicon";
import { shortAddress } from "@/lib/format";

/**
 * The avatar every verifier is drawn with, here and on the task record.
 *
 * It replaced two hex characters of the address — "EF", "E5", "DE", "8C" — which
 * were unique but unmemorable, and which three call sites derived separately.
 * The pattern comes from `lib/identicon`; this file only paints it.
 *
 * The background used to carry status through `.{lime,sky,coral,ink}-avatar`.
 * That is now the identicon's own colour, and nothing is lost: every row that
 * shows an avatar already shows the ONLINE/DEGRADED pill beside it, so the
 * avatar was spending its only colour channel repeating its neighbour instead
 * of saying which operator this is. On the task record it never carried status
 * at all — that call site hardcoded the lime tone.
 */
export default function VerifierAvatar({
  address,
  className = "",
  title,
}: {
  address: string;
  /** Extra avatar classes, e.g. `large-avatar`. */
  className?: string;
  title?: string;
}) {
  const { cells, background, foreground } = identiconFor(address);
  const label = `Verifier ${shortAddress(address)}`;

  return (
    <span
      className={`verifier-avatar identicon-avatar ${className}`.trim()}
      role="img"
      aria-label={label}
      title={title ?? label}
    >
      <svg
        viewBox={`0 0 ${IDENTICON_GRID} ${IDENTICON_GRID}`}
        width="100%"
        height="100%"
        // The pattern is the label; announcing the rects twice helps nobody.
        aria-hidden="true"
        focusable="false"
        shapeRendering="crispEdges"
      >
        <rect width={IDENTICON_GRID} height={IDENTICON_GRID} fill={background} />
        {cells.map((on, index) =>
          on ? (
            <rect
              key={index}
              x={index % IDENTICON_GRID}
              y={Math.floor(index / IDENTICON_GRID)}
              width="1"
              height="1"
              fill={foreground}
            />
          ) : null,
        )}
      </svg>
    </span>
  );
}
