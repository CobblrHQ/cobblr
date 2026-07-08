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

/** A field the user can build a view on. Unifies native (entity-kind) and
 *  custom (field-def) fields plus the always-present system sort columns. */
export interface KindField {
  name: string;
  label: string;
  type: string;
  /** Suggested values (custom text fields with choices, e.g. a `state`). */
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
      push({ name: f.name, label: humanize(f.name), type: f.type });
    }
    // Custom / bundle field-defs (carry display_label + choices).
    for (const f of customs.data?.items ?? []) {
      // Computed and server-managed fields are read-only; still fine to sort /
      // group / show, so include them.
      push({
        name: f.name,
        label: f.display_label || humanize(f.name),
        type: f.type,
        choices: f.choices ?? undefined,
      });
    }
    // System sort columns — always available, appended last.
    for (const name of ["created_at", "updated_at"]) {
      push({ name, label: humanize(name), type: "date", system: true });
    }
    return out;
  }, [kinds.data, customs.data, entityKind]);
}

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── filter model ────────────────────────────────────────────────────────
// A filter row is one predicate. `is` / `is any of` map to config.filter
// (equality / IN); everything else maps to a config.where comparison.

export type FilterOp = "is" | "is any of" | "is not" | ">=" | "<=" | ">" | "<";

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
    const op: FilterOp = w.op === "!=" ? "is not" : (w.op as FilterOp);
    rows.push({ field: w.col, op, value: String(w.value ?? ""), values: [] });
  }
  return rows;
}

/** filter rows → { filter, where } config fragments. Empty rows are dropped. */
export function filterRowsToConfig(rows: FilterRow[]): {
  filter?: Record<string, string | string[]>;
  where?: Array<{ col: string; op: string; value: string | number }>;
} {
  const filter: Record<string, string | string[]> = {};
  const where: Array<{ col: string; op: string; value: string | number }> = [];
  for (const r of rows) {
    if (!r.field) continue;
    if (r.op === "is") {
      if (r.value.trim()) filter[r.field] = r.value.trim();
    } else if (r.op === "is any of") {
      const vals = r.values.filter((v) => v.trim());
      if (vals.length) filter[r.field] = vals;
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
    <select className={smallCls} data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)}>
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
            fields={fields}
            value={r.field}
            onChange={(v) => set(i, { field: v })}
            allowBlank
            blankLabel="Pick a field…"
            testid="sort-field"
          />
          <select
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
          <div key={i} className="flex items-start gap-1.5">
            <FieldSelect
              fields={fields}
              value={r.field}
              onChange={(v) => set(i, { field: v })}
              allowBlank
              blankLabel="Pick a field…"
              testid="filter-field"
            />
            <select
              className={smallCls}
              data-testid="filter-op"
              value={r.op}
              onChange={(e) => set(i, { op: e.target.value as FilterOp })}
            >
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {r.op === "is any of" ? (
              <select
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
              <select
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
                placeholder="value"
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
    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 border border-line dark:border-slate-600 rounded">
      {all.map((f) => {
        const on = value.includes(f.name);
        return (
          <button
            key={f.name}
            type="button"
            onClick={() => toggle(f.name, !on)}
            className={`px-2 py-0.5 text-xs rounded transition ${
              on
                ? "bg-cobble-600 text-white"
                : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

export { inputCls };
