// The pictures on their way into the inbox, drawn at once (lib/pendingPictures.ts).

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { dropPending, usePendingPictures } from "../lib/pendingPictures";

const STAGE_WORDS = {
  uploading: "Uploading…",
  reading: "Reading the picture…",
  failed: "Couldn't add this picture.",
} as const;

export function ScanPendingPictures({ slug, rowIds }: { slug: string; rowIds: ReadonlySet<string> }) {
  const pending = usePendingPictures(slug);
  // A picture gives way to its row once that row is in the list.
  useEffect(() => {
    for (const p of pending) if (p.rowId && rowIds.has(p.rowId)) dropPending(slug, p.key);
  }, [pending, rowIds, slug]);
  const shown = pending.filter((p) => !(p.rowId && rowIds.has(p.rowId)));
  if (!shown.length) return null;
  return (
    <div className="space-y-2" data-testid="pending-pictures">
      {shown.map((p) => (
        <div
          key={p.key}
          data-testid="pending-picture"
          className="flex items-center gap-3 rounded-lg border border-accent/50 bg-cobble-50/60 dark:bg-cobble-900/20 p-2.5"
        >
          {p.url ? <img src={p.url} alt="" className="h-14 w-14 shrink-0 rounded object-cover" /> : <div className="h-14 w-14 shrink-0 rounded bg-subtle" />}
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex items-center gap-1.5 text-content dark:text-mortar-100">
              {p.stage !== "failed" && <Loader2 size={13} className="animate-spin text-accent" />}
              <span data-testid="pending-picture-stage">{STAGE_WORDS[p.stage]}</span>
            </div>
            <div className="truncate text-xs text-muted dark:text-slate-400">{p.name}</div>
          </div>
          {p.stage === "failed" && (
            <button type="button" onClick={() => dropPending(slug, p.key)} className="text-xs text-muted underline">
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
