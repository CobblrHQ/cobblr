// /views — list every saved view, open one to render its data
// through the list resolver. Lets users see what their workspace
// looks like through each lens without leaving the platform UI.
//
// v0.1 renders the 'list' view_type. Future kanban/calendar/table
// renderers swap in here as they ship.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutList, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, api, type SavedView } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

export function ViewsPage() {
  usePageTitle("Views");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [active, setActive] = useState<SavedView | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SavedView | null>(null);
  const pinToggle = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateSavedView(activeSlug, id, { pinned }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["dash-views", activeSlug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const list = useQuery({
    queryKey: ["saved-views", activeSlug],
    queryFn: () => api.listSavedViews(activeSlug),
    enabled: !!activeSlug,
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Views</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} saved
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New view
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No saved views yet. Each module's pages can save their current filters as a view.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((v) => (
          <li
            key={v.id}
            className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800/40 cursor-pointer"
            onClick={() => setActive(v)}
          >
            <LayoutList size={14} className="text-faint" />
            <span className="font-medium truncate">{v.name}</span>
            <span className="text-xs text-muted dark:text-slate-400 truncate">
              {v.entity_kind}
            </span>
            <span className="ml-auto text-xs uppercase text-faint tracking-wide">
              {v.view_type}
              {v.is_default && " · default"}
              {v.owner_user_id === null && " · shared"}
              {v.pinned && " · pinned"}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                pinToggle.mutate({ id: v.id, pinned: !v.pinned });
              }}
              className={
                v.pinned
                  ? "text-accent hover:text-accent"
                  : "text-faint hover:text-accent"
              }
              title={v.pinned ? "Unpin from dashboard" : "Pin to dashboard"}
            >
              {v.pinned ? <Pin size={14} /> : <PinOff size={14} />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(v);
              }}
              className="text-faint hover:text-accent"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await confirm({
                  title: "Delete view?",
                  message: v.name,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await api.deleteSavedView(activeSlug, v.id);
                  toast.success("Deleted");
                  void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
                } catch (err) {
                  toast.error(`Delete failed: ${(err as Error).message}`);
                }
              }}
              className="text-faint hover:text-ember-500"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      {active && (
        <ViewDataModal
          view={active}
          slug={activeSlug}
          onClose={() => setActive(null)}
        />
      )}

      {createOpen && (
        <CreateViewModal
          slug={activeSlug}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {editing && (
        <EditViewModal
          slug={activeSlug}
          view={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["view-data", activeSlug] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ViewDataModal({
  view,
  slug,
  onClose,
}: {
  view: SavedView;
  slug: string;
  onClose: () => void;
}) {
  const data = useQuery({
    queryKey: ["view-data", slug, view.id],
    queryFn: () => api.viewData(slug, view.id),
  });
  const items = data.data?.items ?? [];
  const cfg = (view.config ?? {}) as ViewConfig;

  return (
    <Modal open onClose={onClose} title={view.name} size="lg">
      <div className="space-y-2">
        <div className="text-xs text-muted dark:text-slate-400 flex items-center gap-2">
          <span>{view.entity_kind}</span>
          <span className="px-1.5 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300 font-mono text-[10px] uppercase">
            {view.view_type}
          </span>
          <span>{items.length} rows</span>
        </div>
        {data.isLoading && <div className="text-sm text-muted">Loading…</div>}
        {items.length === 0 && !data.isLoading && (
          <div className="text-sm text-muted italic">No matching rows.</div>
        )}
        {items.length > 0 && view.view_type === "kanban" && (
          <KanbanRenderer items={items} groupBy={cfg.group_by ?? "subtitle"} />
        )}
        {items.length > 0 && view.view_type === "table" && (
          <TableRenderer items={items} columns={cfg.visible_fields} />
        )}
        {items.length > 0 && view.view_type === "trend" && (
          <TrendRenderer items={items} cfg={cfg} />
        )}
        {items.length > 0 && view.view_type !== "kanban" && view.view_type !== "table" && view.view_type !== "trend" && (
          <ListRenderer items={items} />
        )}
      </div>
    </Modal>
  );
}

interface ViewConfig {
  group_by?: string;
  visible_fields?: string[];
  [k: string]: unknown;
}

interface ViewRow {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  fields?: Record<string, unknown>;
}

// Trend renderer — a dependency-free SVG line chart for time-series rows
// (core-fitness measurements, or any kind with a numeric value + a date).
// Reads cfg.x (date field, default "measured_at"), cfg.y (numeric field,
// default "value"), and optional cfg.goal (a horizontal target line). No
// charting library — a small inline SVG keeps the web bundle dep-free.
function TrendRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const xField = (cfg.x as string) ?? "measured_at";
  const yField = (cfg.y as string) ?? "value";
  const goal = typeof cfg.goal === "number" ? cfg.goal : undefined;

  const pts = items
    .map((r) => {
      const t = new Date(String(r.fields?.[xField] ?? "")).getTime();
      const v = Number(r.fields?.[yField]);
      return Number.isFinite(t) && Number.isFinite(v) ? { t, v } : null;
    })
    .filter((p): p is { t: number; v: number } => p !== null)
    .sort((a, b) => a.t - b.t);

  if (pts.length < 2) {
    return <div className="text-sm text-muted italic">Need at least two data points to chart a trend.</div>;
  }

  const W = 560, H = 220, PAD = 28;
  const ts = pts.map((p) => p.t), vs = pts.map((p) => p.v);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  let vMin = Math.min(...vs, ...(goal != null ? [goal] : []));
  let vMax = Math.max(...vs, ...(goal != null ? [goal] : []));
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const x = (t: number) => PAD + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * PAD);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const latest = pts[pts.length - 1]!.v;

  return (
    <div className="border border-line dark:border-slate-700 rounded p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Trend chart">
        {/* axes */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} />
        {/* goal line */}
        {goal != null && (
          <>
            <line x1={PAD} y1={y(goal)} x2={W - PAD} y2={y(goal)} className="stroke-emerald-500" strokeWidth={1} strokeDasharray="4 3" />
            <text x={W - PAD} y={y(goal) - 4} textAnchor="end" className="fill-emerald-600 text-[10px]">goal {goal}</text>
          </>
        )}
        {/* the trend line */}
        <path d={path} fill="none" className="stroke-cobble-500" strokeWidth={2} />
        {/* points */}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.5} className="fill-cobble-600" />
        ))}
        {/* latest value label */}
        <text x={x(pts[pts.length - 1]!.t)} y={y(latest) - 6} textAnchor="end" className="fill-slate-600 dark:fill-slate-300 text-[10px]">{latest}</text>
      </svg>
      <div className="text-xs text-muted px-1 flex justify-between">
        <span>{new Date(tMin).toLocaleDateString()}</span>
        <span>latest: <b>{latest}</b>{goal != null ? ` · goal ${goal}` : ""}</span>
        <span>{new Date(tMax).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function ListRenderer({ items }: { items: ViewRow[] }) {
  return (
    <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
      {items.map((row) => (
        <li key={`${row.kind}:${row.id}`} className="px-3 py-2 text-sm">
          <div className="flex items-baseline gap-3">
            <span className="font-medium">{row.title}</span>
            {row.subtitle && (
              <span className="text-xs text-muted">{row.subtitle}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function KanbanRenderer({
  items,
  groupBy,
}: {
  items: ViewRow[];
  groupBy: string;
}) {
  // Group rows by config.group_by — try direct field first, then
  // fields[group_by], then fall back to subtitle. Unrecognised /
  // null values bucket under "(none)".
  const buckets = new Map<string, ViewRow[]>();
  for (const r of items) {
    const raw =
      (r as unknown as Record<string, unknown>)[groupBy] ??
      r.fields?.[groupBy] ??
      (groupBy === "subtitle" ? r.subtitle : undefined);
    const key = typeof raw === "string" && raw.length > 0 ? raw : "(none)";
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }
  const cols = Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {cols.map(([col, rows]) => (
        <div
          key={col}
          className="min-w-[200px] max-w-[260px] shrink-0 border border-line dark:border-slate-700 rounded bg-subtle/50 dark:bg-slate-900/40"
        >
          <div className="px-2 py-1.5 border-b border-line dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs font-medium text-content dark:text-slate-300 truncate">
              {col}
            </span>
            <span className="text-[10px] text-faint">{rows.length}</span>
          </div>
          <ul className="p-2 space-y-1.5">
            {rows.map((r) => (
              <li
                key={`${r.kind}:${r.id}`}
                className="px-2 py-1.5 text-xs rounded bg-surface dark:bg-slate-800 border border-line dark:border-slate-700"
              >
                <div className="font-medium truncate">{r.title}</div>
                {r.subtitle && col !== r.subtitle && (
                  <div className="text-[10px] text-muted truncate">
                    {r.subtitle}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TableRenderer({
  items,
  columns,
}: {
  items: ViewRow[];
  columns?: string[];
}) {
  // Default to title + subtitle when no visible_fields declared.
  // When declared, render each as a column read from row.fields.
  const cols = columns && columns.length > 0 ? columns : ["title", "subtitle"];
  return (
    <div className="overflow-x-auto border border-line dark:border-slate-700 rounded">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40">
            {cols.map((c) => (
              <th
                key={c}
                className="px-3 py-1.5 text-left font-mono text-[10px] uppercase text-muted tracking-wider"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={`${r.kind}:${r.id}`}
              className="border-b border-line dark:border-slate-800 last:border-b-0"
            >
              {cols.map((c) => (
                <td key={c} className="px-3 py-1.5 align-top truncate max-w-[260px]">
                  {formatCell(c, r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(col: string, row: ViewRow): string {
  if (col === "title") return row.title;
  if (col === "subtitle") return row.subtitle ?? "";
  const v = row.fields?.[col];
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

function CreateViewModal({
  slug,
  onClose,
  onCreated,
}: {
  slug: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [entityKind, setEntityKind] = useState("inventory:part");
  const [name, setName] = useState("");
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend">("list");
  const [groupBy, setGroupBy] = useState("subtitle");
  const [visibleFields, setVisibleFields] = useState("title, subtitle");
  const [shared, setShared] = useState(true);
  const toast = useToast();

  // Discover entity kinds from the registry so the user picks a real one.
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });

  return (
    <Modal open onClose={onClose} title="New saved view">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const config: Record<string, unknown> = {};
          if (viewType === "kanban" && groupBy.trim()) {
            config.group_by = groupBy.trim();
          }
          if (viewType === "table") {
            const cols = visibleFields
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            if (cols.length > 0) config.visible_fields = cols;
          }
          try {
            await api.createSavedView(slug, {
              entity_kind: entityKind,
              name: name.trim(),
              view_type: viewType,
              config,
              shared,
            });
            toast.success("View saved");
            onCreated();
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : String(err);
            toast.error(msg);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Entity kind</div>
          <select
            value={entityKind}
            onChange={(e) => setEntityKind(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            {(kinds.data?.items ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.display_name} ({k.id})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Low stock"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Layout</div>
          <div className="flex gap-1">
            {(["list", "table", "kanban", "trend"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setViewType(t)}
                className={`flex-1 px-3 py-1.5 text-xs rounded transition ${
                  viewType === t
                    ? "bg-cobble-600 text-white"
                    : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </label>
        {viewType === "kanban" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Group by</div>
            <input
              type="text"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              placeholder="status, state, subtitle…"
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
            <div className="text-[11px] text-faint mt-1">
              Field name to group columns by. Tried as top-level field first,
              then row.fields[field]. Default <code>subtitle</code> uses the
              entity's subtitle string (state for assets, status for orders…).
            </div>
          </label>
        )}
        {viewType === "table" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Columns (comma-separated)</div>
            <input
              type="text"
              value={visibleFields}
              onChange={(e) => setVisibleFields(e.target.value)}
              placeholder="title, subtitle, qty, unit"
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
            <div className="text-[11px] text-faint mt-1">
              <code>title</code> and <code>subtitle</code> read from the resolved
              entity; anything else reads <code>row.fields[col]</code>.
            </div>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Share with workspace (uncheck to keep private)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Save view
          </button>
        </div>
      </form>
    </Modal>
  );
}


function EditViewModal({
  slug,
  view,
  onClose,
  onSaved,
}: {
  slug: string;
  view: SavedView;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Edit form is simpler than create: name + view_type + view-type-
  // specific config + shared toggle. Entity kind is locked because
  // changing it would invalidate the config's filter / where /
  // sort which are kind-specific.
  const [name, setName] = useState(view.name);
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend">(
    (view.view_type as "list" | "table" | "kanban" | "trend") ?? "list",
  );
  const cfg = (view.config ?? {}) as ViewConfig;
  const [groupBy, setGroupBy] = useState((cfg.group_by as string) ?? "subtitle");
  const [visibleFields, setVisibleFields] = useState(
    (cfg.visible_fields ?? ["title", "subtitle"]).join(", "),
  );
  const [filterRaw, setFilterRaw] = useState(
    formatFilterPairs((cfg.filter as Record<string, unknown>) ?? {}),
  );
  const [shared, setShared] = useState(view.owner_user_id === null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  return (
    <Modal open onClose={onClose} title={`Edit view — ${view.name}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          const config: Record<string, unknown> = { ...cfg };
          if (viewType === "kanban" && groupBy.trim()) {
            config.group_by = groupBy.trim();
          } else {
            delete config.group_by;
          }
          if (viewType === "table") {
            const cols = visibleFields.split(",").map((s) => s.trim()).filter(Boolean);
            config.visible_fields = cols.length > 0 ? cols : undefined;
          } else {
            delete config.visible_fields;
          }
          // Re-build the filter blob from the comma-separated key=value
          // input. Empty input → no filter.
          const newFilter: Record<string, string> = {};
          for (const piece of filterRaw.split(",")) {
            const [k, v] = piece.split("=").map((s) => s.trim());
            if (k && v) newFilter[k] = v;
          }
          if (Object.keys(newFilter).length > 0) config.filter = newFilter;
          else delete config.filter;

          try {
            await api.updateSavedView(slug, view.id, {
              name: name.trim(),
              view_type: viewType,
              config,
              shared,
            });
            toast.success("Saved");
            onSaved();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <div className="text-xs text-faint">
          Entity kind: <span className="font-mono">{view.entity_kind}</span>{" "}
          (locked)
        </div>
        <label className="block">
          <div className="text-xs text-muted mb-1">Layout</div>
          <div className="flex gap-1">
            {(["list", "table", "kanban", "trend"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setViewType(t)}
                className={`flex-1 px-3 py-1.5 text-xs rounded transition ${
                  viewType === t
                    ? "bg-cobble-600 text-white"
                    : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </label>
        {viewType === "kanban" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Group by</div>
            <input
              type="text"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        )}
        {viewType === "table" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Columns</div>
            <input
              type="text"
              value={visibleFields}
              onChange={(e) => setVisibleFields(e.target.value)}
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        )}
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Filter (comma-separated <code>key=value</code>)
          </div>
          <input
            type="text"
            value={filterRaw}
            onChange={(e) => setFilterRaw(e.target.value)}
            placeholder="status=active, _tag=urgent"
            className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[11px] text-faint mt-1">
            Native cols, metadata fields, and <code>_tag</code> are all
            supported per the resolver's filter rules.
          </div>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Shared with workspace
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {busy ? "saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function formatFilterPairs(filter: Record<string, unknown>): string {
  return Object.entries(filter)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}
