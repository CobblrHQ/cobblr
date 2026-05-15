// Part detail — fields inline-editable, allocations panel below.
// Stock adjustments are explicit (a button) so accidental qty edits
// don't silently rewrite history.

import { useState, type FocusEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { CustomFieldsPanel, EntityActionsBar, useConfirm, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { AllocationsPanel } from "./AllocationsPanel";
import { StockAdjustButton } from "./StockAdjustButton";

export function PartDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useInventory();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const part = useQuery({
    queryKey: ["inventory-part", id],
    queryFn: () => api.getPart(id!),
    enabled: !!id,
  });

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const toast = useToast();
  const confirm = useConfirm();

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updatePart(id!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deletePart(id!),
    onSuccess: () => {
      toast.success("Part deleted.");
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      navigate("/inventory");
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  if (part.isLoading) return <div className="text-sm text-slate-400 dark:text-slate-500">loading…</div>;
  if (part.error) {
    return <div className="text-sm text-ember-500">{(part.error as Error).message}</div>;
  }
  if (!part.data) return null;
  const p = part.data;

  return (
    <div className="space-y-5 max-w-3xl">
      <Link to="/inventory" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-cobble-600">
        <ArrowLeft size={12} /> back to parts
      </Link>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-start gap-3">
          <InlineText
            value={p.name}
            onCommit={(v) => update.mutate({ name: v })}
            className="font-display text-2xl font-bold text-slate-700 dark:text-mortar-100 flex-1"
          />
          <EntityActionsBar entityKind="inventory:part" entityId={p.id} className="mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Qty">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg text-slate-700 dark:text-mortar-100">
                {fmt(p.qty)} {p.unit}
              </span>
              <StockAdjustButton partId={p.id} />
            </div>
          </Field>
          <Field label="Unit">
            <InlineText value={p.unit} onCommit={(v) => update.mutate({ unit: v })} />
          </Field>
          <Field label="Min qty">
            <InlineText
              value={p.min_qty ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ min_qty: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          <Field label="Cost">
            <InlineText
              value={p.cost ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ cost: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          <Field label="Category">
            <select
              value={p.category_id ?? ""}
              onChange={(e) => update.mutate({ category_id: e.target.value || null })}
              className="input"
            >
              <option value="">— none —</option>
              {cats.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location">
            <select
              value={p.location_id ?? ""}
              onChange={(e) => update.mutate({ location_id: e.target.value || null })}
              className="input"
            >
              <option value="">— none —</option>
              {locs.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {"  ".repeat(l.depth)}
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Manufacturer">
            <InlineText
              value={p.manufacturer ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ manufacturer: v || null })}
            />
          </Field>
          <Field label="Supplier URL">
            <InlineText
              value={p.supplier_url ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ supplier_url: v || null })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <InlineTextarea
            value={p.notes ?? ""}
            onCommit={(v) => update.mutate({ notes: v || null })}
          />
        </Field>
      </div>

      <CustomFieldsPanel
        entityKind="inventory:part"
        values={(p.metadata as Record<string, unknown> | null) ?? {}}
        onCommit={(name, value) =>
          update.mutate({
            metadata: {
              ...((p.metadata as Record<string, unknown> | null) ?? {}),
              [name]: value,
            },
          })
        }
      />

      <AllocationsPanel partId={p.id} />

      <div className="text-center pt-4">
        <button
          onClick={async () => {
            const ok = await confirm({
              title: `Delete "${p.name}"?`,
              message: "This can't be undone. Allocations to other modules' entities are released.",
              confirmLabel: "Delete part",
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
          className="text-xs text-slate-400 dark:text-slate-500 hover:text-ember-500 inline-flex items-center gap-1.5"
        >
          <Trash2 size={12} /> Delete this part
        </button>
      </div>
    </div>
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

function InlineText({
  value,
  onCommit,
  placeholder,
  numeric,
  className = "input",
}: {
  value: string | number | null;
  onCommit: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
  className?: string;
}) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  function commit(e: FocusEvent<HTMLInputElement>) {
    if (e.target.value !== initial) onCommit(e.target.value);
  }
  return (
    <input
      type={numeric ? "number" : "text"}
      step={numeric ? "any" : undefined}
      defaultValue={initial}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = initial;
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={className}
      // suppress 'unused var' linter
      data-draft={draft}
    />
  );
}

function InlineTextarea({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  return (
    <textarea
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      rows={3}
      className="input"
    />
  );
}

function fmt(n: number | string): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return String(n);
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
}
