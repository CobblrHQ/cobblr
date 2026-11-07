// The pictures on their way into the inbox, drawn at once (lib/pendingPictures.ts).
// Each has its own X (#9271): the wrong picture can be taken back at any stage,
// with no confirm, because Undo is right there and nothing a person kept is lost.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { dropPending, markTakenBack, usePendingPictures, type PendingPicture } from "../lib/pendingPictures";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

const STAGE_WORDS = {
  uploading: "Uploading…",
  reading: "Reading the picture…",
  // failure-copy: the upload's own recorded stage, set when its request failed.
  failed: "Couldn't add this picture.",
} as const;

export function ScanPendingPictures({ slug, rowIds }: { slug: string; rowIds: ReadonlySet<string> }) {
  const pending = usePendingPictures(slug);
  const toast = useToast();
  const qc = useQueryClient();
  // A picture gives way to its row once that row is in the list.
  useEffect(() => {
    for (const p of pending) if (p.rowId && rowIds.has(p.rowId)) dropPending(slug, p.key);
  }, [pending, rowIds, slug]);
  const refresh = () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });

  const takeBack = async (p: PendingPicture) => {
    const door = markTakenBack(p.key);
    dropPending(slug, p.key);
    // The upload hadn't finished: it has stopped, and there is nothing to read again.
    if (!p.fileId) {
      toast.info(`Removed ${p.name}. It hadn't finished uploading.`);
      return;
    }
    try {
      const r = await api.takeBackScanPicture(slug, p.rowId ? { item_id: p.rowId } : { file_id: p.fileId });
      refresh();
      if (r.outcome === "joined" || r.outcome === "filed") {
        toast.info(`This picture is already part of ${r.name ?? "a scan"}, so it was left there.`);
        return;
      }
      toast.action(`Removed ${p.name}.`, {
        actionLabel: "Undo",
        duration: 10000,
        onAction: () => {
          if (r.item_id) void api.restoreScanItem(slug, r.item_id).then(refresh).catch((e) => toast.error(e instanceof ApiError ? e.message : String(e)));
          else door?.again();
        },
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

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
          </div>
          {p.stage === "failed" ? (
            <button type="button" onClick={() => dropPending(slug, p.key)} className="text-xs text-muted underline">
              Dismiss
            </button>
          ) : (
            <button
              type="button"
              data-testid="pending-picture-take-back"
              aria-label={`Take back ${p.name}`}
              title={`Take back ${p.name}`}
              onClick={() => void takeBack(p)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-content dark:hover:bg-slate-800"
            >
              <X size={18} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
