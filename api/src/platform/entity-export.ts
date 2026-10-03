// Any collection as a spreadsheet: one export every kind offers.
//
// Before this, three collections could be exported (inventory parts,
// locations, the scan inbox), each with its own writer; every other one
// (assets, machines, projects, lists, books, yarn, anything a person built)
// could be imported from a spreadsheet and never exported back (the 2026-09
// fundamentals audit).
//
// It reads through the same list a person sees, with THEIR viewer, so a field
// they may not read (a field read scope) never reaches the file, and a view's
// filter is the filter. Columns are the kind's own fields in form order, then
// its custom fields, with the names a person sees (a relabelled field under its
// label, a hidden one left out) so the file reads like the table and goes back
// in through Bring your spreadsheet, which matches headers to labels.

import { toCsv } from "@cobblr/platform-contract/csv";
import { columnLabel, isWritableCustomField, isWritableNativeField } from "@cobblr/platform-contract/record-columns";
import { quantityWithUnit, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { hiddenFieldsFor, listAll, listKindsForOrg } from "./entities.js";
import { resolveFieldDefsForKind } from "./field-defs.js";
import { readMoney, fieldCurrency, formatMoneyPlain, moneyStorageOf, storedCents, type MoneyStorage } from "@cobblr/platform-contract/money";

export interface ExportColumn {
  /** The header a person reads. */
  label: string;
  /** The field this column is, as a view's visible_fields names it. */
  field: string;
  cell: (row: ResolvedEntity) => unknown;
}

/** A value as a person reads it: a link by its label, a list joined. */
function readable(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v
    .map((x) => {
      if (!x || typeof x !== "object") return x;
      const o = x as Record<string, unknown>;
      return o.label ?? o.name ?? o.title ?? JSON.stringify(x);
    })
    .join("; ");
}
const field = (name: string) => (row: ResolvedEntity) => {
  const f = row.fields as Record<string, unknown>;
  const labelled = f[`${name}_label`];
  return readable(labelled !== undefined && labelled !== null ? labelled : f[name]);
};

/** A money column as a spreadsheet keeps it: "4300.00", never 430000 cents. */
const moneyCell = (name: string, storage: MoneyStorage) => (row: ResolvedEntity) => {
  const f = row.fields as Record<string, unknown>;
  const raw = name in f ? f[name] : ((f.metadata as Record<string, unknown> | undefined) ?? {})[name];
  const c = storedCents(raw, storage);
  const own = typeof raw === "object" ? readMoney(raw) : null;
  if (own) return `${own.amount} ${own.currency}`;
  const explicit = fieldCurrency(f.metadata, name, "");
  return c === null ? readable(raw) : explicit ? `${readMoney(raw, storage)?.amount ?? formatMoneyPlain(c)} ${explicit}` : formatMoneyPlain(c);
};

/** The columns a viewer's export of a kind carries, in order: the name, the
 *  columns the spreadsheet import reads back by their own words (Quantity,
 *  Location, Category), then every field a person writes. `only` (a table
 *  view's visible fields) picks and orders them; the name always leads. */
export async function exportColumns(
  orgId: string,
  kind: string,
  viewer: { userId?: string; role?: string },
  only?: string[],
): Promise<ExportColumn[] | null> {
  const record = (await listKindsForOrg(orgId)).find((k) => k.id === kind);
  if (!record) return null;
  const overrides = await meta
    .selectFrom("native_field_overrides")
    .select(["name", "display_label", "hidden"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
  const byName = new Map(overrides.map((o) => [o.name, o]));
  const hidden = await hiddenFieldsFor(orgId, kind, viewer);
  const shown = (name: string) => !hidden.has(name) && !byName.get(name)?.hidden;
  const has = (name: string) => record.fields.some((f) => f.name === name);

  const all: ExportColumn[] = [];
  if (has("qty") && shown("qty")) {
    all.push({
      label: "Quantity",
      field: "qty",
      cell: (row) => {
        const f = row.fields as Record<string, unknown>;
        if (f.qty === null || f.qty === undefined) return null;
        // "3 hanks", not "3 hank": the importer keeps the words beside a count.
        return typeof f.unit === "string" && f.unit && f.unit !== "each" ? quantityWithUnit(Number(f.qty), f.unit) : f.qty;
      },
    });
  }
  if (has("location_id") && shown("location_id")) all.push({ label: "Location", field: "location_id", cell: field("location_name") });
  if (has("category_id") && shown("category_id")) all.push({ label: "Category", field: "category_id", cell: field("category_name") });
  const seen = new Set<string>();
  for (const f of record.fields) {
    if (!isWritableNativeField(f) || !shown(f.name)) continue;
    seen.add(f.name);
    const money = moneyStorageOf(f);
    all.push({ label: byName.get(f.name)?.display_label || columnLabel(f.name), field: f.name, cell: money ? moneyCell(f.name, money) : field(f.name) });
  }
  for (const d of await resolveFieldDefsForKind(orgId, kind)) {
    if (seen.has(d.name) || !isWritableCustomField(d) || !shown(d.name)) continue;
    seen.add(d.name);
    const money = moneyStorageOf(d);
    all.push({ label: d.display_label || columnLabel(d.name), field: d.name, cell: money ? moneyCell(d.name, money) : field(d.name) });
  }
  const name: ExportColumn = { label: byName.get("name")?.display_label || "Name", field: "title", cell: (row) => row.title };
  if (!only?.length) return [name, ...all];
  const picked = only.map((f) => all.find((c) => c.field === f)).filter((c): c is ExportColumn => !!c);
  return [name, ...picked];
}

export interface EntityExport {
  csv: string;
  filename: string;
  rows: number;
  /** False when the list stopped at its cap: the file says it is not all. */
  complete: boolean;
}

export async function exportEntitiesCsv(
  orgId: string,
  kind: string,
  query: EntityListQuery,
  viewer: { userId?: string; role?: string },
  only?: string[],
): Promise<EntityExport | null> {
  const columns = await exportColumns(orgId, kind, viewer, only);
  if (!columns) return null;
  const record = (await listKindsForOrg(orgId)).find((k) => k.id === kind)!;
  const got = await listAll(orgId, kind, query, viewer);
  const rows = got.items.map((row) => columns.map((c) => c.cell(row)));
  const noun = (record.display_name_plural || record.display_name || kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    csv: toCsv(
      columns.map((c) => c.label),
      rows,
    ),
    // UTC-DAY OK: the download's filename stamp, not a claim about anybody's calendar.
    filename: `${noun || "export"}-${new Date().toISOString().slice(0, 10)}.csv`,
    rows: rows.length,
    complete: got.complete,
  };
}
