// Suggested edits: every edit someone you share with suggested on your
// records, waiting for you (docs/design-decisions/share-spaces.md §10).
//
// Grouped by record, filtered by person, with Accept all for a record, for a
// person, or for everything shown. A conflict (you changed the field too)
// shows both values and asks which stays. Every button runs the kernel's
// actions (platform:accept-suggestions / reject-suggestions), the same the
// record's own bar and the assistant use, and each offers Undo.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { countOf } from "@cobblr/platform-contract/plural";
import { relativeTime, usePageTitle, useRunAction, useToast } from "@cobblr/platform-web";
import { api, type ShareEditItem } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const shown = (v: string | null) => (v === null || v === "" ? "(empty)" : v);

export function SuggestionsPage() {
  usePageTitle("Suggested edits");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  // PRESS-ARGS: the edits are the rows on screen; nothing else is asked.
  const runAction = useRunAction();
  const toast = useToast();
  const [who, setWho] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = ["suggestions", activeSlug];
  const list = useQuery({ queryKey: key, queryFn: () => api.listSuggestions(activeSlug), enabled: !!activeSlug });
  const all = list.data?.items ?? [];
  const added = list.data?.additions ?? [];
  const people = useMemo(() => [...new Set(all.map((e) => e.by_name ?? "Someone"))], [all]);
  const items = who ? all.filter((e) => (e.by_name ?? "Someone") === who) : all;
  const groups = useMemo(() => {
    const m = new Map<string, { kind: string; id: string; title: string; edits: ShareEditItem[] }>();
    for (const e of items) {
      const k = `${e.entity_kind}/${e.entity_id}`;
      if (!m.has(k)) m.set(k, { kind: e.entity_kind, id: e.entity_id, title: e.title ?? "A record", edits: [] });
      m.get(k)!.edits.push(e);
    }
    return [...m.values()];
  }, [items]);

  const decide = async (actionId: "platform:accept-suggestions" | "platform:reject-suggestions", ids: string[]) => {
    // A workspace action; the door is told the first record it is about.
    const first = all.find((e) => e.id === ids[0]);
    const on = { entityKind: first?.entity_kind ?? "", entityId: first?.entity_id ?? "" };
    setBusy(true);
    try {
      const r = await runAction({ actionId, ...on, args: { ids } });
      const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
      toast.success(res.summary ?? "Done.", {
        actionLabel: "Undo",
        onAction: async () => {
          await runAction({ actionId: "platform:reopen-suggestions", ...on, args: { ids } });
          await qc.invalidateQueries({ queryKey: key });
        },
      });
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addition = async (actionId: "platform:take-additions" | "platform:leave-additions", id: string, kind: string) => {
    setBusy(true);
    try {
      const r = await runAction({ actionId, entityKind: kind, entityId: id, args: { ids: [id] } });
      const res = r.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
      toast.success(res.summary ?? "Done.");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent dark:border-slate-600 disabled:opacity-50";
  if (list.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="suggestions-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold text-content">Suggested edits</h1>
        {items.length > 1 && (
          <button type="button" disabled={busy} data-testid="suggestions-accept-shown" onClick={() => void decide("platform:accept-suggestions", items.map((e) => e.id))} className="rounded bg-cobble-600 px-3 py-1.5 text-sm text-white disabled:opacity-60">
            Accept all {countOf(items.length, "edit")}
          </button>
        )}
      </div>
      {people.length > 1 && (
        <div className="flex flex-wrap gap-2" data-testid="suggestions-people">
          {[null, ...people].map((p) => (
            <button key={p ?? "all"} type="button" onClick={() => setWho(p)} className={`rounded-full border px-3 py-1 text-xs ${who === p ? "border-accent text-accent" : "border-line text-muted dark:border-slate-600"}`}>
              {p ?? "Everyone"}
            </button>
          ))}
        </div>
      )}
      {added.length > 0 && (
        <section className="space-y-2" data-testid="share-additions">
          <h2 className="text-sm font-semibold text-content">Added to the share</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface dark:divide-slate-700 dark:border-slate-600">
            {added.map((a) => (
              <li key={a.id} data-testid="share-addition" className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 text-content">{a.title}</span>
                <span className="text-xs text-muted">
                  added by {a.by_name ?? "someone"} · {relativeTime(a.created_at)}
                </span>
                <button type="button" disabled={busy} data-testid="share-addition-take" onClick={() => void addition("platform:take-additions", a.id, a.entity_kind)} className={btn}>
                  Take
                </button>
                <button type="button" disabled={busy} data-testid="share-addition-leave" onClick={() => void addition("platform:leave-additions", a.id, a.entity_kind)} className={btn}>
                  Leave
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.length === 0 && added.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted dark:border-slate-600">
          Nothing waiting. When someone you share with changes a thing of yours, it shows here. Manage who you share with in{" "}
          <Link to="/configuration/sharing" className="text-accent hover:underline">
            Sharing
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={`${g.kind}/${g.id}`} data-testid="suggestions-record" className="space-y-2 rounded-lg border border-line bg-surface p-3 dark:border-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={openRecordPath(g.kind, g.id)} className="mr-auto font-medium text-content hover:text-accent">
                  {g.title}
                </Link>
                {g.edits.length > 1 && (
                  <button type="button" disabled={busy} onClick={() => void decide("platform:accept-suggestions", g.edits.map((e) => e.id))} className={btn}>
                    Accept all
                  </button>
                )}
              </div>
              <ul className="space-y-1.5 text-sm">
                {g.edits.map((e) => (
                  <li key={e.id} data-testid="suggestion-row" data-status={e.status} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted">{e.label}</span>
                    {e.status === "conflict" ? (
                      <span className="min-w-0 flex-1 break-words">
                        was <span className="text-muted">{shown(e.was)}</span>; yours is now {shown(e.yours)}; {e.by_name ?? "theirs"} made it {shown(e.now)}
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 break-words">
                        <span className="text-muted line-through">{shown(e.was)}</span> → {shown(e.now)}
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {e.by_name ?? "Someone"} · {relativeTime(e.created_at)}
                      {e.still_shared ? "" : " · no longer shared"}
                    </span>
                    <span className="flex gap-1">
                      <button type="button" disabled={busy} data-testid="suggestion-accept" onClick={() => void decide("platform:accept-suggestions", [e.id])} className={btn}>
                        {e.status === "conflict" ? "Take theirs" : "Accept"}
                      </button>
                      <button type="button" disabled={busy} data-testid="suggestion-reject" onClick={() => void decide("platform:reject-suggestions", [e.id])} className={btn}>
                        {e.status === "conflict" ? "Keep yours" : "Reject"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
