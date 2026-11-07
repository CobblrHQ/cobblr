import { fieldNeed, FieldPack, RecordFormModal, ContributedDetailPanels, CustomFieldsPanel, useRecordInPath, useToast, useConfirm, usePageTitle, editOf, useRoleAtLeast, useRecordAsOpened } from "@cobblr/platform-web";
import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
// tracking UI — host mounts <TrackingUI /> at /tracking. A grid of metrics
// (each with a progress bar + sparkline); clicking one opens a detail MODAL to
// log values and see the trend. Modals not pages; toasts not dialogs; confirm
// for deletes. Dependency-free inline SVG sparkline (same approach as the
// core-views 'trend' renderer).

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, Plus, Trash2, Pencil } from "lucide-react";
import { TrackingApi, type MetricSummary, type MetricDetail, type Measurement, type GoalDirection, TrackingApiError } from "./api.js";
import { valueWithUnit } from "@cobblr/platform-contract/money";
import { dayHere } from "@cobblr/platform-contract/day";
import { chartRange, instantOfPickedDay } from "./chart-range.js";

export const navItems = [{ label: "Tracking", path: "/tracking", icon: TrendingUp }];

interface Props {
  orgSlug: string;
  getToken: () => string | null;
}

export function TrackingUI({ orgSlug, getToken }: Props) {
  usePageTitle("Tracking");
  const api = new TrackingApi(orgSlug, getToken);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // A metric's address (/tracking/<id>) opens it, and so does the older
  // `?metric=<id>` a notification may still carry: landing on a grid of cards
  // after being told a specific number makes you do the finding twice.
  const [params] = useSearchParams();
  const [inPath, setOpen] = useRecordInPath("tracking");
  const open = inPath ?? params.get("metric");
  const [creating, setCreating] = useState(false);

  const metrics = useQuery({ queryKey: ["tracking", orgSlug], queryFn: () => api.listMetrics() });

  const mayDelete = useRoleAtLeast(ADMIN_TIER);
  const del = useMutation({
    mutationFn: (id: string) => api.deleteMetric(id),
    onSuccess: () => { toast.success("Metric deleted"); void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] }); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap gap-x-3 gap-y-2 items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">tracking</h1>
        <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700">
          <Plus size={14} /> New metric
        </button>
      </div>

      {metrics.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {metrics.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">Track anything over time toward a goal - weight, runs, a habit, a budget.</div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {metrics.data?.items.map((m) => (
          <MetricCard key={m.id} metric={m} api={api} orgSlug={orgSlug} onOpen={() => setOpen(m.id)} onDelete={mayDelete ? async () => {
            if (await confirm({ title: `Delete "${m.name}"?`, message: "This removes the metric and all its measurements.", confirmLabel: "Delete", destructive: true })) {
              del.mutate(m.id);
            }
          } : undefined} />
        ))}
      </div>

      {creating && <MetricFormModal api={api} orgSlug={orgSlug} onClose={() => setCreating(false)} />}
      {open && <MetricDetailModal metricId={open} api={api} orgSlug={orgSlug} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ProgressBar({ p }: { p: number | null }) {
  if (p == null) return <div className="text-xs text-faint">no goal / no data</div>;
  const pct = Math.round(p * 100);
  return (
    <div className="space-y-1">
      <div className="h-2 rounded bg-subtle dark:bg-slate-800 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-muted">{pct}% to goal</div>
    </div>
  );
}

function MetricCard({ metric, api, orgSlug, onOpen, onDelete }: { metric: MetricSummary; api: TrackingApi; orgSlug: string; onOpen: () => void; onDelete?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [val, setVal] = useState("");
  const log = useMutation({
    mutationFn: (v: number) => api.logMeasurement(metric.id, v),
    onSuccess: () => {
      setVal("");
      void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] });
      void qc.invalidateQueries({ queryKey: ["tracking-detail", metric.id] });
    },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });
  return (
    // min-w-0: a grid cell's floor is its widest content, and at 200% text the
    // card ran 214 px past a phone (#8430).
    <div className="min-w-0 rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left flex-1 min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 break-words">{metric.name}</div>
          <div className="text-xs text-muted mt-0.5">
            {metric.latest_value != null ? valueWithUnit(Number(metric.latest_value), metric.unit) : "no data"}
            {metric.goal_value != null && <span className="text-faint"> · goal {metric.goal_value}</span>}
          </div>
        </button>
        {onDelete && <button title="Delete metric" type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 hover-reveal transition" aria-label="Delete metric">
          <Trash2 size={15} />
        </button>}
      </div>
      <div className="mt-2"><ProgressBar p={metric.progress} /></div>
      {/* Quick-log: one number, no modal — the "three seconds" path. */}
      <form className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (val !== "") log.mutate(Number(val)); }}>
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          type="number"
          step="any"
          placeholder={`quick log${metric.unit ? ` (${metric.unit})` : ""}…`}
          aria-label={`Quick-log a value for ${metric.name}`}
          className="flex-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 text-xs"
        />
        <button type="submit" disabled={val === "" || log.isPending} className="px-2.5 py-1 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Log</button>
      </form>
    </div>
  );
}

