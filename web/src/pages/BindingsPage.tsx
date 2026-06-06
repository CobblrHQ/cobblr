// /bindings — manage wires (the user-configurable layer connecting entity kinds
// to actions). The create flow is the no-code WireComposer; below it, the
// existing wires + recent firings.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PlatformBinding } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ChevronRight } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { WireDetailModal } from "../components/WireDetailModal";
import { WireComposer } from "../components/WireComposer";

export function BindingsPage() {
  usePageTitle("Wires");
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<PlatformBinding | null>(null);
  const bindings = useQuery({
    queryKey: ["bindings", slug],
    queryFn: () => api.listBindings(slug),
    enabled: !!slug,
  });

  const toggle = useMutation({
    mutationFn: (b: PlatformBinding) => api.updateBinding(slug, b.id, { enabled: !b.enabled }),
    onSuccess: (_data, b) => {
      toast.info(`Wire ${b.enabled ? "disabled" : "enabled"}.`);
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
    },
  });

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          wires
        </h1>
        <span className="page-subtitle">
          when X happens, do Y. Modules don't know about each other — you wire them here.
        </span>
      </div>

      <WireComposer slug={slug} onCreated={() => {}} />

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
          // existing wires
        </div>
        {bindings.isLoading && <div className="text-xs text-faint">loading…</div>}
        {bindings.data?.items.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic">No wires yet.</div>
        )}
        <ul className="space-y-2">
          {bindings.data?.items.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected(b)}
                className="w-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
              >
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
                  <div className="flex-1" />
                  <label
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      onChange={() => toggle.mutate(b)}
                      className="accent-cobble-500"
                    />
                    enabled
                  </label>
                  <ChevronRight size={14} className="text-faint dark:text-slate-600 group-hover:text-accent transition" />
                </div>
                {b.template && (
                  <div className="mt-2 font-mono text-xs text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                    {b.template}
                  </div>
                )}
                {b.bundle_id && (
                  <div className="mt-1 text-[10px] font-mono text-faint dark:text-slate-500">installed via bundle</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <WireFiringsPanel slug={slug} />

      <WireDetailModal open={!!selected} onClose={() => setSelected(null)} slug={slug} binding={selected} />
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
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// recent wire activity</div>
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
      <ul className="space-y-1.5">
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
                <span className={"text-[10px] font-mono uppercase " + (failed ? "text-ember-500" : "text-moss-600")}>
                  {failed ? "failed" : "fired"}
                </span>
                <span className="font-mono text-[10px] text-faint">{new Date(it.occurred_at).toLocaleString()}</span>
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
