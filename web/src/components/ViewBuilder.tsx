import { moneyStorageOf, type MoneyStorage } from "@cobblr/platform-contract/money";
// Shared, field-aware controls for building a saved view's config, used by
// both the Create and Edit view modals. The point: you shape a view by picking
// real fields, operators, sort direction, and columns — no typing raw
// snake_case field names into a comma-separated box. A raw "advanced" text
// escape hatch stays available so power users never lose expressiveness.
//
// Everything here is GENERIC — driven entirely by a kind's declared fields
// (native from the entity-kind registry + custom from field-defs). No module
// or use-case knowledge lives in this file.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Check } from "lucide-react";
import { useFieldPresentation } from "@cobblr/platform-web";

/** A field the user can build a view on. Unifies native (entity-kind) and
 *  custom (field-def) fields plus the always-present system sort columns. */
export interface KindField {
  name: string;
  label: string;
  type: string;
  money?: MoneyStorage;
  /** The values the field takes, in order: a kind's declared native choices
   *  (a machine's `state`) or a custom dropdown's. */
  choices?: string[];
  /** true for created_at/updated_at — sortable, but not a filter/group target
   *  we surface by default (they're timestamps). */
  system?: boolean;
}

const inputCls =
  "w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
const smallCls =
  "px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

/** Fetch a kind's fields (native + custom) and return them unified. Timeless
 *  system columns (created_at/updated_at) are appended so they can be sorted
 *  on even though no module declares them as user fields. */
export function useKindFields(slug: string, entityKind: string): KindField[] {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  const customs = useQuery({
    queryKey: ["field-defs", slug, entityKind],
    queryFn: () => api.listFieldDefs(slug, entityKind),
    enabled: !!slug && !!entityKind,
  });
  // What the collection calls its native fields: Wine's `manufacturer` is
  // Producer, Groceries' `cost` is Paid. A column or a sort named by the
  // generic word is the collection shown as somebody else's.
  const presentation = useFieldPresentation(entityKind);

  return useMemo(() => {
    const out: KindField[] = [];
    const seen = new Set<string>();
    const push = (f: KindField) => {
      if (seen.has(f.name)) return;
      seen.add(f.name);
      out.push(f);
    };
    // Native declared fields for the kind.
    const kind = (kinds.data?.items ?? []).find((k) => k.id === entityKind);
    for (const f of kind?.fields ?? []) {
      push({ name: f.name, label: presentation.label(f.name, f.label || humanize(f.name)), type: f.type, choices: f.choices, money: moneyStorageOf(f) ?? undefined });
    }
    // Custom / bundle field-defs (carry display_label + choices).
    for (const f of customs.data?.items ?? []) {
      // Computed and server-managed fields are read-only; still fine to sort /
      // group / show, so include them.
      push({
        name: f.name,
        label: f.display_label || humanize(f.name),
        type: f.type,
        money: moneyStorageOf(f) ?? undefined,
        choices: f.choices ?? undefined,
      });
    }
    // System sort columns — always available, appended last.
    for (const name of ["created_at", "updated_at"]) {
      push({ name, label: humanize(name), type: "date", system: true });
    }
    return out;
  }, [kinds.data, customs.data, entityKind, presentation]);
}

/** The values a kind's native field declares, in order (a machine's `state`),
 *  from the same entity-kinds read useKindFields uses, and nothing else: a
 *  dropdown needs the list, not the collection's labels. */
export function useDeclaredChoices(slug: string, entityKind: string, field: string): string[] {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  return useMemo(
    () => (kinds.data?.items ?? []).find((k) => k.id === entityKind)?.fields.find((f) => f.name === field)?.choices ?? [],
    [kinds.data, entityKind, field],
  );
}

export function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── filter model ────────────────────────────────────────────────────────
// A filter row is one predicate. `is` / `is any of` map to config.filter
// (equality / IN); everything else maps to a config.where comparison.

export type FilterOp = "has a value" | "is empty" | "is" | "is any of" | "is not" | "contains" | "does not contain" | ">=" | "<=" | ">" | "<";

export interface FilterRow {
  field: string;
  op: FilterOp;
  value: string;
  /** multi-value target for `is any of` (IN). */
  values: string[];
}

export interface SortRow {
  field: string;
  dir: "asc" | "desc";
}

export function emptyFilterRow(field = ""): FilterRow {
  return { field, op: "is", value: "", values: [] };
}

