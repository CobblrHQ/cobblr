import { useState } from "react";
import { useToast } from "@cobblr/platform-web";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type Entry = { id: string; title: string; body?: string; tip?: string };

/** The pages the owner pinned for a new member, read on Home itself. Opening one, or putting it away, ends it on every device. */
export function ReadFirstCard({ slug, entries }: { slug: string; entries: Entry[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  // Opened or dismissed, the page is put away on the account: it does not come back on any device.
  // Opening keeps it on screen (the feed refreshing must not take the text away mid-read); dismissing removes it.
  const putAway = (e: Entry, remove: boolean) => {
    if (!e.tip) return;
    if (remove) setGone((g) => new Set(g).add(e.id));
    api.tipDismissed(e.tip).then(() => (remove ? qc.invalidateQueries({ queryKey: ["attention", slug] }) : undefined)).catch((err: unknown) => toast.error(`That could not be put away: ${err instanceof Error ? err.message : String(err)}`));
  };
  const shown = entries.filter((e) => !gone.has(e.id));
  if (!shown.length) return null;
  return (
    <li data-testid="read-first-card" className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 p-3 space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">Read first</p>
      <ul className="space-y-2">
        {shown.map((e) => (
          <li key={e.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-expanded={open === e.id}
                onClick={() => {
                  const opening = open !== e.id;
                  setOpen(opening ? e.id : null);
                  if (opening) putAway(e, false);
                }}
                className="font-medium underline text-left"
              >
                {e.title}
              </button>
              <button type="button" onClick={() => putAway(e, true)} className="text-xs text-faint dark:text-slate-400 underline">Dismiss</button>
            </div>
            {open === e.id && <p className="mt-1 whitespace-pre-wrap break-words text-content dark:text-mortar-100">{e.body}</p>}
          </li>
        ))}
      </ul>
    </li>
  );
}