/** A new metric, or with `metric` the one being edited. */
export function MetricFormModal({ api, orgSlug, metric: shown, onClose }: { api: TrackingApi; orgSlug: string; metric?: MetricDetail; onClose: () => void }) {
  const metric = useRecordAsOpened(shown);
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(metric?.name ?? "");
  const [unit, setUnit] = useState(metric?.unit ?? "");
  const [goal, setGoal] = useState(metric?.goal_value != null ? String(metric.goal_value) : "");
  const [dir, setDir] = useState<GoalDirection>(metric?.goal_direction ?? "down");

  const create = useMutation({
    mutationFn: async () => {
      if (metric) {
        await api.updateMetric(metric.id, editOf(metric, { name: name.trim(), unit: unit.trim() || null, goal_value: goal === "" ? null : Number(goal), goal_direction: dir }));
      } else {
        await api.createMetric({ name: name.trim(), unit: unit.trim() || undefined, goal_value: goal === "" ? undefined : Number(goal), goal_direction: dir });
      }
    },
    onSuccess: () => {
      toast.success(metric ? "Metric saved" : "Metric created");
      void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] });
      if (metric) void qc.invalidateQueries({ queryKey: ["tracking-detail", metric.id] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  const field = "w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm";
  return (
    <RecordFormModal open onClose={onClose} title={metric ? "Edit metric" : "New metric"}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <FieldPack maxCols={3} items={[
          { need: fieldNeed("name", { control: "text", label: "Name" }), node: <input aria-label="Name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weight" className={field} /> },
          { need: fieldNeed("unit", { control: "text", label: "Unit" }), node: <input aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit (kg, km, reps…)" className={field} /> },
          { need: fieldNeed("goal", { control: "number", label: "Goal" }), node: <input aria-label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)} type="number" step="any" placeholder="goal" className={field} /> },
        ]} />
        <label className="block">
          <div className="text-xs text-muted mb-1">Goal direction</div>
          <div className="flex gap-1">
            {(["down", "up", "hit"] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDir(d)} className={`flex-1 px-3 py-1.5 text-xs rounded ${dir === d ? "bg-cobble-600 text-white" : "bg-subtle dark:bg-slate-800"}`}>
                {d === "down" ? "lower is better" : d === "up" ? "higher is better" : "hit target"}
              </button>
            ))}
          </div>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-subtle dark:bg-slate-800">Cancel</button>
          <button type="submit" disabled={!name.trim() || create.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">{metric ? "Save" : "Create"}</button>
        </div>
      </form>
    </RecordFormModal>
  );
}

/** Past this the dots are a solid smear, and thousands of them slow the page. */
const DOTS_UP_TO = 500;
const MORE_READINGS = 1000;

function Sparkline({ points, goal }: { points: Measurement[]; goal: number | null }) {
  if (points.length < 2) return <div className="text-xs text-faint italic">Log at least two values to see a trend.</div>;
  const W = 480, H = 140, PAD = 10;
  const ts = points.map((p) => new Date(p.measured_at).getTime());
  const { min: tMin, max: tMax } = chartRange(ts);
  const span = chartRange(points.map((p) => p.value), goal);
  let vMin = span.min, vMax = span.max;
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const x = (t: number) => PAD + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * PAD);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(ts[i]!).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full border border-line dark:border-slate-700 rounded" role="img" aria-label="Trend">
      {goal != null && <line x1={PAD} y1={y(goal)} x2={W - PAD} y2={y(goal)} className="stroke-emerald-500" strokeWidth={1} strokeDasharray="4 3" />}
      <path d={path} fill="none" className="stroke-cobble-500" strokeWidth={2} />
      {points.length <= DOTS_UP_TO && points.map((p, i) => <circle key={p.id} cx={x(ts[i]!)} cy={y(p.value)} r={2.5} className="fill-cobble-600" />)}
    </svg>
  );
}

