// Per-part maintenance panel — lists scheduled + history entries
// from core-maintenance. Add an entry as "done now", "scheduled
// later", or both (something done with a follow-up).
//
// Self-contained — fetches core-maintenance directly via the
// inventory module's orgSlug + getToken. When other modules need
// the same surface, lift this to platform-web.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, CheckCircle, History, Plus, Trash2 } from "lucide-react";
import { Modal, useConfirm, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";

interface MaintenanceEntry {
  id: string;
  name: string;
  description: string | null;
  performed_at: string | null;
  scheduled_at: string | null;
  cost_cents: number | null;
  notes: string | null;
  recurrence_rule: string | null;
  created_at: string;
}

interface Props {
  /** Polymorphic owner module — `inventory` for parts. */
  entityModule: string;
  /** Polymorphic owner type — `part` for inventory:part. */
  entityType: string;
  /** UUID of the entity. */
  entityId: string;
}

export function MaintenancePanel({ entityModule, entityType, entityId }: Props) {
  const { orgSlug, getToken } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  const base = `/api/v1/orgs/${orgSlug}/modules/core-maintenance/entries`;
  const params = new URLSearchParams({
    entity_module: entityModule,
    entity_type: entityType,
    entity_id: entityId,
  });

  const list = useQuery({
    queryKey: ["maintenance", orgSlug, entityModule, entityType, entityId],
    queryFn: async () => {
      const res = await fetch(`${base}?${params.toString()}`, { headers: auth() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { items: MaintenanceEntry[] };
    },
    enabled: !!orgSlug,
  });

  const items = list.data?.items ?? [];
  const scheduled = items.filter((e) => e.scheduled_at && !e.performed_at);
  const history = items.filter((e) => e.performed_at);

  const complete = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/${id}/complete`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast.success("Marked done.");
      void qc.invalidateQueries({
        queryKey: ["maintenance", orgSlug, entityModule, entityType, entityId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/${id}`, { method: "DELETE", headers: auth() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast.success("Entry deleted.");
      void qc.invalidateQueries({
        queryKey: ["maintenance", orgSlug, entityModule, entityType, entityId],
      });
    },
  });

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
          maintenance
        </h3>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-[11px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-700 inline-flex items-center gap-1"
        >
          <Plus size={11} /> add
        </button>
      </div>

      {list.isLoading && <div className="text-xs text-slate-400">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-slate-400 italic">
          No maintenance log yet. Track service history, scheduled
          tasks, warranty renewals.
        </div>
      )}

      {scheduled.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-amber-600 mb-1.5 flex items-center gap-1">
            <Calendar size={10} /> scheduled
          </div>
          <ul className="space-y-1.5">
            {scheduled.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                onComplete={() => complete.mutate(e.id)}
                onDelete={async () => {
                  const ok = await confirm({
                    title: "Delete entry?",
                    message: e.name,
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) remove.mutate(e.id);
                }}
              />
            ))}
          </ul>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1.5 flex items-center gap-1">
            <History size={10} /> history
          </div>
          <ul className="space-y-1.5">
            {history.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                onDelete={async () => {
                  const ok = await confirm({
                    title: "Delete entry?",
                    message: e.name,
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) remove.mutate(e.id);
                }}
              />
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddEntryModal
          entityModule={entityModule}
          entityType={entityType}
          entityId={entityId}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function EntryRow({
  entry,
  onComplete,
  onDelete,
}: {
  entry: MaintenanceEntry;
  onComplete?: () => void;
  onDelete: () => void;
}) {
  const due = entry.scheduled_at && !entry.performed_at;
  const ms = entry.scheduled_at
    ? new Date(entry.scheduled_at).getTime() - Date.now()
    : null;
  const days = ms != null ? Math.ceil(ms / 86_400_000) : null;
  const overdue = days != null && days < 0;

  return (
    <li className="rounded-md border border-slate-200 dark:border-slate-700 bg-mortar-50/50 dark:bg-slate-800/40 p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-slate-700 dark:text-mortar-100 truncate">
            {entry.name}
          </div>
          <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
            {entry.performed_at && (
              <span>
                done {new Date(entry.performed_at).toLocaleDateString()}
              </span>
            )}
            {entry.performed_at && entry.scheduled_at && <span> · </span>}
            {entry.scheduled_at && due && (
              <span className={overdue ? "text-ember-500" : days != null && days <= 30 ? "text-amber-600" : ""}>
                {overdue
                  ? `overdue ${-days!}d`
                  : `due ${new Date(entry.scheduled_at).toLocaleDateString()} (${days}d)`}
              </span>
            )}
            {entry.cost_cents != null && (
              <span> · ${(entry.cost_cents / 100).toFixed(2)}</span>
            )}
          </div>
          {entry.description && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              {entry.description}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onComplete && (
            <button
              type="button"
              onClick={onComplete}
              className="text-moss-600 hover:text-moss-700"
              title="Mark done"
            >
              <CheckCircle size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="text-slate-400 hover:text-ember-500"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </li>
  );
}

function AddEntryModal({
  entityModule,
  entityType,
  entityId,
  onClose,
}: {
  entityModule: string;
  entityType: string;
  entityId: string;
  onClose: () => void;
}) {
  const { orgSlug, getToken } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"done" | "scheduled" | "both">("done");
  const [performedAt, setPerformedAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [scheduledAt, setScheduledAt] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        entity_module: entityModule,
        entity_type: entityType,
        entity_id: entityId,
        name: name.trim(),
        description: description.trim() || null,
        cost_cents: cost.trim() === "" ? null : Math.round(Number(cost) * 100),
      };
      if (kind === "done" || kind === "both") body.performed_at = performedAt;
      if (kind === "scheduled" || kind === "both") body.scheduled_at = scheduledAt;
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/core-maintenance/entries`,
        {
          method: "POST",
          headers: { ...auth(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(err.error?.message ?? `HTTP ${res.status}`);
      }
      toast.success("Maintenance entry added.");
      void qc.invalidateQueries({
        queryKey: ["maintenance", orgSlug, entityModule, entityType, entityId],
      });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add maintenance entry" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <Field label="What">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="e.g. Belt tension check, oil change, fuse replace"
          />
        </Field>
        <Field label="Details (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="input"
          />
        </Field>
        <Field label="Type">
          <div className="flex gap-2 text-xs">
            {(["done", "scheduled", "both"] as const).map((k) => (
              <label
                key={k}
                className={
                  "px-2 py-1 rounded-md border cursor-pointer " +
                  (kind === k
                    ? "border-cobble-400 bg-cobble-50 dark:bg-cobble-950/30 text-cobble-700 dark:text-cobble-300"
                    : "border-slate-200 dark:border-slate-700 text-slate-500")
                }
              >
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="sr-only"
                />
                {k === "done" ? "did it" : k === "scheduled" ? "upcoming" : "did it + schedule next"}
              </label>
            ))}
          </div>
        </Field>
        {(kind === "done" || kind === "both") && (
          <Field label="Performed at">
            <input
              type="date"
              value={performedAt}
              onChange={(e) => setPerformedAt(e.target.value)}
              className="input"
              required
            />
          </Field>
        )}
        {(kind === "scheduled" || kind === "both") && (
          <Field label="Scheduled for">
            <input
              type="date"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="input"
              required
            />
          </Field>
        )}
        <Field label="Cost (USD)">
          <input
            type="number"
            step="0.01"
            min="0"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            className="input"
            placeholder="—"
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-600 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 disabled:opacity-50"
          >
            {busy ? "saving…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
