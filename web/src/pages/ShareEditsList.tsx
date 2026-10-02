// A share's edits from the other person (docs/design-decisions/share-spaces.md
// §8): what waits for a decision first (Accept, Reject), then what was
// applied (Undo). Each says the record, the field by its label and the value
// before and after; a conflict also says what the record says here now.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { relativeTime, useToast } from "@cobblr/platform-web";
import { api, type ShareEditItem } from "../lib/api";

const STATUS_WORDS: Record<ShareEditItem["status"], string> = {
  pending: "waiting for you",
  conflict: "you changed it too",
  applied: "applied",
  undone: "undone",
  accepted: "accepted",
  rejected: "rejected",
};

const shown = (v: string | null) => (v === null || v === "" ? "(empty)" : v);

export function ShareEditsList({ slug, linkId, who }: { slug: string; linkId: string; who: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["share-edits", slug, linkId];
  const list = useQuery({ queryKey: key, queryFn: () => api.listShareEdits(slug, linkId) });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "accept" | "reject" | "undo" }) => api.decideShareEdit(slug, linkId, id, decision),
    onSuccess: (r) => {
      toast.success(r.status === "undone" ? "Undone." : r.status === "accepted" ? "Accepted." : "Rejected.");
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["share-links", slug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const items = list.data?.items ?? [];
  if (list.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-muted">{who} has not changed anything yet. What they change in their copies shows here.</p>;
  const btn = "rounded border border-line px-2 py-1 text-xs text-muted hover:text-accent hover:border-accent dark:border-slate-600 disabled:opacity-50";
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface dark:divide-slate-700 dark:border-slate-600" data-testid="share-edits">
      {items.map((e) => {
        const open = e.status === "pending" || e.status === "conflict";
        return (
          <li key={e.id} className="space-y-1 px-3 py-2 text-sm" data-testid="share-edit" data-status={e.status}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-content">{e.title ?? "A record"}</span>
              <span className="text-muted">{e.label}</span>
              <span className="ml-auto text-xs text-muted">
                {STATUS_WORDS[e.status]} · {relativeTime(e.created_at)}
              </span>
            </div>
            <p className="break-words text-content">
              <span className="text-muted line-through">{shown(e.was)}</span> → <span data-testid="share-edit-now">{shown(e.now)}</span>
            </p>
            {e.status === "conflict" && <p className="text-xs text-ember-600 dark:text-ember-400">Yours now says {shown(e.yours)}. Accept puts {who}'s in its place.</p>}
            {(open || e.status === "applied") && (
              <div className="flex flex-wrap gap-2 pt-1">
                {open && (
                  <>
                    <button type="button" data-testid="share-edit-accept" disabled={decide.isPending} onClick={() => decide.mutate({ id: e.id, decision: "accept" })} className={btn}>
                      Accept
                    </button>
                    <button type="button" data-testid="share-edit-reject" disabled={decide.isPending} onClick={() => decide.mutate({ id: e.id, decision: "reject" })} className={btn}>
                      Reject
                    </button>
                  </>
                )}
                {e.status === "applied" && (
                  <button type="button" data-testid="share-edit-undo" disabled={decide.isPending} onClick={() => decide.mutate({ id: e.id, decision: "undo" })} className={btn}>
                    Undo
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