function MetricDetailModal({ metricId, api, orgSlug, onClose }: { metricId: string; api: TrackingApi; orgSlug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [val, setVal] = useState("");
  const today = dayHere();
  const [day, setDay] = useState(today);
  const [readings, setReadings] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: ["tracking-detail", metricId, readings],
    queryFn: () => api.getMetric(metricId, readings),
    placeholderData: keepPreviousData,
    // An address with no metric at it stays that way; asking again only delays saying so.
    retry: (failures, e) => !(e instanceof TrackingApiError && e.status < 500) && failures < 2,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["tracking-detail", metricId] });
    void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] });
  };
  const log = useMutation({
    mutationFn: (v: number) => api.logMeasurement(metricId, v, undefined, instantOfPickedDay(day, today)),
    onSuccess: () => { setVal(""); setDay(today); invalidate(); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });
  const setField = useMutation({
    mutationFn: (m: Record<string, unknown>) => api.updateMetric(metricId, editOf(detail.data, { metadata: m })),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeMeasurement(id),
    onSuccess: () => { toast.success("Reading removed"); invalidate(); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  const d = detail.data;
  if (d && editing) return <MetricFormModal api={api} orgSlug={orgSlug} metric={d} onClose={() => setEditing(false)} />;
  if (detail.isError) {
    const missing = detail.error instanceof TrackingApiError && detail.error.status < 500;
    return (
      <RecordFormModal open onClose={onClose} title="Metric">
        <p className="text-sm text-muted">{missing ? "There is no metric at this address. It may have been deleted." : `This metric could not be read: ${detail.error.message}`}</p>
      </RecordFormModal>
    );
  }
  return (
    <RecordFormModal open onClose={onClose} title={d?.name ?? "Metric"} subtitle={d?.goal_value != null ? `goal ${valueWithUnit(Number(d.goal_value), d.unit)} (${d.goal_direction})` : undefined}>
      <div className="space-y-3">
        {!d && <div className="text-sm text-muted">Loading…</div>}
        {d && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (val !== "") log.mutate(Number(val)); }}>
          <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} type="number" step="any" aria-label={`Log a value for ${d.name}`} placeholder={`Log a value${d.unit ? ` (${d.unit})` : ""}…`} className="min-w-0 flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          <button type="submit" disabled={val === "" || log.isPending} className="px-3 py-2 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Log</button>
          <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 px-3 py-2 text-xs rounded bg-subtle dark:bg-slate-800"><Pencil size={12} /> Edit</button>
        </form>}

        {d && <label className="flex items-center gap-2 text-xs text-muted">
          Taken on
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="rounded border border-line bg-surface px-2 py-1 text-sm dark:border-slate-700" />
        </label>}

        {d && <ProgressBar p={d.progress} />}
        {d && <Sparkline points={d.measurements} goal={d.goal_value} />}

        {d && d.measurements.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-48 overflow-auto">
            {[...d.measurements].reverse().map((m: Measurement) => (
              <li key={m.id} className="flex items-start gap-2 px-3 py-1.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium [overflow-wrap:anywhere]">{valueWithUnit(Number(m.value), d.unit)}</div>
                  {m.note && <div className="text-xs text-muted [overflow-wrap:anywhere]">{m.note}</div>}
                </div>
                <span className="shrink-0 text-xs text-muted">{new Date(m.measured_at).toLocaleDateString()}</span>
                <button
                  type="button"
                  aria-label={`Remove the reading ${valueWithUnit(Number(m.value), d.unit)} from ${new Date(m.measured_at).toLocaleDateString()}`}
                  disabled={remove.isPending}
                  title="Remove this reading"
                  className="-my-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center text-slate-400 hover:text-red-500"
                  onClick={async () => {
                    if (await confirm({ title: `Remove ${valueWithUnit(Number(m.value), d.unit)}?`, message: "This takes the reading off the metric.", confirmLabel: "Remove", destructive: true })) {
                      remove.mutate(m.id);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {d && d.measurement_count > d.measurements.length && (
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span>Showing the newest {d.measurements.length.toLocaleString()} of {d.measurement_count.toLocaleString()} readings.</span>
            <button type="button" className="min-h-11 shrink-0 rounded bg-subtle px-3 dark:bg-slate-800" onClick={() => setReadings(d.measurements.length + MORE_READINGS)}>Show more</button>
          </div>
        )}

        {/* The metric's own fields, as a bundle or a person defines them. */}
        {d && <CustomFieldsPanel entityKind="tracking:metric" entityId={metricId} values={d.metadata ?? {}} onCommit={(name, value) => setField.mutate({ [name]: value })} />}

        {/* Tags and discussion, contributed at every kind. A record you
            open is a record somebody may want to say something about. */}
        <ContributedDetailPanels
          target="tracking:metric"
          ctx={{ slug: orgSlug, entityId: metricId, entityTitle: d?.name ?? "Metric" }}
        />
      </div>
    </RecordFormModal>
  );
}

export default TrackingUI;
