// /views — list every saved view, open one to render its data
// through the list resolver. Lets users see what their workspace
// looks like through each lens without leaving the platform UI.
//
// v0.1 renders the 'list' view_type. Future kanban/calendar/table
// renderers swap in here as they ship.

import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, LayoutList, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { WEEKDAYS, MONTHS, isoLocal, buildMonthGrid, shiftMonth } from "../lib/month-grid";
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

  // Deep-link: /views?view=<id> opens that view directly, so a "By category"
  // link elsewhere (e.g. the dashboard widget) lands ON the view instead of the
  // list where you'd have to click it a second time (reported double-hop).
  const [params] = useSearchParams();
  const viewParam = params.get("view");
  useEffect(() => {
    if (!viewParam || active) return;
    const match = items.find((v) => v.id === viewParam);
    if (match) setActive(match);
  }, [viewParam, items, active]);

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
          <TableRenderer items={items} columns={cfg.visible_fields} groupBy={cfg.group_by} />
        )}
        {items.length > 0 && view.view_type === "trend" && (
          <TrendRenderer items={items} cfg={cfg} />
        )}
        {items.length > 0 && view.view_type === "calendar" && (
          <CalendarRenderer items={items} cfg={cfg} />
        )}
        {items.length > 0 && view.view_type === "gantt" && (
          <GanttRenderer items={items} cfg={cfg} />
        )}
        {items.length > 0 && view.view_type !== "kanban" && view.view_type !== "table" && view.view_type !== "trend" && view.view_type !== "calendar" && view.view_type !== "gantt" && (
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
// (tracking measurements, or any kind with a numeric value + a date).
// Reads cfg.x (date field, default "measured_at"), cfg.y (numeric field,
// default "value"), and optional cfg.goal (a horizontal target line). No
// charting library — a small inline SVG keeps the web bundle dep-free.
function TrendRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const xField = (cfg.x as string) ?? "measured_at";
  const yField = (cfg.y as string) ?? "value";
  const goal = typeof cfg.goal === "number" ? cfg.goal : undefined;

  const pts = items
    .map((r) => {
      const t = new Date(String(fieldVal(r.fields, xField) ?? "")).getTime();
      const v = Number(fieldVal(r.fields, yField));
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

// Calendar renderer — places each row on a month grid by its date field.
// cfg.date_field names the field (a top-level native or a custom metadata
// field, read via fieldVal); values are YYYY-MM-DD (or an ISO datetime,
// sliced). cfg.title_field overrides what's shown on the chip (default title).
function CalendarRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const dateField = (cfg.date_field as string) || "due_date";
  const titleField = (cfg.title_field as string) || "title";
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const { weeks } = useMemo(() => buildMonthGrid(cursor.y, cursor.m), [cursor]);

  const byDay = useMemo(() => {
    const m: Record<string, ViewRow[]> = {};
    for (const it of items) {
      const dv = fieldVal(it.fields, dateField);
      if (dv == null || dv === "") continue;
      const key = String(dv).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      (m[key] ||= []).push(it);
    }
    return m;
  }, [items, dateField, titleField]);

  const cellTitle = (r: ViewRow): string => {
    if (titleField === "title") return r.title;
    if (titleField === "subtitle") return r.subtitle ?? r.title;
    const v = fieldVal(r.fields, titleField);
    return v == null ? r.title : String(v);
  };

  const placed = Object.values(byDay).reduce((n, a) => n + a.length, 0);
  const todayKey = isoLocal(new Date());

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setCursor((c) => shiftMonth(c, -1))} className="p-1 rounded hover:bg-subtle dark:hover:bg-slate-800 transition" title="Previous month"><ChevronLeft size={16} /></button>
        <span className="text-sm font-medium text-content dark:text-mortar-100 min-w-[9rem] text-center">{MONTHS[cursor.m]} {cursor.y}</span>
        <button onClick={() => setCursor((c) => shiftMonth(c, 1))} className="p-1 rounded hover:bg-subtle dark:hover:bg-slate-800 transition" title="Next month"><ChevronRight size={16} /></button>
        <button onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }} className="ml-1 text-[10px] font-mono uppercase tracking-widest text-accent hover:underline">today</button>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">on <code>{dateField}</code> · {placed} of {items.length}</span>
      </div>
      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <div className="grid grid-cols-7 bg-subtle/60 dark:bg-slate-800/40 border-b border-line dark:border-slate-700">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 text-center">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {weeks.flat().map((day) => {
            const key = isoLocal(day);
            const inMonth = day.getMonth() === cursor.m;
            const dayRows = byDay[key] ?? [];
            return (
              <div key={key} className={"min-h-[4.5rem] border-b border-r border-line dark:border-slate-800 p-1 " + (inMonth ? "bg-white dark:bg-slate-950" : "bg-mortar-50/40 dark:bg-slate-900/40")}>
                <div className={"text-[11px] font-mono mb-0.5 px-1 " + (key === todayKey ? "inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white" : inMonth ? "text-content dark:text-mortar-200" : "text-faint dark:text-slate-600")}>{day.getDate()}</div>
                <div className="space-y-0.5">
                  {dayRows.slice(0, 4).map((r) => (
                    <div key={`${r.kind}:${r.id}`} title={cellTitle(r)} className="truncate rounded px-1 py-0.5 text-[10px] leading-tight bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-cobble-200">{cellTitle(r)}</div>
                  ))}
                  {dayRows.length > 4 && <div className="text-[9px] text-faint dark:text-slate-500 px-1">+{dayRows.length - 4} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Gantt renderer — a horizontal timeline: each row is a bar from its start
// date (cfg.start_field, default "start_date") to its end date (cfg.end_field,
// default "target_date"). The axis spans the earliest start → latest end across
// all rows. A row missing a start is dropped; a row missing an end renders as a
// short milestone bar on its start day. cfg.title_field overrides the left-rail
// label. Dependency-free — plain divs positioned by percentage.
function GanttRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const startField = (cfg.start_field as string) || "start_date";
  const endField = (cfg.end_field as string) || "target_date";
  const titleField = (cfg.title_field as string) || "title";

  const day = 86400000;
  const parseDay = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const t = new Date(`${String(v).slice(0, 10)}T00:00:00`).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const rowTitle = (r: ViewRow): string => {
    if (titleField === "title") return r.title;
    if (titleField === "subtitle") return r.subtitle ?? r.title;
    const v = fieldVal(r.fields, titleField);
    return v == null ? r.title : String(v);
  };

  const bars = useMemo(() => {
    const out: { r: ViewRow; start: number; end: number; milestone: boolean }[] = [];
    for (const r of items) {
      const start = parseDay(fieldVal(r.fields, startField));
      if (start == null) continue;
      const rawEnd = parseDay(fieldVal(r.fields, endField));
      const milestone = rawEnd == null || rawEnd < start;
      out.push({ r, start, end: milestone ? start : rawEnd!, milestone });
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }, [items, startField, endField]);

  if (bars.length === 0) {
    return (
      <div className="text-sm text-muted italic">
        No rows with a <code>{startField}</code> date to lay out on a timeline.
      </div>
    );
  }

  const axisMin = Math.min(...bars.map((b) => b.start));
  const axisMaxRaw = Math.max(...bars.map((b) => b.end));
  // Pad the right edge by a day so a same-day milestone/end isn't a zero-width sliver.
  const axisMax = axisMaxRaw + day;
  const span = axisMax - axisMin || day;
  const pct = (t: number) => ((t - axisMin) / span) * 100;
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // Month boundary tick lines across the track for visual context.
  const ticks: number[] = [];
  {
    const d = new Date(axisMin);
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    while (d.getTime() < axisMax) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + 1);
    }
  }
  const todayT = parseDay(isoLocal(new Date()));
  const RAIL = "10rem";

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono text-faint dark:text-slate-500 flex justify-between px-1">
        <span><code>{startField}</code> → <code>{endField}</code> · {bars.length} of {items.length}</span>
        <span>{fmt(axisMin)} – {fmt(axisMaxRaw)}</span>
      </div>
      <div className="border border-line dark:border-slate-700 rounded overflow-hidden">
        {bars.map((b, i) => (
          <div
            key={`${b.r.kind}:${b.r.id}`}
            className={"flex items-stretch " + (i % 2 ? "bg-subtle/40 dark:bg-slate-900/40" : "")}
          >
            <div
              className="shrink-0 px-2 py-1.5 text-xs text-content dark:text-mortar-200 truncate border-r border-line dark:border-slate-800"
              style={{ width: RAIL }}
              title={rowTitle(b.r)}
            >
              {rowTitle(b.r)}
            </div>
            <div className="relative flex-1 my-1 mx-2">
              {/* month tick lines */}
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 bottom-0 w-px bg-line/70 dark:bg-slate-800" style={{ left: `${pct(t)}%` }} />
              ))}
              {/* today marker */}
              {todayT != null && todayT >= axisMin && todayT <= axisMax && (
                <div className="absolute top-0 bottom-0 w-px bg-accent/60" style={{ left: `${pct(todayT)}%` }} title="today" />
              )}
              {/* the bar */}
              <div
                className={
                  "absolute top-1/2 -translate-y-1/2 h-4 rounded " +
                  (b.milestone
                    ? "bg-amber-400 dark:bg-amber-500 min-w-[0.5rem]"
                    : "bg-cobble-500 dark:bg-cobble-600 min-w-[0.25rem]")
                }
                style={{ left: `${pct(b.start)}%`, width: `${Math.max(pct(b.end) - pct(b.start), b.milestone ? 0 : 1)}%` }}
                title={`${fmt(b.start)}${b.milestone ? " (milestone)" : ` – ${fmt(b.end)}`}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] font-mono text-faint dark:text-slate-500 px-1">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm bg-cobble-500" /> span (start → end)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm bg-amber-400" /> milestone (no end / end ≤ start)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-px h-3 bg-accent/60" /> today</span>
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
      fieldVal(r.fields, groupBy) ??
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
  groupBy,
}: {
  items: ViewRow[];
  columns?: string[];
  groupBy?: string;
}) {
  // Default to title + subtitle when no visible_fields declared.
  // When declared, render each as a column read from row.fields.
  const cols = columns && columns.length > 0 ? columns : ["title", "subtitle"];

  // When group_by is set, split rows into ordered sections with a header
  // row each. Reuses fieldVal so the group key reaches custom fields too.
  const groups: Array<{ key: string; rows: ViewRow[] }> = [];
  if (groupBy) {
    const byKey = new Map<string, ViewRow[]>();
    for (const r of items) {
      const raw =
        (r as unknown as Record<string, unknown>)[groupBy] ??
        fieldVal(r.fields, groupBy) ??
        (groupBy === "subtitle" ? r.subtitle : undefined);
      const key = typeof raw === "string" && raw.length > 0 ? raw : "(none)";
      const arr = byKey.get(key) ?? [];
      arr.push(r);
      byKey.set(key, arr);
    }
    for (const [key, rows] of byKey) groups.push({ key, rows });
  } else {
    groups.push({ key: "", rows: items });
  }

  const Row = (r: ViewRow) => (
    <tr key={`${r.kind}:${r.id}`} className="border-b border-line dark:border-slate-800 last:border-b-0">
      {cols.map((c) => (
        <td key={c} className="px-3 py-1.5 align-top truncate max-w-[260px]">
          {formatCell(c, r)}
        </td>
      ))}
    </tr>
  );

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
        {groupBy ? (
          groups.map((g) => (
            <tbody key={g.key}>
              <tr className="bg-cobble-50/70 dark:bg-cobble-900/20">
                <td colSpan={cols.length} className="px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-accent">
                  {g.key} · {g.rows.length}
                </td>
              </tr>
              {g.rows.map(Row)}
            </tbody>
          ))
        ) : (
          <tbody>{items.map(Row)}</tbody>
        )}
      </table>
    </div>
  );
}

/** Read a field off a resolved row. Custom (bundle / user-authored) field
 *  values live nested under `fields.metadata` — most module resolvers return
 *  `fields: row`, so a custom column like `mileage` is at
 *  `fields.metadata.mileage`, not `fields.mileage`. Try the top level first
 *  (native columns + computed fields), then fall back to metadata, so a
 *  saved view's `visible_fields`/`group_by` reaches custom fields too. */
function fieldVal(fields: Record<string, unknown> | undefined, key: string): unknown {
  if (!fields) return undefined;
  const top = fields[key];
  if (top !== undefined && top !== null) return top;
  const meta = fields.metadata;
  if (meta && typeof meta === "object") return (meta as Record<string, unknown>)[key];
  return undefined;
}

function formatCell(col: string, row: ViewRow): string {
  if (col === "title") return row.title;
  if (col === "subtitle") return row.subtitle ?? "";
  const v = fieldVal(row.fields, col);
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
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend" | "calendar" | "gantt">("list");
  const [groupBy, setGroupBy] = useState("subtitle");
  const [visibleFields, setVisibleFields] = useState("title, subtitle");
  const [dateField, setDateField] = useState("due_date");
  const [startField, setStartField] = useState("start_date");
  const [endField, setEndField] = useState("target_date");
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
          if (viewType === "calendar" && dateField.trim()) {
            config.date_field = dateField.trim();
          }
          if (viewType === "gantt") {
            if (startField.trim()) config.start_field = startField.trim();
            if (endField.trim()) config.end_field = endField.trim();
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
            {(["list", "table", "kanban", "trend", "calendar", "gantt"] as const).map((t) => (
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
        {viewType === "calendar" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Date field</div>
            <input
              type="text"
              value={dateField}
              onChange={(e) => setDateField(e.target.value)}
              placeholder="due_date, renewal_date, expires_date…"
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
            <div className="text-[11px] text-faint mt-1">
              Which field each row lands on. A native field or a custom one
              (read from <code>row.fields[field]</code>); values are
              <code>YYYY-MM-DD</code>.
            </div>
          </label>
        )}
        {viewType === "gantt" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-xs text-muted mb-1">Start field</div>
              <input
                type="text"
                value={startField}
                onChange={(e) => setStartField(e.target.value)}
                placeholder="start_date"
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">End field</div>
              <input
                type="text"
                value={endField}
                onChange={(e) => setEndField(e.target.value)}
                placeholder="target_date"
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
            <div className="text-[11px] text-faint col-span-2">
              Each row is a bar from its start to its end day. Rows with no end
              (or end ≤ start) render as a milestone marker. Native or custom
              fields (<code>row.fields[field]</code>); values are <code>YYYY-MM-DD</code>.
            </div>
          </div>
        )}
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
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend" | "calendar" | "gantt">(
    (view.view_type as "list" | "table" | "kanban" | "trend" | "calendar" | "gantt") ?? "list",
  );
  const cfg = (view.config ?? {}) as ViewConfig;
  const [groupBy, setGroupBy] = useState((cfg.group_by as string) ?? "subtitle");
  const [visibleFields, setVisibleFields] = useState(
    (cfg.visible_fields ?? ["title", "subtitle"]).join(", "),
  );
  const [dateField, setDateField] = useState((cfg.date_field as string) ?? "due_date");
  const [startField, setStartField] = useState((cfg.start_field as string) ?? "start_date");
  const [endField, setEndField] = useState((cfg.end_field as string) ?? "target_date");
  const [filterRaw, setFilterRaw] = useState(
    [
      formatFilterPairs((cfg.filter as Record<string, unknown>) ?? {}),
      ...((cfg.where as Array<{ col: string; op: string; value: unknown }> | undefined) ?? [])
        .filter((w) => w && !("ref_col" in w && (w as { ref_col?: unknown }).ref_col))
        .map((w) => `${w.col}${w.op}${w.value}`),
    ]
      .filter(Boolean)
      .join(", "),
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
          if (viewType === "calendar" && dateField.trim()) {
            config.date_field = dateField.trim();
          } else {
            delete config.date_field;
          }
          if (viewType === "gantt") {
            if (startField.trim()) config.start_field = startField.trim();
            else delete config.start_field;
            if (endField.trim()) config.end_field = endField.trim();
            else delete config.end_field;
          } else {
            delete config.start_field;
            delete config.end_field;
          }
          // Re-build the filter from the comma-separated input. `key=value`
          // stays a simple equality `filter`; a comparison (`key>=value`,
          // `key<=value`, `key>value`, `key<value`, `key!=value`) becomes a
          // `where` predicate (numeric value cast where the field is numeric).
          // Empty input → neither.
          const newFilter: Record<string, string> = {};
          const newWhere: Array<{ col: string; op: string; value: string | number }> = [];
          // 2-char ops first so `>=` isn't read as `>` / `=`.
          const OPS = ["<=", ">=", "!=", "<", ">", "="];
          for (const rawPiece of filterRaw.split(",")) {
            const piece = rawPiece.trim();
            if (!piece) continue;
            const op = OPS.find((o) => piece.includes(o));
            if (!op) continue;
            const idx = piece.indexOf(op);
            const k = piece.slice(0, idx).trim();
            const vRaw = piece.slice(idx + op.length).trim();
            if (!k || !vRaw) continue;
            if (op === "=") {
              newFilter[k] = vRaw;
            } else {
              const isNum = /^-?[0-9]+(\.[0-9]+)?$/.test(vRaw);
              newWhere.push({ col: k, op, value: isNum ? Number(vRaw) : vRaw });
            }
          }
          if (Object.keys(newFilter).length > 0) config.filter = newFilter;
          else delete config.filter;
          if (newWhere.length > 0) config.where = newWhere;
          else delete config.where;

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
            {(["list", "table", "kanban", "trend", "calendar", "gantt"] as const).map((t) => (
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
        {viewType === "calendar" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Date field</div>
            <input
              type="text"
              value={dateField}
              onChange={(e) => setDateField(e.target.value)}
              placeholder="due_date, renewal_date, expires_date…"
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
            <div className="text-[11px] text-faint mt-1">
              Which field each row lands on. A native field or a custom one
              (read from <code>row.fields[field]</code>); values are
              <code>YYYY-MM-DD</code>.
            </div>
          </label>
        )}
        {viewType === "gantt" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-xs text-muted mb-1">Start field</div>
              <input
                type="text"
                value={startField}
                onChange={(e) => setStartField(e.target.value)}
                placeholder="start_date"
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">End field</div>
              <input
                type="text"
                value={endField}
                onChange={(e) => setEndField(e.target.value)}
                placeholder="target_date"
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
            <div className="text-[11px] text-faint col-span-2">
              Each row is a bar from its start to its end day. Rows with no end
              (or end ≤ start) render as a milestone marker. Native or custom
              fields (<code>row.fields[field]</code>); values are <code>YYYY-MM-DD</code>.
            </div>
          </div>
        )}
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
            Filter (comma-separated <code>key=value</code> or <code>key≥value</code>)
          </div>
          <input
            type="text"
            value={filterRaw}
            onChange={(e) => setFilterRaw(e.target.value)}
            placeholder="status=active, qty>=0.3"
            className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <div className="text-[11px] text-faint mt-1">
            <code>=</code> matches exactly (native cols, metadata fields,{" "}
            <code>_tag</code>). For numbers, compare with{" "}
            <code>&gt;=</code> <code>&lt;=</code> <code>&gt;</code>{" "}
            <code>&lt;</code> <code>!=</code> — e.g.{" "}
            <code>qty&gt;=0.3</code> for spools with ≥ 300&nbsp;g left.
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
