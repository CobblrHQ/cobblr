// The commit half of an inbox card's destination pill: Add, Install & add,
// +1 more, or Review.
//
// What the button says and does is the platform contract's answer
// (scan-triage.ts, scanRowState): one resolver the list row, this card and
// the session's File N all read, so they cannot disagree (#3076). It used to
// combine the readiness rule with four booleans of its own (tentative,
// installs, canInstall, alreadyTracked), which is how a row read Review here
// while its session offered File 1. Now this renders the state it is given.
import { CheckCircle, Download, PackagePlus } from "lucide-react";
import type { ScanRowState } from "@cobblr/platform-contract/scan-triage";

export interface ScanCardCommitProps {
  /** The row's resolved state (scanRowState). */
  state: ScanRowState;
  /** A commit is in flight. */
  busy: boolean;
  onAdd: () => void;
  onReview: () => void;
}

/** Why this card offers Review instead of Add, for its tooltip. Null when
 *  it offers Add. */
export function reviewTitle(p: ScanCardCommitProps): string | null {
  return p.state.action.kind === "review" || p.state.action.kind === "blocked" ? `Needs a look first: ${p.state.action.title}` : null;
}

export function scanCardMayAdd(p: ScanCardCommitProps): boolean {
  return p.state.action.kind === "add" || p.state.action.kind === "install-add" || p.state.action.kind === "merge";
}

export function ScanCardCommit(p: ScanCardCommitProps) {
  const installs = p.state.action.kind === "install-add";
  const merges = p.state.action.kind === "merge";
  if (scanCardMayAdd(p)) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          p.onAdd();
        }}
        disabled={p.busy}
        title={p.state.action.title}
        data-testid="card-commit"
        className="inline-flex shrink-0 items-center gap-1 border-l border-white/25 bg-emerald-600 hover:bg-emerald-500 pl-2 pr-2.5 py-1 transition disabled:opacity-60"
      >
        {/* A table that has to be INSTALLED first commits from here too. It
            used to be suppressed so a second brown button could carry the same
            mutation on its own, which left the pill offering Review while the
            real commit sat outside it (reported 2026-08-19). The word changes;
            the action is the one this button always ran. */}
        {installs ? (
          <Download size={11} className={`shrink-0 ${p.busy ? "animate-pulse" : ""}`} />
        ) : merges ? (
          <PackagePlus size={11} className={`shrink-0 ${p.busy ? "animate-pulse" : ""}`} />
        ) : (
          <CheckCircle size={11} className={`shrink-0 ${p.busy ? "animate-pulse" : ""}`} />
        )}
        {p.busy ? (installs ? "Installing…" : "Adding…") : p.state.action.label}
      </button>
    );
  }
  // Withheld on purpose: a row flagged for review, a keyword-only guess, a
  // duplicate, or a person who cannot file here. Each deserves the
  // explaining step, so they open the card instead of committing.
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        p.onReview();
      }}
      title={reviewTitle(p) ?? undefined}
      data-testid="card-commit"
      className="inline-flex shrink-0 items-center gap-1 border-l border-white/25 hover:bg-cobble-700 pl-2 pr-2.5 py-1 transition"
    >
      {p.state.action.label}
    </button>
  );
}
