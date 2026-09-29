// "Service every… [3] [months ▾]" on a record (#3876).
//
// A record's recurring maintenance, in one small panel: each schedule says
// its rule in words and where it stands ("due in 5 days", "overdue by 3.5
// print hours"), and one row sets a new one. The interval picker offers the
// calendar units and, after them, the counters this record's kind keeps
// (a printer's print hours and prints), so "every 200 print hours" is the
// same gesture as "every 3 months". Logging the service with the strip's
// Log service rolls the schedule forward; nothing here needs pressing for it.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
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

  const [name, setName] = useState("");
  const [everyText, setEveryText] = useState("");
  const [unit, setUnit] = useState<string>("month");
  const [lastText, setLastText] = useState("");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["attention"] });
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
          {schedules.map((s) => (
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
                onClick={() => remove.mutate(s.id)}
                disabled={remove.isPending}
                aria-label={`Stop scheduling ${s.name}`}
                title="Stop scheduling this"
                className="shrink-0 p-1 text-faint hover:text-ember-600 transition"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !create.isPending) create.mutate();
        }}
        className="space-y-2 border-t border-line/60 dark:border-slate-700/60 pt-3"
      >
        <label className="block space-y-1">
          <span className="text-xs text-muted dark:text-slate-400">What needs doing</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Oil change"
            className={`${input} w-full`}
          />
        </label>
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
