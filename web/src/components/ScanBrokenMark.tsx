// The Broken mark on a scan of a thing you already have (#6889): scan the
// drill, tap Broken, say what is wrong if you like, and the drill gets a
// repair entry in its service log instead of a second drill. Shown only when
// the scan matched one thing by its code (scanBrokenTarget, the rule the
// route also holds), on the inbox card and the camera's sheet alike. Undo
// takes the entry back off and returns the scan to the inbox.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { scanBrokenTarget } from "@cobblr/platform-contract/scan-triage";
import { api, ApiError, type ScanInboxItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

export function ScanBrokenMark({ item, onMarked }: { item: ScanInboxItem; onMarked?: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const target = scanBrokenTarget(item);
  const refresh = () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
  const mark = useMutation({
    mutationFn: () => api.markScanBroken(activeSlug, item.id, note.trim() || null),
    onSuccess: (r) => {
      setOpen(false);
      refresh();
      onMarked?.();
      toast.success(`${r.record.title} needs repair: it is in its service log.`, {
        actionLabel: "Undo",
        onAction: async () => {
          const back = await api.unconfirmScanItem(activeSlug, item.id).catch((e: unknown) => {
            toast.error(e instanceof ApiError ? e.message : String(e));
            return null;
          });
          refresh();
          if (back) toast.success(back.note ?? `Not broken after all: ${r.record.title}'s repair entry is off.`);
        },
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!target) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="scan-broken"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={`${target.title} is broken: open a repair entry in its service log instead of filing another one`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-muted hover:border-amber-400 hover:text-content dark:border-slate-700 dark:hover:border-amber-700"
      >
        <Wrench size={13} aria-hidden /> Broken
      </button>
    );
  }
  return (
    <form
      data-testid="scan-broken-form"
      className="flex w-full flex-wrap items-center gap-2"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        mark.mutate();
      }}
    >
      <label className="min-w-0 flex-1 basis-48">
        <span className="sr-only">What is wrong with {target.title}</span>
        <input
          autoFocus
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`What is wrong with ${target.title}? (optional)`}
          className="min-h-11 w-full rounded-md border border-line bg-surface px-2 text-sm text-content dark:border-slate-700 dark:bg-slate-900 dark:text-mortar-100"
        />
      </label>
      <button
        type="submit"
        disabled={mark.isPending}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-amber-600 px-3 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
      >
        <Wrench size={14} aria-hidden /> {mark.isPending ? "Opening…" : "Needs repair"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="min-h-11 px-2 text-sm text-muted hover:text-content">
        Cancel
      </button>
    </form>
  );
}
