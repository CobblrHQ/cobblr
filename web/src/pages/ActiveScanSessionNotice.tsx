import { Link } from "react-router-dom";
import type { ScanSession } from "../lib/scanSession";

export function ActiveScanSessionNotice({ settled, session, onEnd }: {
  settled: boolean;
  session: ScanSession;
  onEnd: () => void;
}) {
  if (!settled) return null;
  return (
    <div data-testid="active-scan-session-notice" data-inbox-counts className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-300/60 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 px-2.5 py-1.5 text-xs text-muted">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
      <span className="text-content dark:text-mortar-100 font-medium">
        Scan session active
        {session.count ? ` (${session.count} item${session.count === 1 ? "" : "s"})` : ""}
      </span>
      <span className="hidden sm:inline">· groups until 30 min idle</span>
      <span className="ml-auto inline-flex items-center gap-2 shrink-0">
        {session.batchId && (
          <Link
            to={`/scan?batch=${session.batchId}`}
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
          >
            Review session
          </Link>
        )}
        <button
          type="button"
          onClick={onEnd}
          className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
        >
          End session
        </button>
      </span>
    </div>
  );
}
