// /bindings — manage wires. The user-configurable layer that
// connects entity kinds to actions, plus the template each binding
// uses when rendering data from the source entity.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type PlatformBinding } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ChevronRight, Plus } from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { WireDetailModal } from "../components/WireDetailModal";

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
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });

  // For the create form: pick a source_kind first, then the actions
  // applicable to it. (Bindings can only be created between
  // declared kinds + actions; that's the platform's safety net.)
  const [sourceKind, setSourceKind] = useState("");
  const actionsForKind = useQuery({
    queryKey: ["actions-for-kind", slug, sourceKind],
    queryFn: () => api.listActions(slug, sourceKind),
    enabled: !!slug && !!sourceKind,
  });

  const [actionId, setActionId] = useState("");
  const [triggerType, setTriggerType] = useState<PlatformBinding["trigger_type"]>("user-invoked");
  const [triggerEvent, setTriggerEvent] = useState("");
  const [template, setTemplate] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createBinding(slug, {
        source_kind: sourceKind,
        action_id: actionId,
        trigger_type: triggerType,
        trigger_event: triggerEvent || null,
        template: template || null,
      }),
    onSuccess: () => {
      toast.success("Wire created.");
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      setSourceKind("");
      setActionId("");
      setTriggerEvent("");
      setTemplate("");
      setCreateErr(null);
    },
    onError: (e: unknown) => {
      setCreateErr(e instanceof ApiError ? e.message : "Couldn't create");
    },
  });

  const toggle = useMutation({
    mutationFn: (b: PlatformBinding) =>
      api.updateBinding(slug, b.id, { enabled: !b.enabled }),
    onSuccess: (_data, b) => {
      toast.info(`Wire ${b.enabled ? "disabled" : "enabled"}.`);
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!sourceKind || !actionId) return;
    create.mutate();
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          wires
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          when X happens, do Y. Modules don't know about each other —
          you wire them here.
        </span>
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // new wire
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Source entity kind
            </span>
            <select
              value={sourceKind}
              onChange={(e) => {
                setSourceKind(e.target.value);
                setActionId("");
              }}
              className="input"
            >
              <option value="">— pick one —</option>
              {kinds.data?.items.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.display_name} ({k.id})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Action
            </span>
            <select
              value={actionId}
              onChange={(e) => setActionId(e.target.value)}
              className="input"
              disabled={!sourceKind}
            >
              <option value="">— pick one —</option>
              {actionsForKind.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.id})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Trigger type
            </span>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value as PlatformBinding["trigger_type"])}
              className="input"
            >
              <option value="user-invoked">user-invoked (button)</option>
              <option value="event">event (fires on named event)</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Trigger event (if type=event)
            </span>
            <input
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              placeholder="e.g. inventory.stock.changed"
              className="input font-mono text-xs"
              disabled={triggerType !== "event"}
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
            Template — {`{{name}} · {{qty}} {{unit}}`} or
            {` {{set_id | default: "??"}}`}
          </span>
          <input
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="optional template"
            className="input font-mono text-xs"
          />
        </label>
        {createErr && (
          <div className="text-xs text-ember-500">{createErr}</div>
        )}
        <button
          type="submit"
          disabled={!sourceKind || !actionId || create.isPending}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
        >
          <Plus size={14} /> Create wire
        </button>
      </form>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
          // existing wires
        </div>
        {bindings.isLoading && <div className="text-xs text-slate-400">loading…</div>}
        {bindings.data?.items.length === 0 && (
          <div className="text-xs text-slate-400 dark:text-slate-500 italic">
            No wires yet.
          </div>
        )}
        <ul className="space-y-2">
          {bindings.data?.items.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected(b)}
                className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-sm hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-xs text-cobble-600 dark:text-cobble-300">
                    {b.source_kind}
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="font-mono text-xs text-cobble-600 dark:text-cobble-300">
                    {b.action_id}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
                    ({b.trigger_type}
                    {b.trigger_event ? ` on ${b.trigger_event}` : ""})
                  </span>
                  <div className="flex-1" />
                  {/* Inline enable toggle — stop propagation so it doesn't open the modal */}
                  <label
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      onChange={() => toggle.mutate(b)}
                      className="accent-cobble-500"
                    />
                    enabled
                  </label>
                  <ChevronRight
                    size={14}
                    className="text-slate-300 dark:text-slate-600 group-hover:text-cobble-500 transition"
                  />
                </div>
                {b.template && (
                  <div className="mt-2 font-mono text-xs text-slate-600 dark:text-mortar-200 bg-mortar-50 dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                    {b.template}
                  </div>
                )}
                {b.bundle_id && (
                  <div className="mt-1 text-[10px] font-mono text-slate-400 dark:text-slate-500">
                    installed via bundle
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <WireFiringsPanel slug={slug} />

      <WireDetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        slug={slug}
        binding={selected}
      />
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
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // recent wire activity
        </div>
        <div className="flex items-center gap-1 text-[10px] font-mono">
          {(["all", "failed"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                "px-1.5 py-0.5 rounded transition " +
                (filter === f
                  ? "bg-cobble-100 text-cobble-700 dark:bg-cobble-700 dark:text-mortar-100"
                  : "text-slate-400 hover:text-cobble-600")
              }
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 && (
        <div className="text-xs text-slate-400 dark:text-slate-500 italic">
          {filter === "failed"
            ? "No failures recorded."
            : "No wire firings yet."}
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
                  : "border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700")
              }
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={
                    "text-[10px] font-mono uppercase " +
                    (failed ? "text-ember-500" : "text-moss-600")
                  }
                >
                  {failed ? "failed" : "fired"}
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  {new Date(it.occurred_at).toLocaleString()}
                </span>
                <span className="font-mono text-[10px] text-cobble-600">
                  {d.event ?? "?"}
                </span>
                <span className="text-slate-400">→</span>
                <span className="font-mono text-[10px] text-cobble-600">
                  {d.action ?? "?"}
                </span>
              </div>
              {d.error && (
                <div className="font-mono text-[10px] text-ember-600 dark:text-ember-300 mt-1 break-all">
                  {d.error}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
