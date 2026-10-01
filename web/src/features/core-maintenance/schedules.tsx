// "Service every… [3] [months ▾]" on a record (#3876).
//
// A record's recurring maintenance, in one small panel: each schedule says
// its rule in words and where it stands ("due in 5 days", "overdue by 3.5
// print hours"), and one row sets a new one. The interval picker offers the
// calendar units and, after them, the counters this record's kind keeps
// (a printer's print hours and prints), so "every 200 print hours" is the
// same gesture as "every 3 months". Logging the service with the strip's
// Log service rolls the schedule forward, and so does Done on the schedule
// itself. Each schedule can be changed in place, and the record's service
// history (what was done, when, what it cost) reads underneath.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, History, Loader2, Pencil, Trash2 } from "lucide-react";
import { ChoiceCombobox, useToast, type ChoiceOption } from "@cobblr/platform-web";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { api, type MaintenanceIntervalUnit, type MaintenanceSchedule } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";

const UNITS: Array<{ value: MaintenanceIntervalUnit; one: string; many: string }> = [
  { value: "day", one: "day", many: "days" },
  { value: "week", one: "week", many: "weeks" },
  { value: "month", one: "month", many: "months" },
  { value: "year", one: "year", many: "years" },
];

const STATE_STYLE: Record<MaintenanceSchedule["due"]["state"], string> = {
  ok: "text-muted dark:text-slate-400",
  "due-soon": "text-ember-700 dark:text-ember-300",
  overdue: "text-ember-700 dark:text-ember-300 font-medium",
};

