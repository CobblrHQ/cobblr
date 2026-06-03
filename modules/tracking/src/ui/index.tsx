// tracking UI — host mounts <TrackingUI /> at /tracking. A grid of metrics
// (each with a progress bar + sparkline); clicking one opens a detail MODAL to
// log values and see the trend. Modals not pages; toasts not dialogs; confirm
// for deletes. Dependency-free inline SVG sparkline (same approach as the
// core-views 'trend' renderer).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";
import { TrendingUp, Plus, Trash2 } from "lucide-react";
import { TrackingApi, type MetricSummary, type Measurement, type GoalDirection, TrackingApiError } from "./api.js";

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
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const metrics = useQuery({ queryKey: ["tracking", orgSlug], queryFn: () => api.listMetrics() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteMetric(id),
    onSuccess: () => { toast.success("Metric deleted"); void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] }); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-baseline justify-between border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">tracking</h1>
        <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700">
          <Plus size={14} /> New metric
        </button>
      </div>

      {metrics.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {metrics.data?.items.length === 0 && (
        <div className="text-sm text-muted italic">Track anything over time toward a goal — weight, runs, a habit, a budget.</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {metrics.data?.items.map((m) => (
          <MetricCard key={m.id} metric={m} api={api} orgSlug={orgSlug} onOpen={() => setOpen(m.id)} onDelete={async () => {
            if (await confirm({ title: `Delete "${m.name}"?`, message: "This removes the metric and all its measurements.", confirmLabel: "Delete", destructive: true })) {
              del.mutate(m.id);
            }
          }} />
        ))}
      </div>

      {creating && <CreateMetricModal api={api} orgSlug={orgSlug} onClose={() => setCreating(false)} />}
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

function MetricCard({ metric, api, orgSlug, onOpen, onDelete }: { metric: MetricSummary; api: TrackingApi; orgSlug: string; onOpen: () => void; onDelete: () => void }) {
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
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 hover:border-cobble-400 transition group">
      <div className="flex items-start justify-between">
        <button type="button" onClick={onOpen} className="text-left flex-1">
          <div className="font-medium text-content dark:text-mortar-100">{metric.name}</div>
          <div className="text-xs text-muted mt-0.5">
            {metric.latest_value != null ? `${metric.latest_value}${metric.unit ? ` ${metric.unit}` : ""}` : "no data"}
            {metric.goal_value != null && <span className="text-faint"> · goal {metric.goal_value}</span>}
          </div>
        </button>
        <button type="button" onClick={onDelete} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition" aria-label="Delete metric">
          <Trash2 size={15} />
        </button>
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

function CreateMetricModal({ api, orgSlug, onClose }: { api: TrackingApi; orgSlug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState<GoalDirection>("down");

  const create = useMutation({
    mutationFn: () => api.createMetric({ name: name.trim(), unit: unit.trim() || undefined, goal_value: goal ? Number(goal) : undefined, goal_direction: dir }),
    onSuccess: () => { toast.success("Metric created"); void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] }); onClose(); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  const field = "w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm";
  return (
    <Modal open onClose={onClose} title="New metric">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weight" className={field} />
        <div className="flex gap-2">
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit (kg, km, reps…)" className={field} />
          <input value={goal} onChange={(e) => setGoal(e.target.value)} type="number" step="any" placeholder="goal" className={field} />
        </div>
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
          <button type="submit" disabled={!name.trim() || create.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function Sparkline({ points, goal }: { points: Measurement[]; goal: number | null }) {
  if (points.length < 2) return <div className="text-xs text-faint italic">Log at least two values to see a trend.</div>;
  const W = 480, H = 140, PAD = 10;
  const ts = points.map((p) => new Date(p.measured_at).getTime());
  const vs = points.map((p) => p.value);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  let vMin = Math.min(...vs, ...(goal != null ? [goal] : [])), vMax = Math.max(...vs, ...(goal != null ? [goal] : []));
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const x = (t: number) => PAD + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * PAD);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(ts[i]!).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full border border-line dark:border-slate-700 rounded" role="img" aria-label="Trend">
      {goal != null && <line x1={PAD} y1={y(goal)} x2={W - PAD} y2={y(goal)} className="stroke-emerald-500" strokeWidth={1} strokeDasharray="4 3" />}
      <path d={path} fill="none" className="stroke-cobble-500" strokeWidth={2} />
      {points.map((p, i) => <circle key={p.id} cx={x(ts[i]!)} cy={y(p.value)} r={2.5} className="fill-cobble-600" />)}
    </svg>
  );
}

function MetricDetailModal({ metricId, api, orgSlug, onClose }: { metricId: string; api: TrackingApi; orgSlug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [val, setVal] = useState("");
  const detail = useQuery({ queryKey: ["tracking-detail", metricId], queryFn: () => api.getMetric(metricId) });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["tracking-detail", metricId] });
    void qc.invalidateQueries({ queryKey: ["tracking", orgSlug] });
  };
  const log = useMutation({
    mutationFn: (v: number) => api.logMeasurement(metricId, v),
    onSuccess: () => { setVal(""); invalidate(); },
    onError: (e) => toast.error(e instanceof TrackingApiError ? e.message : String(e)),
  });

  const d = detail.data;
  return (
    <Modal open onClose={onClose} title={d?.name ?? "Metric"} subtitle={d?.goal_value != null ? `goal ${d.goal_value}${d.unit ? ` ${d.unit}` : ""} (${d.goal_direction})` : undefined} size="lg">
      <div className="space-y-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (val !== "") log.mutate(Number(val)); }}>
          <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} type="number" step="any" placeholder={`Log a value${d?.unit ? ` (${d.unit})` : ""}…`} className="flex-1 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-sm" />
          <button type="submit" disabled={val === "" || log.isPending} className="px-3 py-2 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">Log</button>
        </form>

        {d && <ProgressBar p={d.progress} />}
        {d && <Sparkline points={d.measurements} goal={d.goal_value} />}

        {d && d.measurements.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-48 overflow-auto">
            {[...d.measurements].reverse().map((m: Measurement) => (
              <li key={m.id} className="flex justify-between px-3 py-1.5 text-sm">
                <span className="font-medium">{m.value}{d.unit ? ` ${d.unit}` : ""}</span>
                <span className="text-xs text-muted">{new Date(m.measured_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

export default TrackingUI;
