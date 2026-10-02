// A scan session's identity on its one header line: the name, the order
// number, the date and the count, with an order for giving way.
//
// Under pressure the ORDER NUMBER goes first (it is in the session when you
// open it, and on the tooltip), then a merchant's name shortens with an
// ellipsis but keeps its first characters. A date, a time and a count never
// shorten mid-word: "Sep 1, 8:4…" spends width on a character that says
// nothing (the owner, 2026-09-25). They drop whole words instead, "Sep 1,
// 8:42 PM" to "Sep 1", "100 items" to "100", and the long form is on the
// tooltip.
//
// It was three separate spans with no order, and the order number sat in a
// no-shrink tail beside the date and count. A long invoice number took the
// whole line: the row opened on "· #REVIEW-2026-…", the merchant was gone,
// the date was cut and the count was off the edge (#3704). The widths are
// e2e/session-headline-fits.test.mjs, in a real browser at phone sizes.
import { useLayoutEffect, useRef, useState } from "react";

/** Below this many characters the name is shown whole, so the floor never
 *  pads a short name out into a hole, and a longer one keeps this many: the
 *  order number gives way first, never "eB… · #08-15026-52…". */
const NAME_FLOOR_CH = 6;
/** Narrow no-break spaces: a flex item drops a plain leading space (so the
 *  dot ran into the name, #3393), and a full-width one costs the tightest
 *  phone row the pixels its count needs. */
const SEP = " · ";

/**
 * The longest of `variants` that fits the width it is given, never a cut one.
 * The last variant is shown whatever happens. Re-measured whenever the line
 * changes width, so turning a phone sideways brings the long form back.
 */
export function Fit({ variants, shrink = "shrink", title, isName }: { variants: readonly string[]; shrink?: string; title?: string; isName?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState(0);
  const key = variants.join("\u0000");
  useLayoutEffect(() => setAt(0), [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && at < variants.length - 1 && el.scrollWidth > el.clientWidth + 0.5) setAt(at + 1);
  });
  useLayoutEffect(() => {
    const line = ref.current?.closest("[data-session-headline]")?.parentElement;
    if (!line || typeof ResizeObserver === "undefined") return;
    let last = line.clientWidth;
    const ro = new ResizeObserver(() => {
      if (line.clientWidth !== last) {
        last = line.clientWidth;
        setAt(0);
      }
    });
    ro.observe(line);
    return () => ro.disconnect();
  }, []);
  // The shortest form never gives way: it is what is left to say.
  const last = at >= variants.length - 1;
  return (
    <span ref={ref} data-fit={at} data-headline-name={isName || undefined} title={title} className={`${last ? "shrink-0" : `min-w-0 ${shrink}`} overflow-hidden whitespace-nowrap`}>
      {variants[Math.min(at, variants.length - 1)]}
    </span>
  );
}

export function SessionHeadline({
  name,
  nameFits,
  orderRef,
  onEditRef,
  date,
  dateTitle,
  count,
}: {
  /** A name that shortens with an ellipsis: a merchant, a place. */
  name?: string | null;
  /** A name made of words that drop whole instead (a session named by when
   *  it was scanned), longest first. */
  nameFits?: readonly string[];
  orderRef?: string | null;
  /** When set, the order number is a button that edits it. Leave unset where
   *  the headline itself is a button (a phone folds the session on it). */
  onEditRef?: () => void;
  date?: string | null;
  dateTitle?: string;
  count?: number | null;
}) {
  const ref = orderRef ? `${SEP}#${orderRef}` : null;
  const items = count == null ? null : `${count} item${count === 1 ? "" : "s"}`;
  return (
    <span data-session-headline className="flex min-w-0 items-baseline">
      {nameFits?.length ? (
        <Fit variants={nameFits} title={nameFits[0]} shrink="shrink-[1000]" isName />
      ) : (
        <span
          data-headline-name
          className={`truncate ${(name ?? "").length > NAME_FLOOR_CH ? "min-w-[6ch] shrink-[1000]" : "shrink-0"}`}
        >
          {name}
        </span>
      )}
      {ref &&
        (onEditRef ? (
          <button
            type="button"
            data-headline-ref
            onClick={(e) => {
              e.stopPropagation();
              onEditRef();
            }}
            title={`#${orderRef} - edit the order / invoice number`}
            className="min-w-0 shrink-[100000] truncate font-medium text-muted hover:text-accent transition"
          >
            {ref}
          </button>
        ) : (
          <span data-headline-ref title={`#${orderRef}`} className="min-w-0 shrink-[100000] truncate font-medium text-muted">
            {ref}
          </span>
        ))}
      {date && (
        <span data-session-date title={dateTitle} className="shrink-0 whitespace-nowrap font-normal text-faint">
          {SEP}
          {date}
        </span>
      )}
      {items && (
        <span data-headline-count className="flex min-w-0 font-normal text-faint" title={items}>
          <span className="shrink-0 whitespace-pre">{SEP}</span>
          <Fit variants={[items, String(count)]} />
        </span>
      )}
    </span>
  );
}
