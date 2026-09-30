// A record's history, as a contributed panel on every record: who changed it,
// how, and when, read from the activity log the record's module already
// writes. The Activity page could say what happened across the workspace but
// no record could say what happened to it.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
import { relativeTime } from "@cobblr/platform-web";
import { api } from "../../lib/api";
import { activityVerb, updatedFieldsWords } from "../../lib/activity-words";
import { ActorVia, ACTIVITY_ROW, ACTOR_CELL } from "../../components/ActorVia";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { FEED_SCROLL } from "../../lib/feed";
import type { EntityDetailPanelCtx } from "../../panels/types";

const FIRST = 10;

export function HistoryPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const { activeSlug } = useActiveOrg();
  const [limit, setLimit] = useState(FIRST);
  const q = useQuery({
    queryKey: ["record-history", activeSlug, ctx.kind, ctx.entityId, limit],
    queryFn: () => api.listActivity(activeSlug, { entity: { kind: ctx.kind ?? "", id: ctx.entityId }, limit: limit + 1 }),
    enabled: !!activeSlug && !!ctx.kind && !!ctx.entityId,
  });
  const items = (q.data?.items ?? []).slice(0, limit);
  const more = (q.data?.items.length ?? 0) > limit;
  return (
    <div data-testid="record-history" className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
        <History size={12} aria-hidden /> {"// history"}
      </div>
      {q.isLoading ? (
        <Loader2 size={14} className="animate-spin text-faint" />
      ) : q.isError ? (
        <p className="text-sm text-ember-600 dark:text-ember-400">Could not read this record's history: {(q.error as Error).message}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400">Nothing recorded yet. Changes to this record will show here.</p>
      ) : (
        <ul className={"space-y-1.5 " + FEED_SCROLL}>
          {items.map((e) => {
            const fields = e.action.endsWith("updated") ? updatedFieldsWords(e.diff) : null;
            return (
              <li key={e.id} className={`text-sm ${ACTIVITY_ROW}`}>
                <span className={`text-muted dark:text-slate-400 ${ACTOR_CELL}`}>
                  <ActorVia entry={e} />
                </span>
                <span className="text-content dark:text-mortar-200">{activityVerb(e.action)}</span>
                {fields ? <span className="text-muted dark:text-slate-400 truncate min-w-0">{fields}</span> : null}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-faint" title={new Date(e.occurred_at).toLocaleString()}>
                  {relativeTime(e.occurred_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {more ? (
        <button type="button" onClick={() => setLimit((n) => n + 20)} className="text-xs text-accent hover:underline">
          Show earlier
        </button>
      ) : null}
    </div>
  );
}
