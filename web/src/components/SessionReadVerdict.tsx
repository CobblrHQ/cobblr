// A receipt session's read verdict, as the inbox row shows it. One rule
// (platform-contract scan-session's sessionVerdict) decides; this renders it:
//   failed    → the sentence with the router's reason, a visible Read again,
//               and the connect hint when no provider is the reason
//   in_flight → "Reading the receipt…" with a spinner, from the session's
//               own clock (never from the absence of lines)
//   the rest  → nothing; the ordinary header speaks
// A failed receipt used to read "not read yet · 1 item · 1 finishing…" for
// ever, its only retry an icon with a tooltip (#2892).
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type { SessionVerdict } from "@cobblr/platform-contract/scan-session";

export function SessionReadVerdict({
  verdict,
  reading,
  onReadAgain,
  configureAiHref,
  compact = false,
}: {
  verdict: SessionVerdict;
  /** The header bar's one-line form: the verdict and its Read again, the
   *  sentence as the title. The full form goes in the session's body. */
  compact?: boolean;
  /** A Read again is in flight from this row (the mutation), before the
   *  session's own in_flight state has come back on the next poll. */
  reading: boolean;
  onReadAgain: () => void;
  /** Where "connect an AI provider" goes. */
  configureAiHref: string;
}) {
  if (verdict.kind === "in_flight" || reading) {
    return (
      <span
        data-testid="session-reading"
        className="inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-1.5 py-0.5 text-[10px] font-medium text-accent"
      >
        <Loader2 size={9} className="animate-spin" /> Reading the receipt…
      </span>
    );
  }
  if (verdict.kind !== "failed") return null;
  if (compact) {
    return (
      <span
        data-testid="session-read-failed-chip"
        title={verdict.sentence}
        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200"
        onClick={(e) => e.stopPropagation()}
      >
        <AlertTriangle size={9} /> Couldn't be read
        <button type="button" onClick={onReadAgain} data-testid="session-read-again-chip" className="underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100">
          Read again
        </button>
      </span>
    );
  }
  return (
    <div
      data-testid="session-read-failed"
      className="basis-full mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 text-[12px] text-amber-800 dark:text-amber-200"
      onClick={(e) => e.stopPropagation()}
    >
      <AlertTriangle size={12} className="shrink-0" />
      <span className="min-w-0 flex-1">{verdict.sentence}</span>
      {verdict.connect && (
        <Link to={configureAiHref} className="shrink-0 underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-100" data-testid="session-connect-ai">
          Connect an AI provider
        </Link>
      )}
      <button
        type="button"
        onClick={onReadAgain}
        data-testid="session-read-again"
        className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-600 hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 text-white dark:text-amber-950 px-2 py-1 text-[11px] font-medium"
      >
        <RotateCcw size={11} /> Read again
      </button>
    </div>
  );
}