/** view config → filter rows (for the Edit modal's initial state). */
export function configToFilterRows(cfg: Record<string, unknown>): FilterRow[] {
  const rows: FilterRow[] = [];
  const filter = (cfg.filter as Record<string, unknown> | undefined) ?? {};
  for (const [field, val] of Object.entries(filter)) {
    if (Array.isArray(val)) {
      rows.push({ field, op: "is any of", value: "", values: val.map(String) });
    } else {
      rows.push({ field, op: "is", value: String(val), values: [] });
    }
  }
  const where =
    (cfg.where as Array<{ col: string; op: string; value?: unknown; ref_col?: unknown }> | undefined) ??
    [];
  for (const w of where) {
    if (!w || w.ref_col) continue; // column-to-column comparisons stay raw-only
    const op: FilterOp = w.op === "empty" ? "is empty" : w.op === "not_empty" ? "has a value" : w.op === "!=" ? "is not" : w.op === "not_contains" ? "does not contain" : (w.op as FilterOp);
    rows.push({ field: w.col, op, value: String(w.value ?? ""), values: [] });
  }
  return rows;
}

/** filter rows → { filter, where } config fragments. Empty rows are dropped. */
export function filterRowsToConfig(rows: FilterRow[]): {
  filter?: Record<string, string | string[]>;
  where?: Array<{ col: string; op: string; value?: string | number }>;
} {
  const filter: Record<string, string | string[]> = {};
  const where: Array<{ col: string; op: string; value?: string | number }> = [];
  for (const r of rows) {
    if (!r.field) continue;
    if (r.op === "has a value" || r.op === "is empty") {
      where.push({ col: r.field, op: r.op === "has a value" ? "not_empty" : "empty" });
    } else if (r.op === "is") {
      if (r.value.trim()) filter[r.field] = r.value.trim();
    } else if (r.op === "is any of") {
      const vals = r.values.filter((v) => v.trim());
      if (vals.length) filter[r.field] = vals;
    } else if (r.op === "contains" || r.op === "does not contain") {
      // Text, kept as typed: "123" contains the digits, not the number.
      if (r.value.trim() === "") continue;
      where.push({ col: r.field, op: r.op === "contains" ? "contains" : "not_contains", value: r.value.trim() });
    } else {
      const op = r.op === "is not" ? "!=" : r.op;
      if (r.value.trim() === "") continue;
      const isNum = /^-?[0-9]+(\.[0-9]+)?$/.test(r.value.trim());
      where.push({ col: r.field, op, value: isNum ? Number(r.value.trim()) : r.value.trim() });
    }
  }
  return {
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(where.length ? { where } : {}),
  };
}

export function sortToRows(sort: unknown): SortRow[] {
  if (!Array.isArray(sort)) return [];
  return sort
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => ({ field: s.replace(/^-/, ""), dir: s.startsWith("-") ? "desc" : "asc" }));
}

export function rowsToSort(rows: SortRow[]): string[] {
  return rows.filter((r) => r.field).map((r) => (r.dir === "desc" ? `-${r.field}` : r.field));
}

// ── controls ────────────────────────────────────────────────────────────

export function FieldSelect({
  fields,
  value,
  onChange,
  allowBlank,
  blankLabel = "—",
  testid,
}: {
  fields: KindField[];
  value: string;
  onChange: (v: string) => void;
  allowBlank?: boolean;
  blankLabel?: string;
  testid?: string;
}) {
  // If the current value isn't among the known fields (a custom config or a
  // field since removed), keep it selectable so we never silently drop it.
  const known = fields.some((f) => f.name === value);
  return (
    <select aria-label="Field" className={smallCls} data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowBlank && <option value="">{blankLabel}</option>}
      {!known && value && <option value={value}>{value}</option>}
      {fields.map((f) => (
        <option key={f.name} value={f.name}>
          {f.label}
        </option>
      ))}
    </select>
  );
}

/** One input row in the builder (#6897): text as typed, turned into a
 *  declared input only when the view is saved. */
export interface InputRow {
  label: string;
  name: string;
  type: "number" | "text" | "date" | "choice";
  default: string;
  min: string;
  max: string;
  choices: string;
}

/** A name a template can use, from a label: "Servings ×" → "servings". */
export function inputNameOf(label: string): string {
  const n = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "");
  return n.slice(0, 40) || "input";
}

