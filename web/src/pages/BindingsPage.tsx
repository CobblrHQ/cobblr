// /bindings — manage wires (the user-configurable layer connecting entity kinds
// to actions). The create flow is the no-code WireComposer; below it, the
// existing wires + recent firings.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { wirePrefillFromParams } from "../lib/wire-composer";
import { usePrefill } from "../lib/prefill";
import { wireSentence } from "../lib/wireSentence";
import { STOCK_CHANGED_EVENT, readStockChange, readWireRecords, stockChangePhrase, type NarrowingCondition } from "@cobblr/platform-contract/wire-narrowing";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PlatformBinding } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ChevronRight } from "lucide-react";
import { Modal, useStillAsking, useToast, usePageTitle } from "@cobblr/platform-web";
import { WireDetailModal } from "../components/WireDetailModal";
import { FEED_SCROLL } from "../lib/feed";
import { WireComposer } from "../components/WireComposer";
import { WireGraph } from "../components/WireGraph";
import { ErrorBoundary } from "../components/ErrorBoundary";

const WIRE_PREFILL_KEYS = ["kind", "event", "change", "below", "record", "record_name", "category", "tag", "view"];

export function BindingsPage() {
  usePageTitle("Wires");
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<PlatformBinding | null>(null);
  const [editing, setEditing] = useState<PlatformBinding | null>(null);
  const [view, setView] = useState<"list" | "graph">("list");
  const [search, setSearch] = useSearchParams();
  // The record's "When this runs out…" link puts the narrowing in the address;
  // the assistant's escort sends the same keys as prefill.* (lib/prefill.ts).
  const escorted = usePrefill(WIRE_PREFILL_KEYS);
  const prefill = wirePrefillFromParams(Object.keys(escorted).length ? new URLSearchParams(escorted) : search);
  const bindings = useQuery({
    queryKey: ["bindings", slug],
    queryFn: () => api.listBindings(slug),
    enabled: !!slug,
  });
  // Resolve bundle ids → names so each row can say which bundle it came
  // from (the binding only carries the bundle's internal id).
  const bundles = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
  });
  const bundleName = new Map((bundles.data?.items ?? []).map((b) => [b.id, b.name]));
  // The composer above waits for the readable tables and their events; the
  // page waits with it, so the list under it is not pushed when it draws.
  const composerKinds = useQuery({ queryKey: ["entity-kinds-readable", slug], queryFn: () => api.listEntityKindsReadable(slug), enabled: !!slug });
  const composerEvents = useQuery({ queryKey: ["wire-events", slug], queryFn: () => api.listWireEvents(slug), enabled: !!slug });
  const asking = useStillAsking(bindings, bundles, composerKinds, composerEvents);

  const toggle = useMutation({
    mutationFn: (b: PlatformBinding) => api.updateBinding(slug, b.id, { enabled: !b.enabled }),
    onSuccess: (_data, b) => {
      toast.info(`Wire ${b.enabled ? "disabled" : "enabled"}.`);
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
    },
    onError: (e: unknown) => toast.error(`Couldn't switch that wire: ${e instanceof Error ? e.message : String(e)}`),
  });

  return (
    <div className="space-y-5">
      {/* A wire started elsewhere ("When this runs out…", the assistant's
          escort) arrives with its trigger and narrowing in the address. */}
      <WireComposer
        key={`${search.toString()}|${Object.values(escorted).join("|")}`}
        slug={slug}
        prefill={prefill ? { sourceKind: prefill.kind, triggerEvent: prefill.event, change: prefill.change, records: prefill.records, recordLabel: prefill.recordName } : null}
        onCreated={() => {
          if (prefill) setSearch(new URLSearchParams(), { replace: true });
        }}
      />

      {/* The wires and what they fired draw once the wires are known: drawn
          first, the list arrived above the firings' all / failed and moved
          them 2,200 px under a finger (#7788). */}
      {asking ? <div className="text-xs text-faint">loading…</div> : <>
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="text-[10px] uppercase tracking-widest text-accent">existing wires</div>
          <div className="flex items-center gap-0.5 text-[10px] font-mono">
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={
                  "px-1.5 py-0.5 rounded transition " +
                  (view === v
                    ? "bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100"
                    : "text-faint hover:text-accent")
                }
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        {bindings.data?.items.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic">No wires yet.</div>
        )}
        {view === "graph" && bindings.data && (
          <ErrorBoundary scope="graph">
            <WireGraph bindings={bindings.data.items} onSelect={(b) => setSelected(b)} />
          </ErrorBoundary>
        )}
        <ul className={"space-y-2 " + (view === "graph" ? "hidden" : "")}>
          {bindings.data?.items.map((b) => {
            const said = wireSentence(b);
            return (
            // The row opens the wire and its switch turns it on or off: two
            // controls side by side, never one inside the other (#7514).
            <li key={b.id} className="flex items-start rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700 transition group">
              <button
                type="button"
                onClick={() => setSelected(b)}
                className="flex-1 min-w-0 text-left p-4 text-sm rounded-xl"
              >
                {said.headline && (
                  <div className="mb-1">
                    <div className="text-sm text-content dark:text-mortar-100" data-testid="wire-said">{said.headline}</div>
                    {said.given && <div className="text-xs text-muted dark:text-slate-400" data-testid="wire-given">{said.given}</div>}
                  </div>
                )}
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-xs text-accent dark:text-cobble-300">{b.source_kind}</span>
                  <span className="text-faint">→</span>
                  <span className="font-mono text-xs text-accent dark:text-cobble-300">{b.action_id}</span>
                  <span className="text-[10px] font-mono text-faint dark:text-slate-500">
                    ({b.trigger_type}
                    {b.trigger_event ? ` on ${b.trigger_event}` : ""}
                    {b.trigger_schedule ? ` · ${b.trigger_schedule}` : ""})
                  </span>
                  {b.target && b.target !== "self" && (
                    <span className="text-[10px] font-mono text-faint dark:text-slate-500">→ linked</span>
                  )}
                  {narrowingLine(b) && (
                    <span className="text-[11px] text-muted dark:text-slate-400" data-testid="wire-narrowing">{narrowingLine(b)}</span>
                  )}
                  <div className="flex-1" />
                  <ChevronRight size={14} className="text-faint dark:text-slate-600 group-hover:text-accent transition" />
                </div>
                {b.never_runs && (
                  <p className="mt-1 text-xs text-ember-700 dark:text-ember-300" data-testid="wire-never-runs">
                    This wire never runs. {b.never_runs}
                  </p>
                )}
                {b.trigger_silent && (
                  <div className="mt-2 text-xs text-ember-600 dark:text-ember-400">
                    Nothing sends {b.trigger_event} any more, so this wire never runs. Open it and pick another trigger.
                  </div>
                )}
                {b.template && (
                  <div className="mt-2 font-mono text-xs text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                    {b.template}
                  </div>
                )}
                {b.bundle_id && (
                  <div className="mt-1 text-[10px] font-mono text-faint dark:text-slate-500">
                    installed via {bundleName.get(b.bundle_id) ?? "bundle"}
                  </div>
                )}
              </button>
              <label className="shrink-0 flex items-center gap-1 min-h-11 mt-2 mr-2 px-2 text-[10px] uppercase tracking-widest text-muted dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={b.enabled}
                  onChange={() => toggle.mutate(b)}
                  aria-label={`Enabled: ${said.headline || b.action_id}`}
                  className="accent-cobble-500"
                />
                enabled
              </label>
            </li>
            );
          })}
        </ul>
      </div>

      <WireFiringsPanel slug={slug} />
      </>}

      <WireDetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        slug={slug}
        binding={selected}
        onEdit={(b) => setEditing(b)}
      />

      {/* Full-edit composer (re-point source/action/trigger/args). key forces a
          fresh prefill per wire. */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="edit wire" size="lg">
        {editing && (
          <WireComposer
            key={editing.id}
            slug={slug}
            editing={editing}
            onCancel={() => setEditing(null)}
            onCreated={() => void qc.invalidateQueries({ queryKey: ["bindings", slug] })}
          />
        )}
      </Modal>
    </div>
  );
}

