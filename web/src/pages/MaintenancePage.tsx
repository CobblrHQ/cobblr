// /configuration/maintenance — workspace-wide service log. The
// core-maintenance module (foundational) attaches polymorphic
// entries to any entity; the embedded UI on each entity's detail
// page creates them, but there was no place to see everything at
// once. This is that place: what's due, what's overdue, the full
// history — with complete / edit / delete in line.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, History, Pencil, Trash2, Wrench } from "lucide-react";
import { ApiError, api, type MaintenanceEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";

type Kind = "scheduled" | "history" | "all";

export function MaintenancePage() {
  usePageTitle("Maintenance");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState<Kind>("scheduled");
  const [dueWithin, setDueWithin] = useState<number | "any">("any");
  const [editFor, setEditFor] = useState<MaintenanceEntry | null>(null);

  const list = useQuery({
    queryKey: ["maintenance", activeSlug, kind, dueWithin],
    queryFn: () =>
      api.listMaintenance(activeSlug, {
        kind,
        due_within_days:
          kind === "scheduled" && dueWithin !== "any" ? dueWithin : undefined,
      }),
    enabled: !!activeSlug,
  });

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["maintenance", activeSlug] });

  const complete = useMutation({
    mutationFn: (id: string) => api.completeMaintenance(activeSlug, id),
    onSuccess: () => {
      toast.success("Marked done");
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't complete"),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteMaintenance(activeSlug, id),
    onSuccess: () => {
      toast.success("Deleted");
      invalidate();
    },
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">
          maintenance
        </h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          workspace-wide service log — scheduled upkeep + history
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(
            [
              ["scheduled", "Scheduled", CalendarClock],
              ["history", "History", History],
              ["all", "All", Wrench],
            ] as const
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition ${
                kind === k
                  ? "bg-cobble-600 text-white"
                  : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
              }`}
              data-testid={`maint-tab-${k}`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        {kind === "scheduled" && (
          <select
            value={String(dueWithin)}
            onChange={(e) =>
              setDueWithin(
                e.target.value === "any" ? "any" : Number(e.target.value),
              )
            }
            className="text-xs rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-content dark:text-mortar-100"
          >
            <option value="any">any time</option>
            <option value="30">due within 30 days</option>
            <option value="90">due within 90 days</option>
            <option value="365">due within a year</option>
          </select>
        )}
      </div>

      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          {kind === "scheduled"
            ? "Nothing scheduled. Maintenance is added from an item's detail page."
            : kind === "history"
              ? "No service history yet."
              : "No maintenance entries. Add them from any item's detail page."}
        </div>
      )}

      <div className="space-y-2">
        {items.map((e) => (
          <MaintenanceCard
            key={e.id}
            entry={e}
            onComplete={() => complete.mutate(e.id)}
            onEdit={() => setEditFor(e)}
            onDelete={async () => {
              const ok = await confirm({
                title: "Delete this entry?",
                message: `${e.name} — removed from the service log permanently.`,
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) del.mutate(e.id);
            }}
          />
        ))}
      </div>

      {editFor && (
        <EditEntryModal
          slug={activeSlug}
          entry={editFor}
          onClose={() => setEditFor(null)}
          onSaved={() => {
            invalidate();
            setEditFor(null);
          }}
        />
      )}
    </div>
  );
}

function MaintenanceCard({
  entry,
  onComplete,
  onEdit,
  onDelete,
}: {
  entry: MaintenanceEntry;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const done = !!entry.performed_at;
  const due = entry.scheduled_at ? dueState(entry.scheduled_at, done) : null;
  return (
    <div
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3"
      data-testid="maint-card"
      data-entry-id={entry.id}
    >
      <div className="flex items-start gap-2">
        <Wrench size={15} className="text-accent mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-content dark:text-mortar-100">
              {entry.name}
            </span>
            <span className="text-[10px] font-mono text-faint dark:text-slate-500">
              {entry.entity_module}·{entry.entity_type}
            </span>
            {due && (
              <span
                className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${due.cls}`}
              >
                {due.label}
              </span>
            )}
          </div>
          {entry.description && (
            <div className="text-xs text-content dark:text-mortar-200 mt-0.5">
              {entry.description}
            </div>
          )}
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 mt-1 flex flex-wrap gap-x-3">
            {entry.scheduled_at && (
              <span>
                due {new Date(entry.scheduled_at).toLocaleDateString()}
              </span>
            )}
            {entry.performed_at && (
              <span>
                done {new Date(entry.performed_at).toLocaleDateString()}
              </span>
            )}
            {entry.cost_cents != null && (
              <span>${(entry.cost_cents / 100).toFixed(2)}</span>
            )}
            {entry.recurrence_rule && <span>↻ {entry.recurrence_rule}</span>}
          </div>
          {entry.notes && (
            <div className="text-xs text-muted dark:text-slate-400 mt-1 italic">
              {entry.notes}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {entry.scheduled_at && !done && (
            <button
              onClick={onComplete}
              className="inline-flex items-center gap-1 text-xs rounded px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white transition"
              title="Mark done (records performed_at = now)"
              data-testid="maint-complete"
            >
              <Check size={12} /> Done
            </button>
          )}
          <button
            onClick={onEdit}
            className="text-faint hover:text-accent transition p-1"
            title="Edit"
            data-testid="maint-edit"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onDelete}
            className="text-faint hover:text-ember-500 transition p-1"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function dueState(
  scheduledAt: string,
  done: boolean,
): { label: string; cls: string } | null {
  if (done) return null;
  const due = new Date(scheduledAt).getTime();
  const now = Date.now();
  const days = Math.round((due - now) / 86_400_000);
  if (days < 0)
    return {
      label: `overdue ${-days}d`,
      cls: "bg-ember-100 dark:bg-ember-900/40 text-ember-700 dark:text-ember-300",
    };
  if (days <= 14)
    return {
      label: days === 0 ? "due today" : `in ${days}d`,
      cls: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
    };
  return null;
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function EditEntryModal({
  slug,
  entry,
  onClose,
  onSaved,
}: {
  slug: string;
  entry: MaintenanceEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(entry.name);
  const [scheduledAt, setScheduledAt] = useState(
    isoToLocalInput(entry.scheduled_at),
  );
  const [performedAt, setPerformedAt] = useState(
    isoToLocalInput(entry.performed_at),
  );
  const [costDollars, setCostDollars] = useState(
    entry.cost_cents != null ? (entry.cost_cents / 100).toFixed(2) : "",
  );
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [rule, setRule] = useState(entry.recurrence_rule ?? "");

  const save = useMutation({
    mutationFn: () => {
      const cents = costDollars.trim()
        ? Math.round(Number(costDollars) * 100)
        : null;
      return api.updateMaintenance(slug, entry.id, {
        name: name.trim(),
        scheduled_at: scheduledAt
          ? new Date(scheduledAt).toISOString()
          : null,
        performed_at: performedAt
          ? new Date(performedAt).toISOString()
          : null,
        cost_cents: Number.isFinite(cents as number) ? cents : null,
        notes: notes.trim() || null,
        recurrence_rule: rule.trim() || null,
      });
    },
    onSuccess: () => {
      toast.success("Entry updated");
      onSaved();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save"),
  });

  const valid =
    name.trim() !== "" && (scheduledAt !== "" || performedAt !== "");

  return (
    <Modal open onClose={onClose} title={`Edit — ${entry.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
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
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-xs text-muted mb-1">Scheduled</div>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Performed</div>
            <input
              type="datetime-local"
              value={performedAt}
              onChange={(e) => setPerformedAt(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        </div>
        <p className="text-[11px] text-faint -mt-1">
          One of scheduled / performed is required. Set performed to log it as
          done.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-xs text-muted mb-1">Cost (USD)</div>
            <input
              type="number"
              step="0.01"
              min="0"
              value={costDollars}
              onChange={(e) => setCostDollars(e.target.value)}
              placeholder="0.00"
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">
              Recurrence (RRULE)
            </div>
            <input
              type="text"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder="FREQ=MONTHLY"
              className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            />
          </label>
        </div>
        <label className="block">
          <div className="text-xs text-muted mb-1">Notes</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || save.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
