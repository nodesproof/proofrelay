// A numbered pager for the Evidence Ledger tables. It renders nothing at all
// when everything fits on one page, because a control whose only possible
// action is "stay here" is furniture rather than an affordance.
//
// The page count comes from the API's filtered total, so it describes the list
// as filtered rather than the whole table — the number above the list and the
// number of pages below it always agree.
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * The page numbers to render, with `null` standing for an elision.
 *
 * First and last are always reachable, and the current page always sits inside
 * a window of its neighbours, so the control neither grows without bound nor
 * strands the reader in the middle with no way back to either end. An elision
 * is only drawn where it actually hides something: with 8 pages and `…`
 * costing the same width as the number it would replace, a gap of exactly one
 * is rendered as that page.
 */
export function pageRange(current: number, total: number, window = 1): Array<number | null> {
  if (total <= 0) return [];
  const keep = new Set<number>([0, total - 1]);
  for (let page = current - window; page <= current + window; page += 1) {
    if (page >= 0 && page < total) keep.add(page);
  }
  const sorted = [...keep].sort((a, b) => a - b);

  const out: Array<number | null> = [];
  let previous: number | null = null;
  for (const page of sorted) {
    if (previous !== null) {
      const gap = page - previous;
      if (gap === 2) out.push(previous + 1);
      else if (gap > 2) out.push(null);
    }
    out.push(page);
    previous = page;
  }
  return out;
}

/** "1–8 of 62" — the range this page actually covers, clamped to the total. */
export function pageWindowLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return "0 of 0";
  const first = page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);
  return `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

interface PaginationProps {
  /** Zero-based. */
  page: number;
  pageSize: number;
  /** The filtered total the API reported, not the size of the loaded page. */
  total: number;
  onPage: (page: number) => void;
  /** What is being counted, for the label and the screen-reader names. */
  unit: string;
  /** True while a page is in flight; the old rows are still on screen. */
  busy?: boolean;
  /**
   * The highest page the data source can actually address. Offering a button
   * for a page the server will refuse makes a dead end out of a control whose
   * whole job is to be a way out of one.
   */
  maxPage?: number;
}

export default function Pagination({ page, pageSize, total, onPage, unit, busy = false, maxPage }: PaginationProps) {
  const available = Math.ceil(total / pageSize);
  const pages = maxPage === undefined ? available : Math.min(available, maxPage + 1);
  if (pages <= 1) return null;

  const clamped = Math.min(Math.max(page, 0), pages - 1);
  const go = (next: number) => { if (!busy && next !== clamped && next >= 0 && next < pages) onPage(next); };

  /**
   * `aria-disabled` rather than `disabled`. A disabled button is removed from
   * the tab order the instant it becomes disabled — so activating "Next" on the
   * second-to-last page, or any page number while the next page loads, drops
   * the focus that just did the activating onto the document body. The state is
   * still announced, the click is still refused, and the reader keeps their
   * place.
   */
  const step = (target: number, off: boolean, label: string, children: React.ReactNode) => (
    <button
      className="pagination-step"
      onClick={() => { if (!off) go(target); }}
      aria-disabled={off || busy}
      aria-label={label}
    >
      {children}
    </button>
  );

  return (
    <nav className="pagination" aria-label={`${unit} pages`}>
      {/* A live region: without it the page changes under a screen-reader user
          and nothing says so, because the rows above are not focused and the
          button they pressed still reads the same. */}
      <p className="pagination-count" role="status">
        Showing {pageWindowLabel(clamped, pageSize, total)} {unit}
      </p>
      <div className="pagination-controls">
        {step(clamped - 1, clamped === 0, "Previous page", <><ChevronLeft size={14} />Prev</>)}
        <div className="pagination-pages">
          {pageRange(clamped, pages).map((entry, index) =>
            entry === null ? (
              // Presentational: the gap is a visual shorthand for the pages
              // either side of it, and reading "ellipsis" aloud says nothing.
              <span className="pagination-gap" key={`gap-${index}`} aria-hidden="true">…</span>
            ) : (
              <button
                className={`pagination-page${entry === clamped ? " active" : ""}`}
                key={entry}
                onClick={() => go(entry)}
                aria-disabled={busy}
                aria-label={`Page ${entry + 1}`}
                aria-current={entry === clamped ? "page" : undefined}
              >
                {entry + 1}
              </button>
            ),
          )}
        </div>
        {step(clamped + 1, clamped >= pages - 1, "Next page", <>Next<ChevronRight size={14} /></>)}
      </div>
    </nav>
  );
}