function WireFiringsPanel({ slug }: { slug: string }) {
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const actions = filter === "failed" ? ["wire_failed"] : ["wire_fired", "wire_failed"];
  const log = useQuery({
    queryKey: ["wire-firings", slug, filter],
    queryFn: () => api.listActivity(slug, { actions, limit: 30 }),
    enabled: !!slug,
    refetchInterval: 10_000,
  });
  const items = log.data?.items ?? [];
  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="text-[10px] uppercase tracking-widest text-accent">recent wire activity</div>
        <div className="flex items-center gap-1 text-[10px] font-mono">
          {(["all", "failed"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                "px-1.5 py-0.5 rounded transition " +
                (filter === f
                  ? "bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100"
                  : "text-faint hover:text-accent")
              }
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          {filter === "failed" ? "No failures recorded." : "No wire firings yet."}
        </div>
      )}
      <ul className={"space-y-1.5 " + FEED_SCROLL}>
        {items.map((it) => {
          const failed = it.action === "wire_failed";
          const d = (it.diff ?? {}) as {
            event?: string;
            action?: string;
            error?: string;
            source_kind?: string;
            source_id?: string;
          };
          return (
            <li
              key={it.id}
              className={
                "rounded-md border p-2 text-xs " +
                (failed
                  ? "border-ember-200/60 bg-ember-50/60 dark:bg-slate-900 dark:border-ember-700/40"
                  : "border-line bg-surface dark:bg-slate-900 dark:border-slate-700")
              }
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={"text-[10px] uppercase " + (failed ? "text-ember-500" : "text-moss-600")}>
                  {failed ? "failed" : "fired"}
                </span>
                <span className="tabular-nums text-[10px] text-faint">{new Date(it.occurred_at).toLocaleString()}</span>
                <span className="font-mono text-[10px] text-accent">{d.event ?? "?"}</span>
                <span className="text-faint">→</span>
                <span className="font-mono text-[10px] text-accent">{d.action ?? "?"}</span>
              </div>
              {d.error && (
                <div className="font-mono text-[10px] text-ember-600 dark:text-ember-300 mt-1 break-all">{d.error}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What a wire is narrowed to, in words, for its row (#6070): "when it runs
 *  out, one record" or "tagged “coffee”". Null when it is not narrowed. */
function narrowingLine(b: PlatformBinding): string | null {
  const f = b.filter as { all?: NarrowingCondition[]; in?: unknown } | null;
  const parts: string[] = [];
  if (b.trigger_event === STOCK_CHANGED_EVENT) {
    const phrase = stockChangePhrase(readStockChange(f?.all ?? []).change);
    if (phrase) parts.push(`when it ${phrase}`);
  }
  const r = readWireRecords(f?.in);
  // A wire on one record names it in its sentence above (wireSentence).
  if (r?.record && b.said?.record) return null;
  if (r?.record) parts.push("one record");
  if (r?.category) parts.push(`in “${r.category}”`);
  if (r?.tag) parts.push(`tagged “${r.tag}”`);
  if (r?.view) parts.push("those a saved view shows");
  return parts.length ? parts.join(", ") : null;
}
