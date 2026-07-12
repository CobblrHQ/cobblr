// Browse-to-label — the "find things to put a label on" half of the
// Labels page. Tabs == the labelable, non-empty INSTANCES this workspace
// actually has ("3D Printers", "Laser Cutters", "Parts" — what the navbar
// shows), resolved server-side (no hardcoded list, no generic base kinds
// the user doesn't use). Each tab lists its rows with a one-tap Add, so a
// workshop can come HERE and build a label run, not only push into the
// queue from other modules.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Search, X } from "lucide-react";
import { EntityThumb, buildLocationForest, flattenLocationForest } from "@cobblr/platform-web";
import { useLabels } from "./context";
import type { LabelableItem } from "./api";

export function BrowsePanel() {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();

  const tabsQ = useQuery({
    queryKey: ["labels-browse-tabs", orgSlug],
    queryFn: () => api.listLabelableTabs(),
    enabled: !!orgSlug,
  });
  const tabs = tabsQ.data?.tabs ?? [];

  const [active, setActive] = useState<string | null>(null);
  // Default to the first tab once they load (no useEffect — derive it).
  const activeTab = active ?? tabs[0]?.id ?? null;

  const [q, setQ] = useState("");

  const itemsQ = useQuery({
    queryKey: ["labels-browse-items", orgSlug, activeTab, q],
    // 200 (the endpoint cap) so a full location tree loads in one shot rather
    // than truncating mid-hierarchy.
    queryFn: () => api.listLabelableItems(activeTab!, { q: q.trim() || undefined, limit: 200 }),
    enabled: !!orgSlug && !!activeTab,
  });

  // The shared queue, so a row can show "Added" and we can flip it.
  const queueQ = useQuery({
    queryKey: ["labels-queue", orgSlug],
    queryFn: () => api.listQueue(),
    enabled: !!orgSlug,
  });
  // Map "{kind}:{id}" → the queue item's id, so an "Added" row can REMOVE the
  // exact queue entry (not just show a checkmark). One entry per entity; qty is
  // managed by the stepper in the queue list, so browse is purely in/out.
  const queuedIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of queueQ.data?.items ?? []) {
      m.set(`${it.module_name}:${it.entity_type}:${it.entity_id}`, it.id);
    }
    return m;
  }, [queueQ.data]);

  const add = useMutation({
    // Mint a QR token + queue the full scan URL, so browse-printed labels
    // encode `<base>/qr/<token>` like every other print path. Setting a bare
    // `/entities/<kind>/<id>` here was the bug that made these labels
    // unscannable and ignored the workspace's custom label base URL.
    mutationFn: (it: LabelableItem) =>
      api.queueLabelForEntity({ entity_kind: it.kind, entity_id: it.id, description: it.title }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["labels-queue"] }),
  });

  const remove = useMutation({
    mutationFn: (queueItemId: string) => api.removeFromQueue(queueItemId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["labels-queue"] }),
  });

  const items = itemsQ.data?.items ?? [];
  // When a tab's items carry hierarchy (today: locations — rooms & bins), show
  // the SAME structure as the real Locations page: an Areas tree with bins
  // nested inside, and loose bins in their own Containers section. While
  // searching we fall back to a flat list (the result set is a filtered subset,
  // not a whole tree). A non-hierarchical tab (parts, machines) stays a grid.
  const hierarchical = !q && items.some((it) => it.section != null);
  // THE shared locations model — same tree build + (position, then natural
  // name) sort the Locations page uses, so "Bin 2" sorts before "Bin 10" here
  // too. One viewer, global.
  // NOTE: this hook must run BEFORE the early returns below. It used to sit
  // after them, so a render that bailed on `tabsQ.isLoading` ran one fewer
  // hook than the loaded render — React #310 crashed the Labels page the
  // instant the tabs query resolved. All hooks stay above the first return.
  const sections = useMemo(() => {
    if (!hierarchical) return null;
    const forest = buildLocationForest<LabelableItem>(items, {
      id: (x) => x.id,
      parentId: (x) => x.parent_id ?? null,
      position: (x) => x.position ?? 0,
      name: (x) => x.title,
      isContainer: (x) => x.section === "container",
    });
    return {
      areas: flattenLocationForest(forest.areas),
      containers: flattenLocationForest(forest.containers),
    };
  }, [hierarchical, items]);

  if (tabsQ.isLoading) {
    return <div className="text-sm text-faint dark:text-slate-500">loading labelable items…</div>;
  }
  if (tabs.length === 0) {
    return (
      <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-8 text-center text-faint dark:text-slate-500 text-sm">
        Nothing to label yet. Add some items to a module that supports labels
        (Inventory, Machines, Assets, …) and they'll show up here to print.
      </div>
    );
  }

  // One row — shared by the flat grid and the indented tree.
  const renderRow = (it: LabelableItem, indent = 0) => {
    const queueItemId = queuedIds.get(`${it.kind}:${it.id}`);
    const queued = queueItemId != null;
    const adding = add.isPending && add.variables?.id === it.id;
    const removing = remove.isPending && remove.variables === queueItemId;
    const busy = adding || removing;
    return (
      <li
        key={it.id}
        style={indent ? { marginLeft: indent * 18 } : undefined}
        className="flex items-center gap-2.5 rounded-lg border border-line dark:border-slate-700 bg-subtle/30 dark:bg-slate-800/30 px-2.5 py-2"
      >
        <EntityThumb src={it.image_path} alt={it.title} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-content dark:text-mortar-100 truncate">{it.title}</div>
          {it.subtitle && (
            <div className="text-[11px] text-faint dark:text-slate-500 truncate">{it.subtitle}</div>
          )}
        </div>
        {queued ? (
          // A queued row is a REMOVE toggle: "Added ✓" at rest, "Remove ✕"
          // (ember) on hover/focus. Clicking takes it back out of the queue.
          <button
            onClick={() => queueItemId && remove.mutate(queueItemId)}
            disabled={busy}
            aria-label={`Remove ${it.title} from the label queue`}
            title="In the queue — click to remove"
            className="group/qbtn shrink-0 rounded-md text-xs font-medium px-2.5 py-1.5 transition flex items-center gap-1 disabled:opacity-50 text-emerald-600 dark:text-emerald-400 hover:text-ember-600 dark:hover:text-ember-400 border border-transparent hover:border-ember-400/60"
          >
            <Check size={13} className="group-hover/qbtn:hidden" />
            <X size={13} className="hidden group-hover/qbtn:inline" />
            <span className="group-hover/qbtn:hidden">{removing ? "…" : "Added"}</span>
            <span className="hidden group-hover/qbtn:inline">Remove</span>
          </button>
        ) : (
          <button
            onClick={() => add.mutate(it)}
            disabled={busy}
            aria-label={`Add ${it.title} to the label queue`}
            title="Add to the label queue"
            className="shrink-0 rounded-md text-xs font-medium px-2.5 py-1.5 transition flex items-center gap-1 disabled:opacity-50 border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200"
          >
            <Plus size={13} />
            {adding ? "…" : "Add"}
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 px-3 py-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">// add labels</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-sm">
          <Search size={13} className="text-faint dark:text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search this tab…"
            className="input !w-48 !py-1 text-xs"
          />
        </label>
      </div>

      {/* Tabs — one per labelable instance the workspace has */}
      <div className="flex gap-1 border-b border-line dark:border-slate-700 px-2 pt-2 overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => { setActive(t.id); setQ(""); }}
              className={
                "px-3 py-1.5 text-sm font-medium rounded-t-md whitespace-nowrap transition border-b-2 -mb-px " +
                (on
                  ? "border-accent text-content dark:text-mortar-100"
                  : "border-transparent text-muted dark:text-slate-400 hover:text-content dark:hover:text-mortar-200")
              }
            >
              {t.label}
              {typeof t.count === "number" && (
                <span className="ml-1.5 font-mono text-[10px] text-faint dark:text-slate-500">{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Items in the active tab */}
      <div className="p-2">
        {itemsQ.isLoading && <div className="px-2 py-6 text-sm text-faint dark:text-slate-500">loading…</div>}
        {!itemsQ.isLoading && items.length === 0 && (
          <div className="px-2 py-6 text-sm text-faint dark:text-slate-500">
            {q ? "No matches." : "Nothing here yet."}
          </div>
        )}
        {/* Flat tab (parts, machines, …): a simple two-column grid. */}
        {items.length > 0 && !sections && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {items.map((it) => renderRow(it))}
          </ul>
        )}

        {/* Hierarchical tab (locations): Areas tree + a separate Containers
            section — the same shape as the real Locations page. */}
        {items.length > 0 && sections && (
          <div className="space-y-3">
            {sections.areas.length > 0 && (
              <div>
                <SectionHeader label="Areas" count={sections.areas.length} />
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {sections.areas.map((r) => renderRow(r.node, r.depth))}
                </ul>
              </div>
            )}
            {sections.containers.length > 0 && (
              <div>
                <SectionHeader label="Containers" count={sections.containers.length} />
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {sections.containers.map((r) => renderRow(r.node, r.depth))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5 px-0.5">
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        {label}
      </h3>
      <span className="text-[10px] font-mono text-faint dark:text-slate-500">{count}</span>
    </div>
  );
}

// The tree build + sort + area/container split now live in the shared
// buildLocationForest (@cobblr/platform-web) — the SAME model the Locations
// page uses, so order + structure never drift between the two surfaces.
