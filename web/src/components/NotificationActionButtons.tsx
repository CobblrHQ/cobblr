// The buttons a notification says it has.
//
// One component, because there are two inboxes — the bell and the full
// notifications page — and they had already drifted once over the card body.
// What a button DOES is never decided here: the notification declares its
// actions at dispatch and each press runs a platform action, so a module makes
// its notification answerable without touching any UI.
//
// This is the app's half of a seam Discord has had for a long time. Dispatch
// wrote `actions`, the Discord card rendered them, and Cobblr's own inbox
// showed a sentence — so the one place a notification could not be acted on
// was the app it came from (audit, 2026-09-06).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CrossOrgNotificationEntry } from "../lib/api";

const STYLES = {
  primary:
    "rounded border border-cobble-500 bg-cobble-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cobble-700 disabled:opacity-50",
  danger:
    "rounded border border-ember-500 px-2.5 py-1 text-[11px] font-medium text-ember-500 hover:bg-ember-500/10 disabled:opacity-50",
  secondary:
    "rounded border border-line dark:border-slate-600 px-2.5 py-1 text-[11px] font-medium text-muted hover:text-content disabled:opacity-50",
} as const;

export function NotificationActionButtons({ n }: { n: CrossOrgNotificationEntry }) {
  const qc = useQueryClient();
  /** What it did, in the words the notification chose. Replacing the buttons is
   *  the point: a question that has been answered stops asking. */
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: (actionId: string) => api.pressNotificationAction(n.id, actionId),
    onSuccess: (r) => {
      setError(null);
      setDone(r.label);
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  if (!n.actions || n.actions.length === 0) return null;
  if (done) return <div className="mt-2 text-[11px] text-muted dark:text-slate-400">{done}</div>;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {n.actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={press.isPending}
          onClick={(e) => {
            // Both inboxes navigate on a row click; a button is a different
            // instruction and must not also move you.
            e.stopPropagation();
            press.mutate(a.id);
          }}
          className={STYLES[a.style ?? "secondary"]}
        >
          {a.label}
        </button>
      ))}
      {error && <span className="text-[11px] text-ember-500">{error}</span>}
    </div>
  );
}
