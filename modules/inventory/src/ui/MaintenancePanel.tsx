import { fieldNeed, FieldPack, RecordFormModal, MoneyInput, useConfirm, useToast, MutationError, noteWorkspaceWrite } from "@cobblr/platform-web";
// Per-part maintenance panel — lists scheduled + history entries
// from core-maintenance. Add an entry as "done now", "scheduled
// later", or both (something done with a follow-up).
//
// Self-contained — fetches core-maintenance directly via the
// inventory module's orgSlug + getToken. When other modules need
// the same surface, lift this to platform-web.

import { dayHere } from "@cobblr/platform-contract/day";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, CheckCircle, History, Plus, Trash2 } from "lucide-react";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
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
  /** Where an open entry stands, counted by the server in this browser's
   *  zone: the same count the record's schedule and the Maintenance page show. */
  due?: { state: "ok" | "due-soon" | "overdue"; reason: string; days: number };
  created_at: string;
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
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
    ...(browserTimeZone() ? { tz: browserTimeZone()! } : {}),
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
      noteWorkspaceWrite(`${base}/${id}/complete`, res);
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
      noteWorkspaceWrite(`${base}/${id}`, res);
    },
    onSuccess: () => {
      toast.success("Entry deleted.");
      void qc.invalidateQueries({
        queryKey: ["maintenance", orgSlug, entityModule, entityType, entityId],
      });
    },
  });

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          maintenance
        </h3>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent inline-flex items-center gap-1"
        >
          <Plus size={11} /> add
        </button>
      </div>

      {list.isLoading && <div className="text-xs text-faint">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-faint italic">
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

      <MutationError mutation={complete} className="block" />
      <MutationError mutation={remove} className="block" />
      {history.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1.5 flex items-center gap-1">
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
  const days = entry.due?.days ?? null;
  const overdue = days != null && days < 0;

  return (
    <li className="rounded-md border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/40 p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 truncate">
            {entry.name}
          </div>
          <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">
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
                  : `due ${new Date(entry.scheduled_at).toLocaleDateString()}${days != null ? ` (${days}d)` : ""}`}
              </span>
            )}
            {entry.cost_cents != null && (
              <span> · {formatStoredMoney(entry.cost_cents, "cents")}</span>
            )}
          </div>
          {entry.description && (
            <div className="text-[11px] text-muted dark:text-slate-400 mt-1">
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
            className="text-faint hover:text-ember-500"
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
  // The person's own day, not the UTC one: at 8pm in the Americas this used
  // to pre-fill tomorrow's date on a form about something done today (#3351).
  const [performedAt, setPerformedAt] = useState(dayHere());
  const [scheduledAt, setScheduledAt] = useState("");
  const [cost, setCost] = useState<number | null>(null);
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
        cost_cents: cost,
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
      noteWorkspaceWrite(`/api/v1/orgs/${orgSlug}/modules/core-maintenance/entries`, res);
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
    <RecordFormModal open onClose={onClose} title="Add maintenance entry" dismissOnBackdrop={false}>
      <form onSubmit={submit} className="space-y-3">
        <FieldPack items={[
          {
            need: fieldNeed("name", { control: "text", label: "What" }),
            node: (
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
            ),
          },
          {
            need: fieldNeed("description", { control: "markdown", label: "Details (optional)" }),
            node: (
              <Field label="Details (optional)">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="input"
                />
              </Field>
            ),
          },
          {
            need: { ...fieldNeed("type", { control: "choice", label: "Type" }), full: true },
            node: (
              <Field label="Type">
                <div className="flex gap-2 text-xs">
                  {(["done", "scheduled", "both"] as const).map((k) => (
                    <label
                      key={k}
                      className={
                        "px-2 py-1 rounded-md border cursor-pointer " +
                        (kind === k
                          ? "border-accent bg-cobble-50 dark:bg-cobble-950/30 text-accent dark:text-cobble-300"
                          : "border-line dark:border-slate-700 text-muted")
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
            ),
          },
        ]} />
        <FieldPack items={[
          ((kind === "done" || kind === "both")) ? {
            need: fieldNeed("performedAt", { control: "date", label: "Performed at" }),
            node: (
              <Field label="Performed at">
                <input
                  type="date"
                  value={performedAt}
                  onChange={(e) => setPerformedAt(e.target.value)}
                  className="input"
                  required
                />
              </Field>
            ),
          } : null,
          ((kind === "scheduled" || kind === "both")) ? {
            need: fieldNeed("scheduledAt", { control: "date", label: "Scheduled for" }),
            node: (
              <Field label="Scheduled for">
                <input
                  type="date"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="input"
                  required
                />
              </Field>
            ),
          } : null,
          {
            need: fieldNeed("cost", { control: "money", label: "Cost" }),
            node: (
              <Field label="Cost">
                <MoneyInput value={cost} storage="cents" live onCommit={setCost} placeholder="—" ariaLabel="Cost" />
              </Field>
            ),
          },
        ]} />
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content py-2"
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
    </RecordFormModal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
