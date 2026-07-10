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
import { fieldControl } from "./fieldControl";
import { FieldRenderer, boolLabel } from "./FieldRenderer";
import { MarkdownEditor } from "./MarkdownEditor";
import { relativeTime } from "./relativeTime";
import { useUnits } from "./useUnits";

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
  /** Field-def names to suppress entirely — for conditional relevance the host
   *  decides (e.g. a Bambu printer hides hotend/mainboard/firmware/local-IP, a
   *  DIY Klipper shows them). Generic: any host can gate fields on its own
   *  discriminator without a per-field schema change. */
  hideNames?: Set<string>;
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
  hideNames,
}: Props) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind],
    queryFn: () => api.listFieldDefs(orgSlug, entityKind),
    staleTime: 60_000,
  });
  const [showAll, setShowAll] = useState(false);
  const fields = useMemo(
    () => (data?.items ?? [])
      .filter((f) => !hideNames?.has(f.name))
      .slice()
      .sort((a, b) => a.position - b.position),
    [data, hideNames],
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

  // Group by form-builder section: ungrouped fields first (no heading), then
  // each section (in its saved order) with a heading. A section with no visible
  // fields is skipped.
  const sections = (data?.sections ?? []).slice().sort((a, b) => a.position - b.position);
  const inSection = (sid: string | null) => visible.filter((f) => (f.section_id ?? null) === sid);
  const ungrouped = inSection(null);
  const grouped = sections.map((s) => ({ s, fs: inSection(s.id) })).filter((g) => g.fs.length > 0);

  const grid = (fs: PlatformFieldDef[]) => (
    <div className="grid grid-cols-2 gap-3">
      {fs.map((f) => (
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
  );

  return (
    // No "// custom fields" box or header: to the user there's no stock-vs-custom
    // distinction — every field they configured is just a field, grouped under
    // the sections they arranged in the form builder.
    <div className={"space-y-4 " + (className ?? "")}>
      {ungrouped.length > 0 && grid(ungrouped)}
      {grouped.map(({ s, fs }) => (
        <div key={s.id} className="space-y-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 border-b border-line dark:border-slate-700 pb-1">
            {s.name}
          </div>
          {grid(fs)}
        </div>
      ))}
      {visible.length === 0 && !showAll && (
        <div className="text-[11px] text-faint dark:text-slate-500 italic">No fields set.</div>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono uppercase tracking-widest text-accent hover:text-accent transition"
        >
          {showAll ? "− hide empty fields" : `+ ${hidden.length} more field${hidden.length === 1 ? "" : "s"}`}
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
  // One shared decision (see fieldControl) so this panel and the create
  // modal can't disagree on a field's control — the bug where a boolean
  // fell through to a text box showing "false".
  const control = fieldControl(def);
  const inner =
    control === "computed" ? (
      // Read-only, value derived server-side at resolve time.
      <ComputedRow def={def} value={value} fallbackValue={fallbackValue} />
    ) : control === "server-managed" ? (
      // Read-only, value STAMPED server-side (e.g. core-mobility's away_since).
      // An input here would be a lying control — the server rejects the write.
      <ServerManagedRow def={def} value={value} />
    ) : control === "relation" ? (
      // Reference to another entity — a picker over the def's ref_kind.
      <RelationRow def={def} value={value} onCommit={onCommit} />
    ) : control === "color" ? (
      // Colour branch — a real swatch picker (type a hex/name OR pick).
      <ColorRow def={def} value={value} onCommit={onCommit} />
    ) : control === "choice" ? (
      // Dropdown branch — a `choices` list.
      <ChoiceRow def={def} value={value} onCommit={onCommit} />
    ) : control === "checkbox" ? (
      // Boolean — a real checkbox, not a text box.
      <BoolRow def={def} value={value} onCommit={onCommit} />
    ) : control === "markdown" ? (
      // Rich text — the Markdown editor (Write/Preview split).
      <MarkdownRow def={def} value={value} onCommit={onCommit} />
    ) : (
      // number / date / url / text
      <PlainRow
        def={def}
        value={value}
        fallbackValue={fallbackValue}
        fallbackLabel={fallbackLabel}
        onCommit={onCommit}
      />
    );
  // The bundle-authored plain-language hint, rendered under any field type so
  // jargon fields (colorway, dye lot…) explain themselves.
  if (!def.help) return inner;
  return (
    <div className="space-y-1">
      {inner}
      <p className="text-[11px] text-faint dark:text-slate-500 leading-snug">{def.help}</p>
    </div>
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
  // A declared unit shows as a quiet suffix token on the input row ("mm"),
  // so the person typing knows what the number means.
  const showUnit = !!def.unit && def.type === "number";
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
      <div className={showPreview || showUnit ? "flex items-center gap-2" : ""}>
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
        {showUnit && <UnitSuffix unit={def.unit!} />}
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

/** The declared unit as a quiet token next to a number input, honoring the
 *  workspace's symbol/name display preference. */
function UnitSuffix({ unit }: { unit: string }) {
  const units = useUnits();
  return (
    <span className="shrink-0 text-xs text-muted dark:text-slate-400">{units.unit(unit)}</span>
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
        {str ? (
          // Honour the field's renderer so a {{ }}-built URL (renderer "url-link")
          // draws as a clickable link, not plain text.
          <FieldRenderer fieldName={def.name} value={str} renderer={def.renderer ?? undefined} type={def.type} />
        ) : (
          <span className="text-faint dark:text-slate-600">—</span>
        )}
      </div>
    </label>
  );
}

/** Read-only display for a SERVER-MANAGED field — a value the server owns and
 *  stamps (e.g. a drift timestamp). Dates render as relative time ("3d ago",
 *  hover for the absolute stamp) since "how long" is usually the point of a
 *  server-stamped date. Never an input: the write router rejects client
 *  values, so an editable box would silently revert. */
function ServerManagedRow({ def, value }: { def: PlatformFieldDef; value: unknown }) {
  const str = value == null ? "" : String(value);
  const isDate = def.type === "date";
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        <span className="ml-2 italic text-accent normal-case tracking-normal">auto</span>
      </span>
      <div
        className="input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 text-content dark:text-mortar-100 cursor-default select-text"
        title={isDate && str ? new Date(str).toLocaleString() : undefined}
      >
        {str ? (
          isDate ? (
            relativeTime(str)
          ) : (
            <FieldRenderer fieldName={def.name} value={str} renderer={def.renderer ?? undefined} type={def.type} />
          )
        ) : (
          <span className="text-faint dark:text-slate-600">—</span>
        )}
      </div>
    </label>
  );
}

/** A relation VALUE picker over a referenced kind — a select storing the chosen
 *  entity's id and displaying titles, never uuids. Candidate list comes from
 *  the host adapter's generic listEntities; a host that doesn't wire it gets a
 *  read-only title (resolved via lookupEntity) instead of a picker. Fully
 *  generic — nothing here knows about locations or any specific kind. Exported
 *  so create forms (e.g. inventory's NewPartDialog) share the exact control the
 *  detail panel uses. */
export function RelationSelect({
  refKind,
  value,
  onChange,
  className,
}: {
  refKind: string;
  value: unknown;
  onChange: (v: string | null) => void;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const current = value == null ? "" : String(value);

  const canList = !!api.listEntities && !!refKind;
  const candidates = useQuery({
    queryKey: ["platform-relation-candidates", orgSlug, refKind],
    queryFn: () => api.listEntities!(orgSlug, refKind),
    enabled: canList,
    staleTime: 30_000,
  });
  const items = candidates.data?.items ?? [];
  // Resolve the current value's title even when it's missing from the candidate
  // list (dangling ref, >limit list, or no listEntities adapter).
  const inList = items.some((e) => e.id === current);
  const fallbackTitle = useQuery({
    queryKey: ["platform-relation-title", orgSlug, refKind, current],
    queryFn: () => api.lookupEntity(orgSlug, refKind, current),
    enabled: !!current && !!refKind && !inList && (candidates.isSuccess || !canList),
    staleTime: 60_000,
    retry: false,
  });

  if (!canList) {
    // No picker available — show the resolved title read-only, never a raw id.
    const title = fallbackTitle.data?.title ?? (current ? "…" : "");
    return (
      <div className={"input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 cursor-default " + (className ?? "")}>
        {title || <span className="text-faint dark:text-slate-600">—</span>}
      </div>
    );
  }

  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className={"input " + (className ?? "")}
    >
      <option value="">—</option>
      {items.map((e) => (
        <option key={e.id} value={e.id}>
          {e.title}
        </option>
      ))}
      {current && !inList && (
        <option value={current}>{fallbackTitle.data?.title ?? "(unavailable)"}</option>
      )}
    </select>
  );
}

/** A relation field row — label + the shared RelationSelect. */
function RelationRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <RelationSelect refKind={def.ref_kind ?? ""} value={value} onChange={(v) => onCommit(v)} />
    </label>
  );
}

/** A boolean field — a real checkbox. Tolerant of legacy string values
 *  ("true"/"false") that the old text-box bug may have stored; toggling
 *  commits a proper boolean, so the row self-heals on next edit. */
function BoolRow({
  def,
  value,
  onCommit,
}: {
  def: PlatformFieldDef;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const checked = value === true || value === "true";
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none pt-5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCommit(e.target.checked)}
        className="accent-cobble-500 h-4 w-4"
      />
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      {/* The current state in the field's own words (Yes/No, or the bundle/
          user's `choices` labels) so the value reads the same here as it does
          in the table — never raw true/false. */}
      <span className={"text-[11px] " + (checked ? "text-moss-600" : "text-faint dark:text-slate-500")}>
        {boolLabel(checked, def.choices)}
      </span>
    </label>
  );
}

/** A rich-text field — the Markdown editor. Keeps a local draft and commits the
 *  Markdown string on blur (like PlainRow), so the panel doesn't refetch on
 *  every keystroke. */
function MarkdownRow({
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
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <MarkdownEditor
        value={draft}
        ariaLabel={def.display_label}
        onChange={setDraft}
        onBlur={() => {
          if (draft !== initial) onCommit(draft === "" ? null : draft);
        }}
      />
    </label>
  );
}

/** A colour field — native OS swatch picker + a free-text box (so a named
 *  colour like "Peacock" still works). Commits on change/blur. */
function ColorRow({
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
  const t = draft.trim();
  const swatch = /^#?[0-9a-fA-F]{6}$/.test(t) ? (t[0] === "#" ? t : `#${t}`) : "#cccccc";
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {def.display_label}
        {def.required ? <span className="text-ember-500"> *</span> : null}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={swatch}
          onChange={(e) => {
            setDraft(e.target.value);
            onCommit(e.target.value);
          }}
          className="h-9 w-12 shrink-0 rounded border border-line dark:border-slate-600 cursor-pointer bg-transparent p-0.5"
          aria-label={`${def.display_label} colour picker`}
        />
        <input
          type="text"
          value={draft}
          placeholder="#hex or a colour name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== initial) onCommit(draft.trim() === "" ? null : draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="input flex-1"
        />
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