export function configToInputRows(cfg: Record<string, unknown>): InputRow[] {
  const list = Array.isArray(cfg.inputs) ? (cfg.inputs as Array<Record<string, unknown>>) : [];
  return list.map((i) => ({
    label: String(i.label ?? ""),
    name: String(i.name ?? ""),
    type: (["number", "text", "date", "choice"].includes(String(i.type)) ? i.type : "number") as InputRow["type"],
    default: i.default == null ? "" : String(i.default),
    min: i.min == null ? "" : String(i.min),
    max: i.max == null ? "" : String(i.max),
    choices: Array.isArray(i.choices) ? (i.choices as unknown[]).map(String).join(", ") : "",
  }));
}

/** input rows → the view's `inputs`; a row with no label is dropped. */
export function inputRowsToConfig(rows: InputRow[]): Array<Record<string, unknown>> {
  const num = (v: string) => (/^\s*-?\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : undefined);
  return rows
    .filter((r) => r.label.trim())
    .map((r) => {
      const name = r.name.trim() || inputNameOf(r.label);
      const base: Record<string, unknown> = { name, label: r.label.trim(), type: r.type };
      if (r.type === "number") {
        const d = num(r.default), lo = num(r.min), hi = num(r.max);
        if (d !== undefined) base.default = d;
        if (lo !== undefined) base.min = lo;
        if (hi !== undefined) base.max = hi;
      } else if (r.default.trim()) base.default = r.default.trim();
      if (r.type === "choice") base.choices = r.choices.split(",").map((c) => c.trim()).filter(Boolean);
      return base;
    });
}

/** The values a viewer sets on the view (a recipe's "Servings ×"), which its
 *  computed fields read as {{ inputs.<name> }}. Read-only: an input never
 *  changes a record. */
export function InputsBuilder({ rows, onChange }: { rows: InputRow[]; onChange: (rows: InputRow[]) => void }) {
  const set = (i: number, patch: Partial<InputRow>) => onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-start gap-1.5" data-testid="view-input-row">
          <input className={smallCls} aria-label="Input label" placeholder="Servings ×" value={r.label} onChange={(e) => set(i, { label: e.target.value })} />
          <input className={smallCls} aria-label="Name in formulas" placeholder={inputNameOf(r.label || "scale")} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <select className={smallCls} aria-label="Input type" value={r.type} onChange={(e) => set(i, { type: e.target.value as InputRow["type"] })}>
            <option value="number">number</option>
            <option value="text">text</option>
            <option value="date">date</option>
            <option value="choice">choice</option>
          </select>
          <input className={smallCls} aria-label="Default" placeholder="default" value={r.default} onChange={(e) => set(i, { default: e.target.value })} />
          {r.type === "number" && (
            <>
              <input className={`${smallCls} w-20`} aria-label="Least" placeholder="least" inputMode="decimal" value={r.min} onChange={(e) => set(i, { min: e.target.value })} />
              <input className={`${smallCls} w-20`} aria-label="Most" placeholder="most" inputMode="decimal" value={r.max} onChange={(e) => set(i, { max: e.target.value })} />
            </>
          )}
          {r.type === "choice" && (
            <input className={smallCls} aria-label="Choices" placeholder="small, medium, large" value={r.choices} onChange={(e) => set(i, { choices: e.target.value })} />
          )}
          <button type="button" aria-label="Remove input" title="Remove input" className="min-h-11 min-w-11 text-faint hover:text-accent" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { label: "", name: "", type: "number", default: "1", min: "", max: "", choices: "" }])}
        className="text-xs text-accent hover:underline"
        data-testid="add-view-input"
      >
        + Add input
      </button>
      {rows.some((r) => r.label.trim()) && (
        <p className="text-xs text-muted">
          A computed field reads it as <code>{"{{ inputs." + (rows.find((r) => r.label.trim())!.name.trim() || inputNameOf(rows.find((r) => r.label.trim())!.label)) + " }}"}</code>, e.g.{" "}
          <code>{"{{ amount * inputs." + (rows.find((r) => r.label.trim())!.name.trim() || inputNameOf(rows.find((r) => r.label.trim())!.label)) + " }}"}</code>.
        </p>
      )}
    </div>
  );
}

export function SortBuilder({
  fields,
  rows,
  onChange,
}: {
  fields: KindField[];
  rows: SortRow[];
  onChange: (rows: SortRow[]) => void;
}) {
  const set = (i: number, patch: Partial<SortRow>) =>
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <FieldSelect
            fields={fields.filter((f) => f.type !== "secret")}
            value={r.field}
            onChange={(v) => set(i, { field: v })}
            allowBlank
            blankLabel="Pick a field…"
            testid="sort-field"
          />
          <select aria-label="Sort direction"
            className={smallCls}
            data-testid="sort-dir"
            value={r.dir}
            onChange={(e) => set(i, { dir: e.target.value as "asc" | "desc" })}
          >
            <option value="asc">A → Z / low → high</option>
            <option value="desc">Z → A / high → low</option>
          </select>
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="px-2 py-1 text-xs text-faint hover:text-content"
            aria-label="Remove sort"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { field: "", dir: "asc" }])}
        className="text-xs text-accent hover:underline"
        data-testid="add-sort"
      >
        + Add sort
      </button>
    </div>
  );
}

