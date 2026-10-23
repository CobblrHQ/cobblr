// "2 suggested edits by Vince" on the record they are about
// (docs/design-decisions/share-spaces.md §10).
//
// Someone you share with changed their copy of this record; each changed
// field waits here: what it said, what they made it, Accept or Reject, and
// Accept all. When you changed the same field since, it says what yours says
// now, and the choice is theirs or yours, never a silent overwrite. Both run
// the kernel's actions (platform:accept-suggestions / reject-suggestions),
// the same the assistant uses, and each offers Undo.

import { useRecordRuns } from "./record-runs";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageSquareDiff } from "lucide-react";
import { countOf } from "@cobblr/platform-contract/plural";
import { usePlatformWeb } from "./context";
import { useRunAction } from "./run-action";
import { useToast } from "./ToastContext";
import type { SuggestedEdit } from "./types";

const shown = (v: string | null) => (v === null || v === "" ? "(empty)" : v);

export function RecordSuggestions({ kind, id, onChanged }: { kind: string; id: string; onChanged?: () => void }) {
  const { api, orgSlug } = usePlatformWeb();
  // PRESS-ARGS: which edits are the only argument, and they are the rows on screen; the record is the page's.
  const runAction = useRunAction();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Accept and Reject only where they run for this viewer (#7922).
  const may = useRecordRuns();
  const accepts = may("platform:accept-suggestions");
  const rejects = may("platform:reject-suggestions");
  const q = useQuery({
    queryKey: ["record-suggestions", orgSlug, kind, id],
    queryFn: () => api.listSuggestions!(orgSlug, { kind, id }),
    enabled: !!api.listSuggestions,
    staleTime: 15_000,
  });
  const items: SuggestedEdit[] = q.data?.items ?? [];
  if (!items.length) return null;
  const who = [...new Set(items.map((e) => e.by_name ?? "someone"))].join(" and ");

  const decide = async (actionId: "platform:accept-suggestions" | "platform:reject-suggestions", ids: string[]) => {
    setBusy(true);
    try {
      const r = await runAction({ actionId, entityKind: kind, entityId: id, args: { ids } }, { undo: "shown-here" });
      const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
      toast.success(res.summary ?? "Done.", {
        actionLabel: "Undo",
        onAction: async () => {
          await runAction({ actionId: "platform:reopen-suggestions", entityKind: kind, entityId: id, args: { ids } }, { undo: "is-undo" });
          await q.refetch();
          onChanged?.();
        },
      });
      await q.refetch();
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 disabled:opacity-50";
  return (
    <div data-testid="record-suggestions" className="order-first w-full basis-full space-y-2 rounded-lg border border-accent/40 bg-subtle px-3 py-2 text-sm text-content dark:border-slate-600">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareDiff size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">
          {countOf(items.length, "suggested edit")} by {who}
        </span>
        {accepts && items.length > 1 && (
          <button type="button" disabled={busy} data-testid="suggestions-accept-all" onClick={() => void decide("platform:accept-suggestions", items.map((e) => e.id))} className={btn}>
            Accept all
          </button>
        )}
      </div>
      <ul className="space-y-1.5">
        {items.map((e) => (
          <li key={e.id} data-testid="record-suggestion" data-status={e.status} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-muted">{e.label}</span>
            {e.status === "conflict" ? (
              <span className="min-w-0 flex-1 break-words">
                was <span className="text-muted">{shown(e.was)}</span>; yours is now <span data-testid="suggestion-yours">{shown(e.yours)}</span>; theirs is <span data-testid="suggestion-now">{shown(e.now)}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 break-words">
                <span className="text-muted line-through">{shown(e.was)}</span> → <span data-testid="suggestion-now">{shown(e.now)}</span>
              </span>
            )}
            {!e.still_shared && <span className="text-xs text-muted">no longer shared</span>}
            <span className="flex gap-1">
              {accepts && <button type="button" disabled={busy} data-testid="suggestion-accept" onClick={() => void decide("platform:accept-suggestions", [e.id])} className={btn}>
                {e.status === "conflict" ? "Take theirs" : "Accept"}
              </button>}
              {rejects && <button type="button" disabled={busy} data-testid="suggestion-reject" onClick={() => void decide("platform:reject-suggestions", [e.id])} className={btn}>
                {e.status === "conflict" ? "Keep yours" : "Reject"}
              </button>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
