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
import { FieldRenderer } from "./FieldRenderer";

interface Props {
  entityKind: string;
  values: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
  className?: string;
  /** When this entity already exists, its id. Lets the panel resolve
   *  COMPUTED field values (rendered server-side) so they display here
   *  the same as on list/views. Omit for a not-yet-saved draft — computed
   *  fields simply show "—" until the entity exists. */
  entityId?: string;
  /** Secondary value source — used when the local `values[name]` is
   *  blank. The typical source is the payload of a catalog entry the
   *  entity matches: e.g. an inventory:part with no local `year` set
   *  falls back to the Rebrickable sets entry's `year` field.
   *
   *  Visually, fallback values are shown in italic + with a "from
   *  {fallbackLabel}" hint so the user knows it's not their own data.
   *  Editing the field commits the value locally — no in-place mutation
   *  of the fallback source. */
  fallbackValues?: Record<string, unknown>;
  fallbackLabel?: string;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

export function CustomFieldsPanel({
  entityKind,
  values,
  onCommit,
  className,
  fallbackValues,
  fallbackLabel,
  entityId,
}: Props) {
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

  // Computed fields are rendered server-side at resolve time, so for a
  // saved entity we fetch the resolved view to display them. Only runs
  // when the kind actually has a computed field AND the entity exists.
  const hasComputed = useMemo(() => fields.some((f) => f.type === "computed"), [fields]);
  const resolved = useQuery({
    queryKey: ["platform-resolved-entity", orgSlug, entityKind, entityId],
    queryFn: () => api.lookupEntity(orgSlug, entityKind, entityId!),
    enabled: !!entityId && hasComputed,
    staleTime: 10_000,
  });
  const computedValues = (resolved.data?.fields ?? {}) as Record<string, unknown>;

  // A kind shared by several modules (e.g. machines:machine, extended
  // by 3d-printers / laser-cutters / cnc-machines) accumulates every
  // specialisation's field-defs. Rendering all of them on every
  // entity means a 3D printer shows empty "focal length" / "tube
  // type" inputs. So: always show fields that have a value, plus any
  // field not contributed by a module (org-authored / bundle fields
  // the user opted into). Empty module-contributed fields collapse
  // behind a toggle.
  // Treat a field with a fallback value as not-empty — keeps catalog-
  // sourced data out of the "collapse if blank" bucket so it's
  // actually visible to the user.
  const hasValueOrFallback = (name: string) =>
    !isBlank(values[name]) || !isBlank(fallbackValues?.[name]);
  const { shown, hidden } = useMemo(() => {
    const shown: PlatformFieldDef[] = [];
    const hidden: PlatformFieldDef[] = [];
    for (const f of fields) {
      if (!f.source_module || hasValueOrFallback(f.name)) shown.push(f);
      else hidden.push(f);
    }
    return { shown, hidden };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, values, fallbackValues]);

  if (fields.length === 0) return null;
  const visible = showAll ? fields : shown;
  return (
    // No "// custom fields" box or header: to the user there's no stock-vs-custom
    // distinction — every field they configured is just a field, rendered in the
    // same grid as the module's native ones.
    <div className={"space-y-3 " + (className ?? "")}>
      {visible.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {visible.map((f) => (
            <FieldRow
              key={f.id}
              def={f}
              value={f.type === "computed" ? computedValues[f.name] : values[f.name]}
              fallbackValue={fallbackValues?.[f.name]}
              fallbackLabel={fallbackLabel}
              onCommit={(v) => onCommit(f.name, v)}
            />
          ))}
        </div>
      )}
      {visible.length === 0 && !showAll && (
        <div className="text-[11px] text-faint dark:text-slate-500 italic">
          No fields set.
        </div>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono uppercase tracking-widest text-accent hover:text-accent transition"
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
  fallbackValue,
  fallbackLabel,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  fallbackValue?: unknown;
  fallbackLabel?: string;
  onCommit: (v: unknown) => void;
}) {
  // Computed branch — read-only, value derived server-side at resolve
  // time. Show it (the user configured it) but never let them edit it.
  if (def.type === "computed") {
    return <ComputedRow def={def} value={value} fallbackValue={fallbackValue} />;
  }
  // Dropdown branch — type='text' with choices.
  if (def.type === "text" && def.choices && def.choices.length > 0) {
    return <ChoiceRow def={def} value={value} onCommit={onCommit} />;
  }
  return (
    <PlainRow
      def={def}
      value={value}
      fallbackValue={fallbackValue}
      fallbackLabel={fallbackLabel}
      onCommit={onCommit}
    />
  );
}

function PlainRow({
  def,
  value,
  fallbackValue,
  fallbackLabel,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  fallbackValue?: unknown;
  fallbackLabel?: string;
  onCommit: (v: unknown) => void;
}) {
  const initial = value == null ? "" : String(value);
  const usingFallback = isBlank(value) && !isBlank(fallbackValue);
  const fallbackStr = fallbackValue == null ? "" : String(fallbackValue);
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
  // When the field def declares a renderer, show a live preview
  // next to the input so the user sees "0033B2" → blue swatch in
  // real time. The input keeps the raw value; the renderer reads
  // the current draft so the preview updates on every keystroke.
  const showPreview = !!def.renderer && def.renderer !== "text";
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
        {usingFallback && (
          <span className="ml-2 italic text-accent normal-case tracking-normal">
            from {fallbackLabel ?? "match"}
          </span>
        )}
      </span>
      <div className={showPreview ? "flex items-center gap-2" : ""}>
        <input
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
          defaultValue={initial}
          placeholder={usingFallback ? fallbackStr : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={
            "input flex-1 " +
            (usingFallback
              ? "italic placeholder:text-accent placeholder:not-italic"
              : "")
          }
          data-draft={draft}
        />
        {showPreview && (
          <FieldRenderer
            fieldName={def.name}
            value={draft || initial || fallbackStr}
            renderer={def.renderer ?? undefined}
            size="inline"
          />
        )}
      </div>
    </label>
  );
}

/** Read-only display for a computed field. Its value is rendered
 *  server-side at resolve time (so it shows on detail/list/export); here
 *  we just surface it, non-editable, with a quiet "computed" marker so the
 *  user understands why there's no input. */
function ComputedRow({
  def,
  value,
  fallbackValue,
}: {
  def: PlatformFieldDef;
  value: unknown;
  fallbackValue?: unknown;
}) {
  const shown = !isBlank(value) ? value : fallbackValue;
  const str = shown == null ? "" : String(shown);
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        <span className="ml-2 italic text-accent normal-case tracking-normal">computed</span>
      </span>
      <div className="input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 text-content dark:text-mortar-100 cursor-default select-text">
        {str || <span className="text-faint dark:text-slate-600">—</span>}
      </div>
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
        <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
          {def.display_label}{" "}
          <span className="text-accent">— new value</span>
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
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
