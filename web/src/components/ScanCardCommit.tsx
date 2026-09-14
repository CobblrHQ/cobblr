// The commit half of an inbox card's destination pill: Add, or Review.
//
// Whether a card may commit in one tap is the platform contract's readiness
// rule (scan-triage.ts, isScanReadyToFile), the same rule File and File N
// read. It used to be decided here from the name and the route alone, so a
// row the pipeline had flagged for review (a crop that could not be cut,
// twins that disagree, a low-trust lookup) showed a green Add beside the
// header's warning count (#2980). Now a flagged row offers Review, titled
// with its reason, and Add is only ever offered to a row the bulk sweep
// would also commit.
import { CheckCircle, Download } from "lucide-react";
import { isScanReadyToFile, scanReviewReason, type ScanTriageRow } from "@cobblr/platform-contract/scan-triage";

export interface ScanCardCommitProps {
  item: ScanTriageRow;
  /** The destination the pill names ("Groceries"). */
  destLabel: string;
  /** The chosen route is a keyword-only guess (no AI): tentative, never one-tap. */
  tentative: boolean;
  /** The destination is a bundle's table this workspace has not installed. */
  installs: boolean;
  /** ...and the person may install it (owner or admin, bundle resolved). */
  canInstall: boolean;
  /** The workspace already tracks this thing: the merge banner in the open
   *  card is the right door, not a create. */
  alreadyTracked: boolean;
  /** A commit is in flight. */
  busy: boolean;
  onAdd: () => void;
  onReview: () => void;
}

/** Why this card offers Review instead of Add, for its tooltip. Null when
 *  it offers Add. */
export function reviewTitle(p: ScanCardCommitProps): string | null {
  if (scanCardMayAdd(p)) return null;
  const reason = scanReviewReason(p.item);
  if (reason) return `Needs a look first: ${reason}`;
  if (p.tentative) return `A keyword guess (no AI) - open to review before filing into ${p.destLabel}`;
  return `Review before adding to ${p.destLabel}`;
}

export function scanCardMayAdd(p: ScanCardCommitProps): boolean {
  return isScanReadyToFile(p.item) && !p.tentative && !p.alreadyTracked && (!p.installs || p.canInstall);
}

export function ScanCardCommit(p: ScanCardCommitProps) {
  if (scanCardMayAdd(p)) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          p.onAdd();
        }}
        disabled={p.busy}
        title={p.installs ? `Install ${p.destLabel} and add this to it, with the scan's values as shown` : `Add to ${p.destLabel} as shown`}
        className="inline-flex shrink-0 items-center gap-1 border-l border-white/25 bg-emerald-600 hover:bg-emerald-500 pl-2 pr-2.5 py-1 transition disabled:opacity-60"
      >
        {/* A table that has to be INSTALLED first commits from here too. It
            used to be suppressed so a second brown button could carry the same
            mutation on its own, which left the pill offering Review while the
            real commit sat outside it (reported 2026-08-19). The word changes;
            the action is the one this button always ran. */}
        {p.installs ? (
          <Download size={11} className={`shrink-0 ${p.busy ? "animate-pulse" : ""}`} />
        ) : (
          <CheckCircle size={11} className={`shrink-0 ${p.busy ? "animate-pulse" : ""}`} />
        )}
        {p.busy ? (p.installs ? "Installing…" : "Adding…") : p.installs ? (
          <>
            Install<span className="max-sm:hidden"> &amp; add</span>
          </>
        ) : (
          "Add"
        )}
      </button>
    );
  }
  // Withheld on purpose: a row flagged for review, a keyword-only guess, or a
  // table that has to be INSTALLED first. Each deserves the explaining step,
  // so they open the card instead of committing.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        p.onReview();
      }}
      title={reviewTitle(p) ?? undefined}
      className={
        "inline-flex shrink-0 items-center gap-1 border-l pl-2 pr-2.5 py-1 transition " +
        (p.tentative ? "border-cobble-500/50 hover:bg-cobble-600/10" : "border-white/25 hover:bg-cobble-700")
      }
    >
      Review
    </button>
  );
}