const OPS: FilterOp[] = ["is", "is any of", "is not", ">=", "<=", ">", "<"];
/** The field types a "contains" reads (#6896). */
const TEXT_TYPES = new Set(["text", "textarea", "string", "url", "email", "markdown"]);

/** What a field may be filtered by: a secret only by whether it has a value;
 *  a text field also by what it contains; anything else by the comparisons. */
export function opsFor(field: Pick<KindField, "type"> | undefined): FilterOp[] {
  if (field?.type === "secret") return ["has a value", "is empty"];
  if (field && TEXT_TYPES.has(field.type)) return ["is", "is any of", "is not", "contains", "does not contain", ">=", "<=", ">", "<"];
  return OPS;
}

export function FilterBuilder({
  fields,
  rows,
  onChange,
}: {
  fields: KindField[];
  rows: FilterRow[];
  onChange: (rows: FilterRow[]) => void;
}) {
  const set = (i: number, patch: Partial<FilterRow>) =>
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => {
        const field = fields.find((f) => f.name === r.field);
        const choices = field?.choices ?? [];
        return (
          // Wraps: on a phone the field, the condition and the value do not fit
          // one row, and the value box (what to look for) was pushed off the
          // screen (#6896).
          <div key={i} className="flex flex-wrap items-start gap-1.5">
            <FieldSelect
              fields={fields}
              value={r.field}
              onChange={(v) => set(i, { field: v, op: opsFor(fields.find((f) => f.name === v))[0]!, value: "", values: [] })}
              allowBlank
              blankLabel="Pick a field…"
              testid="filter-field"
            />
            <select aria-label="Filter condition"
              className={smallCls}
              data-testid="filter-op"
              value={r.op}
              onChange={(e) => set(i, { op: e.target.value as FilterOp })}
            >
              {opsFor(field).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {field?.type === "secret" || r.op === "has a value" || r.op === "is empty" ? null : r.op === "is any of" ? (
              <select aria-label="Filter values"
                multiple
                data-testid="filter-value"
                className={`${smallCls} min-w-[8rem] h-20`}
                value={r.values}
                onChange={(e) =>
                  set(i, { values: Array.from(e.target.selectedOptions).map((o) => o.value) })
                }
              >
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : choices.length && (r.op === "is" || r.op === "is not") ? (
              <select aria-label="Filter value"
                className={smallCls}
                data-testid="filter-value"
                value={r.value}
                onChange={(e) => set(i, { value: e.target.value })}
              >
                <option value="">—</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className={smallCls}
                data-testid="filter-value"
                value={r.value}
                placeholder={field?.type === "date" ? "Date, today+60 or year-start" : r.op === "contains" || r.op === "does not contain" ? "words to look for" : "value"}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            )}
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="px-2 py-1 text-xs text-faint hover:text-content"
              aria-label="Remove filter"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...rows, emptyFilterRow()])}
        className="text-xs text-accent hover:underline"
        data-testid="add-filter"
      >
        + Add filter
      </button>
    </div>
  );
}

export function ColumnPicker({
  fields,
  value,
  onChange,
}: {
  fields: KindField[];
  value: string[];
  onChange: (cols: string[]) => void;
}) {
  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...value, name] : value.filter((c) => c !== name));
  // `title`/`subtitle` are always available projection aliases.
  const all: KindField[] = [
    { name: "title", label: "Title", type: "text" },
    { name: "subtitle", label: "Subtitle", type: "text" },
    ...fields,
  ];
  return (
    <div role="group" aria-label="Columns" className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 border border-line dark:border-slate-600 rounded">
      {all.map((f) => {
        const on = value.includes(f.name);
        return (
          <button
            key={f.name}
            type="button"
            onClick={() => toggle(f.name, !on)}
            aria-pressed={on}
            className={`min-h-11 inline-flex items-center gap-1 px-3 text-xs rounded transition ${
              on
                ? "bg-cobble-600 text-white"
                : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300"
            }`}
          >
            {on && <Check size={12} strokeWidth={2.5} aria-hidden />}
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

export { inputCls };