function lastDone(s: MaintenanceSchedule): string | null {
  if (!s.last_done_at) return null;
  return `last done ${new Date(s.last_done_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function MaintenanceSchedulesPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const qc = useQueryClient();
  const toast = useToast();
  const kind = ctx.kind ?? "";
  const [entityModule, entityType] = kind.includes(":") ? kind.split(":") : [kind, kind];
  const key = ["maintenance-schedules", ctx.slug, ctx.entityId];

  const schedulesQ = useQuery({
    queryKey: key,
    queryFn: () => api.listMaintenanceSchedules(ctx.slug, ctx.entityId),
    meta: { kinds: kind ? [kind] : [] },
  });
  const countersQ = useQuery({
    queryKey: ["maintenance-counters", ctx.slug, kind, ctx.entityId],
    queryFn: () => api.maintenanceCounters(ctx.slug, kind, ctx.entityId),
    enabled: !!kind,
    staleTime: 60_000,
  });
  const counters = countersQ.data?.counters ?? [];
  // "What needs doing" offers the jobs this kind of record has had and the
  // ones its table ships with; a job typed once is offered from then on.
  const namesQ = useQuery({
    queryKey: ["maintenance-names", ctx.slug, kind],
    queryFn: () => api.maintenanceServiceNames(ctx.slug, kind),
    enabled: !!kind,
    staleTime: 60_000,
  });
  const jobOptions: ChoiceOption[] = [
    ...(namesQ.data?.values ?? []),
    ...(namesQ.data?.suggested ?? []).map((value) => ({ value })),
  ];

  const [name, setName] = useState("");
  const [everyText, setEveryText] = useState("");
  const [unit, setUnit] = useState<string>("month");
  const [lastText, setLastText] = useState("");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["attention"] });
    void qc.invalidateQueries({ queryKey: ["maintenance-names", ctx.slug, kind] });
  };

  const create = useMutation({
    mutationFn: () => {
      const n = Number(everyText);
      const counter = counters.find((c) => c.key === unit);
      return api.createMaintenanceSchedule(ctx.slug, {
        entity_module: entityModule ?? kind,
        entity_type: entityType ?? kind,
        entity_id: ctx.entityId,
        name: name.trim(),
        ...(counter ? { counter_field: counter.key, counter_every: n } : { every_n: Math.round(n), every_unit: unit as MaintenanceIntervalUnit }),
        ...(lastText ? { last_done_at: new Date(`${lastText}T12:00:00`).toISOString() } : {}),
      });
    },
    onSuccess: (s) => {
      toast.success(`${s.name}: ${s.rule}.`);
      setName("");
      setEveryText("");
      setLastText("");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set the schedule"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMaintenanceSchedule(ctx.slug, id),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove the schedule"),
  });
  const historyKey = ["maintenance-history", ctx.slug, ctx.entityId];
  const historyQ = useQuery({
    queryKey: historyKey,
    queryFn: () => api.listMaintenance(ctx.slug, { kind: "history", entity_id: ctx.entityId, limit: 10 }),
  });
  const done = useMutation({
    mutationFn: (s: MaintenanceSchedule) =>
      api.logMaintenance(ctx.slug, {
        entity_module: s.entity_module,
        entity_type: s.entity_type,
        entity_id: s.entity_id,
        name: s.name,
        performed_at: new Date().toISOString(),
        schedule_id: s.id,
      }),
    onSuccess: (_e, s) => {
      toast.success(`${s.name} done. The next one is scheduled.`);
      refresh();
      void qc.invalidateQueries({ queryKey: historyKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't log it"),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (v: { id: string; name: string; n: number; unit: string }) => {
      const counter = counters.find((c) => c.key === v.unit);
      return api.updateMaintenanceSchedule(ctx.slug, v.id, {
        name: v.name,
        ...(counter
          ? { counter_field: counter.key, counter_every: v.n, every_n: null, every_unit: null }
          : { every_n: Math.round(v.n), every_unit: v.unit as MaintenanceIntervalUnit, counter_field: null, counter_every: null }),
      });
    },
    onSuccess: (s) => {
      toast.success(`${s.name}: ${s.rule}.`);
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't change the schedule"),
  });

  const every = Number(everyText);
  const ready = name.trim().length > 0 && Number.isFinite(every) && every > 0;
  const schedules = schedulesQ.data?.items ?? [];
  const input =
    "rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-1.5 text-base text-content dark:text-slate-100";

  return (
    <div data-testid="maintenance-schedules" className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
        <CalendarClock size={12} aria-hidden /> {"// service schedule"}
      </div>

      {schedulesQ.isLoading ? (
        <Loader2 size={14} className="animate-spin text-faint" />
      ) : schedules.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400">Nothing scheduled. Set how often this wants servicing and it will come up on its own.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((s) =>
            editing === s.id ? (
              <li key={s.id}>
                <EditSchedule
                  schedule={s}
                  jobs={jobOptions}
                  counters={counters}
                  input={input}
                  pending={edit.isPending}
                  onCancel={() => setEditing(null)}
                  onSave={(v) => edit.mutate({ id: s.id, ...v })}
                />
              </li>
            ) : (
            <li key={s.id} className="flex items-start gap-2 rounded-lg border border-line/70 dark:border-slate-700/70 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-content dark:text-slate-100 truncate">{s.name}</div>
                <div className="text-xs text-muted dark:text-slate-400">
                  {s.rule}
                  {lastDone(s) ? ` · ${lastDone(s)}` : ""}
                </div>
                <div className={`text-xs ${STATE_STYLE[s.due.state]}`}>{s.due.reason}</div>
              </div>
              <button
                type="button"
                onClick={() => done.mutate(s)}
                disabled={done.isPending}
                aria-label={`${s.name} done today`}
                title="Done today: logs it and schedules the next one"
                className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-1 text-xs bg-moss-600 text-white hover:bg-moss-700 disabled:opacity-50"
              >
                <Check size={12} /> Done
              </button>
              <button
                type="button"
                onClick={() => setEditing(s.id)}
                aria-label={`Change ${s.name}`}
                title="Change how often"
                className="shrink-0 p-1 text-faint hover:text-accent transition"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => remove.mutate(s.id)}
                disabled={remove.isPending}
                aria-label={`Stop scheduling ${s.name}`}
                title="Stop scheduling this"
                className="shrink-0 p-1 text-faint hover:text-ember-600 transition"
              >
                <Trash2 size={14} />
              </button>
            </li>
            ),
          )}
        </ul>
      )}

      {(historyQ.data?.items.length ?? 0) > 0 && (
        <div data-testid="maintenance-history" className="space-y-1">
          <div className="flex items-center gap-1 text-xs text-muted dark:text-slate-400">
            <History size={12} aria-hidden /> Done before
          </div>
          <ul className="space-y-0.5 text-xs text-content dark:text-slate-200">
            {historyQ.data!.items.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{h.name}</span>
                <span className="text-muted">{h.performed_at ? new Date(h.performed_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""}</span>
                {h.cost_cents != null && <span className="text-muted">{formatStoredMoney(h.cost_cents, "cents")}</span>}
                {h.notes && <span className="text-muted italic truncate">{h.notes}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
        className="space-y-2 border-t border-line/60 dark:border-slate-700/60 pt-3"
      >
        <div className="block space-y-1">
          <span className="text-xs text-muted dark:text-slate-400">What needs doing</span>
          <ChoiceCombobox
            label="What needs doing"
            value={name || null}
            options={jobOptions}
            onCommit={(v) => setName(v ?? "")}
            live
            placeholder="e.g. Oil change"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-content dark:text-slate-200">Service every</span>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            aria-label="How many"
            value={everyText}
            onChange={(e) => setEveryText(e.target.value)}
            placeholder="3"
            className={`${input} w-20`}
          />
          <select aria-label="Of what" value={unit} onChange={(e) => setUnit(e.target.value)} className={input}>
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {every === 1 ? u.one : u.many}
              </option>
            ))}
            {counters.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
                {c.value != null ? ` (now ${Math.round(c.value * 10) / 10})` : ""}
              </option>
            ))}
          </select>
        </div>
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted dark:text-slate-400">Last done (if you know)</span>
          <input type="date" value={lastText} onChange={(e) => setLastText(e.target.value)} className={input} />
        </label>
        <button
          type="submit"
          disabled={!ready || create.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Set schedule"}
        </button>
      </form>
    </div>
  );
}

function EditSchedule({
  schedule,
  jobs,
  counters,
  input,
  pending,
  onCancel,
  onSave,
}: {
  schedule: MaintenanceSchedule;
  jobs: ChoiceOption[];
  counters: Array<{ key: string; label: string; value: number | null }>;
  input: string;
  pending: boolean;
  onCancel: () => void;
  onSave: (v: { name: string; n: number; unit: string }) => void;
}) {
  const [name, setName] = useState(schedule.name);
  const [n, setN] = useState(String(schedule.counter_field ? schedule.counter_every ?? "" : schedule.every_n ?? ""));
  const [unit, setUnit] = useState<string>(schedule.counter_field ?? schedule.every_unit ?? "month");
  const num = Number(n);
  const ok = name.trim().length > 0 && Number.isFinite(num) && num > 0;
  return (
    <form
      data-testid="maintenance-schedule-edit"
      className="space-y-2 rounded-lg border border-accent/50 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !pending) onSave({ name: name.trim(), n: num, unit });
      }}
    >
      <ChoiceCombobox label="What needs doing" value={name || null} options={jobs} onCommit={(v) => setName(v ?? "")} live />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Every</span>
        <input type="number" inputMode="decimal" min={1} aria-label="How many" value={n} onChange={(e) => setN(e.target.value)} className={`${input} w-20`} />
        <select aria-label="Of what" value={unit} onChange={(e) => setUnit(e.target.value)} className={input}>
          {UNITS.map((u) => (
            <option key={u.value} value={u.value}>{num === 1 ? u.one : u.many}</option>
          ))}
          {counters.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={!ok || pending} className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
        <button type="button" onClick={onCancel} className="text-sm text-muted">Cancel</button>
      </div>
    </form>
  );
}
