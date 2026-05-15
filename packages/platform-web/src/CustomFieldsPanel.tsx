// Renders bundle-installed / module-contributed / org-authored
// field-defs as editable inputs. The host owns persistence — it
// gets an onCommit callback with the field name + new value, and
// decides where to stash it (usually `metadata.<name>` on the
// entity).
//
// type='text' field-defs with a `choices` array render as a
// dropdown with an inline "+ add new" affordance that appends to
// the choices via api.appendFieldDefChoice (if the host adapter
// implements it).

import { useMemo, useState, type FocusEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { PlatformFieldDef } from "./types";

interface Props {
  entityKind: string;
  values: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
  className?: string;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

export function CustomFieldsPanel({ entityKind, values, onCommit, className }: Props) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind],
    queryFn: () => api.listFieldDefs(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const [showAll, setShowAll] = useState(false);
  const fields = useMemo(
    () => (data?.items ?? []).slice().sort((a, b) => a.position - b.position),
    [data],
  );

  // A kind shared by several modules (e.g. machines:machine, extended
  // by 3d-printers / laser-cutters / cnc-machines) accumulates every
  // specialisation's field-defs. Rendering all of them on every
  // entity means a 3D printer shows empty "focal length" / "tube
  // type" inputs. So: always show fields that have a value, plus any
  // field not contributed by a module (org-authored / bundle fields
  // the user opted into). Empty module-contributed fields collapse
  // behind a toggle.
  const { shown, hidden } = useMemo(() => {
    const shown: PlatformFieldDef[] = [];
    const hidden: PlatformFieldDef[] = [];
    for (const f of fields) {
      if (!f.source_module || !isBlank(values[f.name])) shown.push(f);
      else hidden.push(f);
    }
    return { shown, hidden };
  }, [fields, values]);

  if (fields.length === 0) return null;
  const visible = showAll ? fields : shown;
  return (
    <div
      className={
        "rounded-xl border border-cobble-200 dark:border-cobble-700 bg-cobble-50/50 dark:bg-slate-900 p-5 space-y-3 " +
        (className ?? "")
      }
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-600">
        // custom fields
      </div>
      {visible.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {visible.map((f) => (
            <FieldRow
              key={f.id}
              def={f}
              value={values[f.name]}
              onCommit={(v) => onCommit(f.name, v)}
            />
          ))}
        </div>
      )}
      {visible.length === 0 && !showAll && (
        <div className="text-[11px] text-slate-400 dark:text-slate-500 italic">
          No fields set.
        </div>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono uppercase tracking-widest text-cobble-600 hover:text-cobble-700 transition"
        >
          {showAll
            ? "− hide empty fields"
            : `+ ${hidden.length} more field${hidden.length === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

function FieldRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  // Dropdown branch — type='text' with choices.
  if (def.type === "text" && def.choices && def.choices.length > 0) {
    return <ChoiceRow def={def} value={value} onCommit={onCommit} />;
  }
  return <PlainRow def={def} value={value} onCommit={onCommit} />;
}

function PlainRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  function commit(e: FocusEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (next === initial) return;
    if (def.type === "number") {
      onCommit(next === "" ? null : Number(next));
    } else if (def.type === "boolean") {
      onCommit(next === "true");
    } else {
      onCommit(next === "" ? null : next);
    }
  }
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <input
        type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
        defaultValue={initial}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="input"
        data-draft={draft}
      />
    </label>
  );
}

const ADD_NEW = "__add_new__";

function ChoiceRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const current = value == null ? "" : String(value);
  const [pendingNew, setPendingNew] = useState<string | null>(null);
  const append = useMutation({
    mutationFn: (newVal: string) =>
      api.appendFieldDefChoice
        ? api.appendFieldDefChoice(orgSlug, def.id, newVal)
        : Promise.reject(new Error("Adapter doesn't support appendFieldDefChoice")),
    onSuccess: (updated, newVal) => {
      void qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug, def.entity_kind] });
      onCommit(newVal);
      setPendingNew(null);
      // updated has the new choices array; the invalidate above
      // refreshes the dropdown options.
      void updated;
    },
    onError: () => setPendingNew(null),
  });

  if (pendingNew !== null) {
    return (
      <label className="block">
        <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
          {def.display_label}{" "}
          <span className="text-cobble-500">— new value</span>
        </span>
        <input
          type="text"
          autoFocus
          value={pendingNew}
          onChange={(e) => setPendingNew(e.target.value)}
          onBlur={() => {
            const v = pendingNew.trim();
            if (v) append.mutate(v);
            else setPendingNew(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setPendingNew(null);
          }}
          className="input"
        />
      </label>
    );
  }

  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <select
        value={current || ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === ADD_NEW) {
            setPendingNew("");
            return;
          }
          onCommit(v === "" ? null : v);
        }}
        className="input"
      >
        <option value="">—</option>
        {def.choices!.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        {/* current value isn't in choices? show it anyway so we don't
            silently lose it. */}
        {current && !def.choices!.includes(current) && (
          <option value={current}>{current} (legacy)</option>
        )}
        {api.appendFieldDefChoice && (
          <option value={ADD_NEW}>+ add new…</option>
        )}
      </select>
    </label>
  );
}
