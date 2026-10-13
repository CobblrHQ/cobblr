// What a sync section does when the source and Cobblr disagree, and what it
// is asking the person about (#6336). The rule is set per section: Cobblr wins
// (the default, and never writes over what you changed), the source wins, or
// ask me. Under "ask me", and whenever a source record could be more than one
// record already here, the run lists the question and keeps Cobblr's version
// until the person answers; the answers are here.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { CONFLICT_POLICIES, CONFLICT_POLICY_LABELS } from "@cobblr/platform-contract/sync-merge";
import { ApiError, api, type SyncConflictPolicy, type SyncStateRow } from "../lib/api";

const shown = (v: unknown): string => (v === null || v === undefined || v === "" ? "empty" : typeof v === "object" ? JSON.stringify(v) : String(v));

const RULE_WORDS: Record<SyncConflictPolicy, string> = {
  cobblr: "A field you changed here is never written over. The source's other changes still come across.",
  source: "The source's value is written over a field you changed here.",
  ask: "A field you changed here is kept, and listed under the section until you say which to use.",
};

export function SyncRuleSelect({ slug, connId, entityType, value }: { slug: string; connId: string; entityType: string; value: SyncConflictPolicy }) {
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (policy: SyncConflictPolicy) => api.setSyncPolicy(slug, connId, entityType, policy),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-connection", slug, connId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <label className="flex items-center gap-1 text-[10px] text-faint dark:text-slate-500 shrink-0" title={RULE_WORDS[value]}>
      If they differ
      <select
        aria-label={`If Cobblr and the source differ in ${entityType}`}
        data-testid={`sync-rule-${entityType}`}
        value={value}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.value as SyncConflictPolicy)}
        className="rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-1 py-0.5 text-[10px] text-content dark:text-mortar-100"
      >
        {CONFLICT_POLICIES.map((p) => (
          <option key={p} value={p}>
            {CONFLICT_POLICY_LABELS[p]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SyncAsks({ slug, connId, entityType, state }: { slug: string; connId: string; entityType: string; state: SyncStateRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  const answer = useMutation({
    mutationFn: (body: Parameters<typeof api.resolveSyncAsked>[3]) => api.resolveSyncAsked(slug, connId, entityType, body),
    onSuccess: () => {
      toast.success("Done");
      void qc.invalidateQueries({ queryKey: ["sync-connection", slug, connId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const conflicts = state.last_conflicts?.conflicts ?? [];
  const ambiguous = state.last_conflicts?.ambiguous ?? [];
  if (!conflicts.length && !ambiguous.length) return null;
  const btn = "rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50";
  return (
    <div data-testid="sync-asks" className="ml-5 mt-1 space-y-1 border-l border-line dark:border-slate-700 pl-2">
      {ambiguous.map((a) => (
        <div key={a.external_id} className="flex flex-wrap items-center gap-1 text-[11px] text-content dark:text-mortar-100">
          <span>
            <strong>{a.record}</strong> could be a record you already have:
          </span>
          {a.candidates.map((c) => (
            <button key={c.id} type="button" disabled={answer.isPending} onClick={() => answer.mutate({ external_id: a.external_id, action: "link", cobblr_id: c.id })} className={btn}>
              Same as {c.name}
            </button>
          ))}
          <button type="button" disabled={answer.isPending} onClick={() => answer.mutate({ external_id: a.external_id, action: "create" })} className={btn}>
            It is new
          </button>
        </div>
      ))}
      {conflicts.map((c) => (
        <div key={`${c.external_id}:${c.field}`} className="flex flex-wrap items-center gap-1 text-[11px] text-content dark:text-mortar-100">
          <span>
            <strong>{c.record}</strong>: {c.field.replace(/^metadata\./, "")} is {shown(c.cobblr)} here and {shown(c.source)} at the source.
          </span>
          <button type="button" disabled={answer.isPending} onClick={() => answer.mutate({ external_id: c.external_id, action: "keep", field: c.field })} className={btn}>
            Keep mine
          </button>
          <button type="button" disabled={answer.isPending} onClick={() => answer.mutate({ external_id: c.external_id, action: "take", field: c.field })} className={btn}>
            Use the source's
          </button>
        </div>
      ))}
    </div>
  );
}
