// One order line and the parts it came apart into (#6067). The owner: "The
// problem is that the UI does not show how one line item was expanded into
// its contents." The line stays visible as the parent, with its picture, its
// price and how the split was decided; its parts sit under it in a box, each
// its own card. The parent's actions are the group's: Add all, Undo split,
// and collapse. On a phone the group starts collapsed to its parent.
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Scissors } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { api, ApiError, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { currentPicture, rowPictures } from "../lib/rowPictures";
import type { SplitParent } from "../lib/splitLayout";

const phone = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639.98px)").matches;

export function SplitLineGroup({
  parentId,
  summary,
  parentCard,
  parts,
  renderPart,
  onAddAll,
}: {
  parentId: string;
  summary: SplitParent | null;
  /** The parent's own card, when the line is still open (Split off). */
  parentCard: ReactNode | null;
  parts: readonly ScanInboxItem[];
  renderPart: (item: ScanInboxItem) => ReactNode;
  /** Files every waiting part, each to its own table. */
  onAddAll: (ids: string[]) => Promise<unknown> | void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(() => !phone());
  const undo = useMutation({
    mutationFn: () => api.unsplitScanItem(activeSlug, parentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success("Put back as one line");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const [adding, setAdding] = useState(false);
  const row = summary?.row ?? null;
  const pics = row ? rowPictures(activeSlug, row) : null;
  const pic = pics ? currentPicture(pics.pictures) : null;
  const thumb = pic && pics ? pics.src(pic, "thumb") : null;
  const waiting = parts.filter((p) => p.status === "pending");
  const noun = parts.length === 1 ? "part" : "parts";
  const price = summary?.line_total != null ? formatStoredMoney(summary.line_total, "amount", { currency: summary.currency }) : null;

  return (
    <section
      data-testid="split-line-group"
      data-parent-id={parentId}
      className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/40"
    >
      {parentCard}
      {summary && (
        <div className="flex items-start gap-3 p-3" data-testid="split-line-parent">
          {!parentCard && (
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface dark:bg-slate-800 flex items-center justify-center">
              {thumb ? <img src={thumb} alt="" className="max-h-14 w-full object-contain" /> : <Scissors size={18} className="text-faint" aria-hidden />}
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {!parentCard && (
              <div className="text-sm font-medium text-content dark:text-mortar-100 break-words" data-testid="split-line-name">
                {summary.name ?? "An order line"}
              </div>
            )}
            <div className="text-xs text-content dark:text-mortar-100" data-testid="split-line-headline">
              {summary.headline}
              {price && <span className="text-muted"> · {price}</span>}
            </div>
            <div className="text-xs text-muted" data-testid="split-line-how">
              {summary.how_words ? `${summary.how_words} · ` : ""}
              <span data-testid="split-line-check">{summary.check}</span>
              {summary.filed > 0 && <span> · {summary.filed} added</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                data-testid="split-line-toggle"
                className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line dark:border-slate-700 px-3 text-xs font-medium text-content dark:text-mortar-100 hover:bg-surface"
              >
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                {open ? `Hide the ${parts.length} ${noun}` : `${parts.length} ${noun}`}
              </button>
              {waiting.length > 1 && (
                <button
                  type="button"
                  disabled={adding}
                  data-testid="split-line-add-all"
                  onClick={async () => {
                    setAdding(true);
                    try {
                      await onAddAll(waiting.map((p) => p.id));
                    } catch (e) {
                      toast.error(e instanceof ApiError ? e.message : String(e));
                    } finally {
                      setAdding(false);
                    }
                  }}
                  className="inline-flex min-h-11 items-center rounded-full bg-cobble-600 hover:bg-cobble-700 px-3 text-xs font-medium text-white disabled:opacity-50"
                >
                  Add all {waiting.length}
                </button>
              )}
              {summary.can_undo && (
                <button
                  type="button"
                  disabled={undo.isPending}
                  data-testid="split-line-undo"
                  onClick={() => undo.mutate()}
                  title="Put the parts back together as the one line they came from"
                  className="inline-flex min-h-11 items-center rounded-full border border-line dark:border-slate-700 px-3 text-xs font-medium text-content dark:text-mortar-100 hover:bg-surface disabled:opacity-50"
                >
                  Undo split
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line dark:border-slate-700 p-2 pl-3 sm:pl-6" data-testid="split-line-parts">
          {parts.map((p) => renderPart(p))}
        </div>
      )}
    </section>
  );
}
