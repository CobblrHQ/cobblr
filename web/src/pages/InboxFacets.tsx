// The inbox header's counts: the total and the facets a person acts on. Its own
// file so the order they sit in is held by a test (#6881).
import type { ReactNode } from "react";

export interface InboxFacetProps {
  totalPending: number;
  confidentCount: number;
  reviewCount: number;
  staleCount: number;
  showReadyFacet: boolean;
  rowCarriesFacet: boolean;
  reviewOnly: boolean;
  staleOnly: boolean;
  onReady: () => void;
  onReview: () => void;
  onStale: () => void;
}

export function InboxFacets({ totalPending, confidentCount, reviewCount, staleCount, showReadyFacet, rowCarriesFacet, reviewOnly, staleOnly, onReady, onReview, onStale }: InboxFacetProps): ReactNode {
  return (
  <div data-inbox-facets className="flex items-baseline gap-0 max-sm:gap-2 shrink min-w-0 leading-none overflow-x-auto [&>*]:shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden whitespace-nowrap text-[13px] text-muted dark:text-slate-400">
    {/* The total. On a tablet the word is a luxury the counts paid ~55px
        for, so it shows only on a desktop or on an empty inbox (a lone
        "0" is a riddle). On a phone it leaves the row whenever a facet
        is there (see rowCarriesFacet) and says its word when it stays:
        "1  1 to review" read as two numbers side by side (#3497). */}
    <span className={rowCarriesFacet ? "max-sm:hidden" : ""}>
      <span className="text-sm font-semibold text-content dark:text-mortar-100">{totalPending}</span>
      <span className={totalPending === 0 ? "" : "sm:hidden lg:inline"}>&nbsp;pending</span>
    </span>
    {/* "To review" comes before "ready" on every width: the reads that
        make an item ready finish after the first paint, so the ready
        count arrives last. Behind the review button it would push that
        button 66 px right when it came (a-ten-spool-pack walk, #6881);
        after it, the count appears at the row's end and nothing moves. */}
    {reviewCount > 0 && (
      <>
        <span className="hidden sm:inline px-1 text-faint">·</span>
        <button
          type="button"
          onClick={onReview}
          aria-pressed={reviewOnly}
          title="No clean name, low confidence, or the lookup was rate-limited - these need a human"
          className={
            "max-sm:-order-1 rounded px-1 py-0.5 text-[12.5px] transition " +
            (reviewOnly
              ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200"
              : "hover:bg-subtle dark:hover:bg-slate-800")
          }
        >
          <b className="font-semibold text-amber-600 dark:text-amber-400">{reviewCount}</b>
          <span>&nbsp;to review</span>
        </button>
      </>
    )}
    {showReadyFacet && (
      <>
        <span className="hidden sm:inline px-1 text-faint">·</span>
        <button
          type="button"
          onClick={onReady}
          title="A confident name and destination, nothing flagged - these are what File all commits"
className="rounded px-1 py-0.5 text-[12.5px] hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <b className="font-semibold text-emerald-600 dark:text-emerald-400">
            {confidentCount}
          </b>
          {/* The word at every width. Under lg these facets dropped
              their words for a bare glyph, and on a phone that drew as a
              4px wedge a stranger at a stand had to decode (#3321): a
              count followed by a symbol says nothing; "1 to review"
              costs about 60px the row can spend, since it scrolls. */}
          <span>&nbsp;ready</span>
        </button>
      </>
    )}
    {/* A facet covering the WHOLE set states one fact twice ("69 pending ·
        69 waiting 2d+"), so it earns its space only as a subset. */}
    {/* Desktop only. Of the four, this is the one that is NOT a disjoint
        slice - a waiting item is also ready or needing review - so it is
        the first to give up its spot when the row is tight. It stays
        reachable in the ... menu on a phone. */}
    {staleCount > 0 && staleCount < totalPending && (
      <span className="hidden sm:contents">
      <>
        <span className="hidden sm:inline px-1 text-faint">·</span>
        <button
          type="button"
          onClick={onStale}
          aria-pressed={staleOnly}
          title="Waiting more than two days"
          className={
            "ml-1.5 sm:ml-0 rounded px-1 py-0.5 text-[12.5px] transition " +
            (staleOnly
              ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200"
              : "hover:bg-subtle dark:hover:bg-slate-800")
          }
        >
          {/* Glyph at EVERY width: "waiting 2d+" is the longest label on
              the row and belongs to the facet that earns it least. The
              words live in the tooltip. */}
          <b className="font-semibold">{staleCount}</b>&nbsp;⏱
        </button>
      </>
      </span>
    )}
  </div>
  );
}
