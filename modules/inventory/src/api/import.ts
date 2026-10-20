// CSV bulk import: paste, preview, commit.
//
// Preview and commit are one plan (planImport): the same reading, the same
// checks, the same names resolved, so a preview that says "Import 3 rows"
// is exactly what the commit writes. Every row is held to the schema a
// record made by hand is held to (PartCreate, the one POST /parts uses), so a
// value the record would refuse (a quantity below zero) is a row the preview
// names and the commit leaves out, never a 500 that takes the whole file
// with it (#7618). A cell that does not read as its column's type (a
// quantity of "nope") is never guessed into a number: the row is named with
// the reason and left out (#7619). Every column the file has is either read
// or named as not read, so an export of this table comes back with every
// field it had (#7617), and nothing a person wrote is dropped unseen.

import { Router, type Request } from "express";
import { z } from "zod";
import { platform, type DefinedField } from "@cobblr/platform-contract";
import { parseCsv, unguardCsvText } from "@cobblr/platform-contract/csv";
import { castFieldValue } from "@cobblr/platform-contract/field-values";
import { fieldCurrency } from "@cobblr/platform-contract/money";
import { recordName } from "@cobblr/platform-contract/record-name";
import { instanceOf, instanceQtyUnit, sessionUser, tenantContext, tenantDb } from "../db.js";
import { PartCreate } from "./parts.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

export const importRouter = Router({ mergeParams: true });

const ImportBody = z.object({
  csv: z.string().min(1).max(10 * 1024 * 1024), // 10 MB cap, ~200k rows
  dry_run: z.boolean().default(false),
  // Default category/location to apply when the CSV doesn't specify
  // (or doesn't have those columns at all).
  default_category_id: z.string().uuid().nullable().optional(),
  default_location_id: z.string().uuid().nullable().optional(),
});

type PartInput = z.infer<typeof PartCreate>;

export interface ParsedRow {
  name: string;
  description: string | null;
  qty: number;
  approximate_qty: number | null;
  unit: string | null;
  cost: number | null;
  min_qty: number | null;
  manufacturer: string | null;
  notes: string | null;
  state: PartInput["state"] | null;
  category_name: string | null;
  location_name: string | null;
  serial_number: string | null;
  model_number: string | null;
  assigned_to: string | null;
  warranty_expires: string | null; // YYYY-MM-DD
  lifetime_warranty: boolean;
  warranty_details: string | null;
  insured: boolean;
  archived: boolean;
  supplier_url: string | null;
  /** The product's code, kept where a scan looks for it (metadata.barcode),
   *  so an imported thing is recognised by the scanner like one made by hand. */
  barcode: string | null;
  /** The table's own fields (a bookshelf's author, a pantry's expiry), by
   *  field name, typed by the field's definition. What the export writes
   *  after the native columns, read back. */
  metadata: Record<string, unknown>;
  row_number: number;
  /** What the import did with this row that the file did not say outright:
   *  a category it has no such name for, a place it could not find. */
  warnings: string[];
}

export interface ImportPlan {
  rows: ParsedRow[];
  /** Rows the import leaves out, each with every reason. */
  errors: { row_number: number; message: string }[];
  detected_headers: Record<string, string | null>;
  /** Columns of the file the import does not read, and why. */
  unread_columns: { header: string; reason: string }[];
}

// ─────────────────────── Columns ────────────────────────

/** Each native column: the headers that mean it (first match wins, in
 *  this order, and a header is claimed once), and what a person calls it. */
const COLUMNS: Record<string, { headers: string[]; label: string }> = {
  name: { headers: ["name", "part", "item", "title", "description", "product"], label: "Name" },
  description: { headers: ["description"], label: "Description" },
  qty: { headers: ["qty", "quantity", "count", "stock", "on_hand", "on hand"], label: "Quantity" },
  approximate_qty: { headers: ["approximate_qty", "approx_qty", "estimated_qty", "estimate", "roughly"], label: "Estimated quantity" },
  unit: { headers: ["unit", "uom"], label: "Unit" },
  cost: { headers: ["cost", "price", "unit_cost", "unit_price", "unit cost", "each", "value"], label: "Cost" },
  min_qty: { headers: ["min_qty", "minimum", "min", "reorder", "reorder_at", "threshold"], label: "Reorder at" },
  manufacturer: { headers: ["manufacturer", "brand", "maker", "vendor"], label: "Manufacturer" },
  notes: { headers: ["notes", "note", "comment", "remarks"], label: "Notes" },
  state: { headers: ["state"], label: "State" },
  category: { headers: ["category", "type", "group", "kind"], label: "Category" },
  location: { headers: ["location", "bin", "shelf", "where", "place"], label: "Location" },
  // HomeBox parity fields (round-trips with /parts/export.csv).
  serial_number: { headers: ["serial_number", "serial", "sn"], label: "Serial number" },
  model_number: { headers: ["model_number", "model", "model_no"], label: "Model number" },
  assigned_to: { headers: ["assigned_to", "assigned to"], label: "Assigned to" },
  warranty_expires: { headers: ["warranty_expires", "warranty", "warranty_until", "expires"], label: "Warranty expires" },
  warranty_details: { headers: ["warranty_details", "warranty_notes"], label: "Warranty details" },
  lifetime_warranty: { headers: ["lifetime_warranty", "lifetime"], label: "Lifetime warranty" },
  insured: { headers: ["insured"], label: "Insured" },
  archived: { headers: ["archived"], label: "Archived" },
  supplier_url: { headers: ["supplier_url", "supplier", "url", "link"], label: "Supplier link" },
  barcode: { headers: ["barcode", "upc", "ean", "gtin", "upc_code", "ean_code", "ean13", "gtin13", "gtin14", "isbn"], label: "Barcode" },
};

/** Columns the export writes that a new record cannot take: it is given its
 *  own. Named in the preview, so nobody wonders where they went. */
const IDENTITY_COLUMNS: Record<string, string> = {
  asset_id: "a new record gets its own asset number",
  created_at: "a new record is made now",
};

function detectHeaders(rawHeaders: string[], claimed: Set<number>): Record<string, number> {
  const result: Record<string, number> = {};
  const norm = rawHeaders.map((h) => h.toLowerCase().trim());
  for (const [field, { headers }] of Object.entries(COLUMNS)) {
    for (const syn of headers) {
      const idx = norm.findIndex((h, i) => h === syn && !claimed.has(i));
      if (idx >= 0) {
        result[field] = idx;
        claimed.add(idx);
        break;
      }
    }
  }
  return result;
}

/** Which CSV column carries each of the table's own fields. The export writes
 *  the field NAME as the header; a hand-made file may use the label instead,
 *  so both match, case-insensitively. A native column never doubles as an own
 *  field: those are claimed first. */
function detectOwnFields(rawHeaders: string[], fields: DefinedField[], claimed: Set<number>): Array<{ field: DefinedField; idx: number }> {
  const norm = rawHeaders.map((h) => h.toLowerCase().trim());
  const out: Array<{ field: DefinedField; idx: number }> = [];
  for (const field of fields) {
    const wants = [field.name.toLowerCase(), field.display_label.toLowerCase()];
    const idx = norm.findIndex((h, i) => !claimed.has(i) && wants.includes(h));
    if (idx >= 0) {
      out.push({ field, idx });
      claimed.add(idx);
    }
  }
  return out;
}

// ─────────────────────── Cells ────────────────────────

/** A cell as text, or a reason it is not the column's type. */
type Read<T> = { ok: true; value: T | undefined } | { ok: false; reason: string };

function asNumber(raw: string): number | null {
  // Currency signs and thousands separators are how a spreadsheet shows a
  // number; anything else left over means it is not one.
  const cleaned = raw.replace(/[$€£¥]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function readNumber(raw: string | undefined, label: string): Read<number> {
  if (raw === undefined) return { ok: true, value: undefined };
  const n = asNumber(raw);
  return n === null ? { ok: false, reason: `${label} "${raw}" is not a number` } : { ok: true, value: n };
}

const TRUE = new Set(["true", "yes", "y", "1"]);
const FALSE = new Set(["false", "no", "n", "0"]);

function readBool(raw: string | undefined, label: string): Read<boolean> {
  if (raw === undefined) return { ok: true, value: undefined };
  const s = raw.toLowerCase();
  if (TRUE.has(s)) return { ok: true, value: true };
  if (FALSE.has(s)) return { ok: true, value: false };
  return { ok: false, reason: `${label} "${raw}" is not yes or no` };
}

function readDay(raw: string | undefined, label: string): Read<string> {
  if (raw === undefined) return { ok: true, value: undefined };
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
  return m ? { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` } : { ok: false, reason: `${label} "${raw}" is not a date (write it as 2027-01-31)` };
}

/** A cell of the table's own field, typed by its definition. A number or a
 *  yes/no that does not read as one is a reason, never a guess; everything
 *  else is cast the way every other door stores it ("4k7" in a measure
 *  field is 4700 Ω, a date is a day). */
function readOwn(field: DefinedField, raw: string | undefined): Read<unknown> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (field.type === "number") return readNumber(raw, field.display_label);
  if (field.type === "boolean") return readBool(raw, field.display_label);
  return { ok: true, value: castFieldValue(field.type, raw, field.unit ?? null) };
}

/** A schema refusal as a sentence about the cell: which column, what was
 *  written, and what it must be. */
function refusalOf(issue: z.ZodIssue, written: Record<string, string | undefined>): string {
  const key = String(issue.path[0] ?? "");
  const label = COLUMNS[key]?.label ?? key;
  const raw = written[key];
  const what = raw === undefined ? label : `${label} "${raw}"`;
  if (issue.code === "too_small" && issue.type === "number") return `${what} is below zero`;
  if (issue.code === "too_big" && issue.type === "string") return `${what} is longer than ${issue.maximum} characters`;
  if (issue.code === "invalid_enum_value") return `${what} is not one of: ${issue.options.join(", ")}`;
  if (issue.code === "invalid_string" && issue.validation === "url") return `${what} is not a web address`;
  return `${what}: ${issue.message}`;
}

// ─────────────────────── The plan ────────────────────────

/** Read a CSV into the rows an import would make and the rows it would not,
 *  with every reason. Pure: names are resolved after (resolveNames). */
export function planCsv(text: string, ownFields: DefinedField[] = []): ImportPlan {
  let grid: string[][];
  try {
    grid = parseCsv(text.replace(/^﻿/, ""), { strict: true });
  } catch (e) {
    return { rows: [], errors: [{ row_number: 0, message: (e as Error).message }], detected_headers: {}, unread_columns: [] };
  }
  const cellsOf = (r: string[]) => r.map((s) => unguardCsvText(s.trim()));
  const records = grid.map(cellsOf).map((cells, i) => ({ cells, row_number: i + 1 })).filter((r) => r.cells.some((c) => c !== ""));
  if (records.length === 0) return { rows: [], errors: [{ row_number: 0, message: "Empty CSV" }], detected_headers: {}, unread_columns: [] };

  const headers = records[0]!.cells;
  const claimed = new Set<number>();
  const colIdx = detectHeaders(headers, claimed);
  const ownCols = detectOwnFields(headers, ownFields, claimed);

  const detected_headers: Record<string, string | null> = {};
  for (const field of Object.keys(COLUMNS)) {
    const idx = colIdx[field];
    detected_headers[field] = idx === undefined ? null : (headers[idx] ?? null);
  }
  // The table's own fields show in the preview beside the native ones, so a
  // person can see that "author" was recognised before committing.
  for (const { field, idx } of ownCols) detected_headers[field.name] = headers[idx] ?? null;

  const unread_columns = headers.flatMap((h, i) =>
    claimed.has(i) || h === "" ? [] : [{ header: h, reason: IDENTITY_COLUMNS[h.toLowerCase()] ?? "no field of this table is called that" }],
  );

  if (colIdx.name === undefined) {
    return {
      rows: [],
      errors: [{ row_number: 1, message: "No 'name' column detected — couldn't find one of: " + COLUMNS.name!.headers.join(", ") }],
      detected_headers,
      unread_columns,
    };
  }

  const rows: ParsedRow[] = [];
  const errors: ImportPlan["errors"] = [];
  for (const { cells, row_number } of records.slice(1)) {
    const get = (col: string): string | undefined => {
      const idx = colIdx[col];
      const v = idx === undefined ? undefined : cells[idx];
      return v === undefined || v === "" ? undefined : v;
    };
    const name = recordName(get("name") ?? "");
    if (!name) {
      errors.push({ row_number, message: "Missing name, skipped" });
      continue;
    }

    const reasons: string[] = [];
    const take = <T>(r: Read<T>): T | undefined => {
      if (r.ok) return r.value;
      reasons.push(r.reason);
      return undefined;
    };
    const metadata: Record<string, unknown> = {};
    for (const { field, idx } of ownCols) {
      const v = take(readOwn(field, cells[idx] === "" ? undefined : cells[idx]));
      if (v !== undefined) metadata[field.name] = v;
    }
    const written: Record<string, string | undefined> = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, get(k)]));
    const candidate = {
      name,
      description: get("description"),
      qty: take(readNumber(get("qty"), COLUMNS.qty!.label)),
      approximate_qty: take(readNumber(get("approximate_qty"), COLUMNS.approximate_qty!.label)),
      unit: get("unit"),
      cost: take(readNumber(get("cost"), COLUMNS.cost!.label)),
      min_qty: take(readNumber(get("min_qty"), COLUMNS.min_qty!.label)),
      manufacturer: get("manufacturer"),
      notes: get("notes"),
      state: get("state")?.toLowerCase().replace(/[\s-]+/g, "_"),
      serial_number: get("serial_number"),
      model_number: get("model_number"),
      assigned_to: get("assigned_to"),
      warranty_expires: take(readDay(get("warranty_expires"), COLUMNS.warranty_expires!.label)),
      lifetime_warranty: take(readBool(get("lifetime_warranty"), COLUMNS.lifetime_warranty!.label)),
      warranty_details: get("warranty_details"),
      insured: take(readBool(get("insured"), COLUMNS.insured!.label)),
      archived: take(readBool(get("archived"), COLUMNS.archived!.label)),
      supplier_url: get("supplier_url"),
    };
    // The schema a record made by hand is held to, so the import refuses
    // exactly what creating it one at a time would.
    const checked = PartCreate.safeParse(candidate);
    if (!checked.success) reasons.push(...checked.error.issues.map((i) => refusalOf(i, written)));
    if (reasons.length || !checked.success) {
      errors.push({ row_number, message: reasons.join("; ") });
      continue;
    }
    const d = checked.data;
    rows.push({
      name: d.name,
      description: d.description ?? null,
      qty: d.qty ?? 0,
      approximate_qty: d.approximate_qty ?? null,
      unit: d.unit ?? null,
      cost: d.cost ?? null,
      min_qty: d.min_qty ?? null,
      manufacturer: d.manufacturer ?? null,
      notes: d.notes ?? null,
      state: d.state ?? null,
      category_name: get("category") ?? null,
      location_name: get("location") ?? null,
      serial_number: d.serial_number ?? null,
      model_number: d.model_number ?? null,
      assigned_to: d.assigned_to ?? null,
      warranty_expires: d.warranty_expires ?? null,
      lifetime_warranty: d.lifetime_warranty ?? false,
      warranty_details: d.warranty_details ?? null,
      insured: d.insured ?? false,
      archived: d.archived ?? false,
      supplier_url: d.supplier_url ?? null,
      // "4000-0002-0993" and "4000 0002 0993" are the same code a scan reads.
      barcode: get("barcode")?.replace(/[\s-]/g, "") || null,
      metadata,
      row_number,
      warnings: [],
    });
  }
  return { rows, errors, detected_headers, unread_columns };
}

interface Resolved {
  category_id: string | null;
  location_id: string | null;
}

/** Each row's category and place by name, the same for the preview and the
 *  commit. A name the workspace has no match for is said on the row, with
 *  what the import uses instead. */
async function resolveNames(req: Request, plan: ImportPlan, defaults: { category?: string | null; location?: string | null }): Promise<Resolved[]> {
  const db = tenantDb(req);
  const ctx = tenantContext(req);
  const cats = await db.selectFrom("inventory_categories").select(["id", "name"]).execute();
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  // Locations are owned by core-locations — cross-module read goes
  // through the platform resolver, never a direct SELECT.
  const locsResult = await platform().entities.list(ctx.org.id, "core-locations:location", { limit: 500 });
  const locByName = new Map<string, string>();
  for (const loc of locsResult.items) {
    const name = String(loc.title ?? "").toLowerCase();
    if (name) locByName.set(name, loc.id);
  }
  const instead = (fallback: string | null | undefined) => (fallback ? "the default you chose is used" : "it is left without one");
  return plan.rows.map((row) => {
    const category_id = row.category_name ? (catByName.get(row.category_name.toLowerCase()) ?? null) : null;
    if (row.category_name && !category_id) row.warnings.push(`No category is called "${row.category_name}", so ${instead(defaults.category)}`);
    const location_id = row.location_name ? (locByName.get(row.location_name.toLowerCase()) ?? null) : null;
    if (row.location_name && !location_id) row.warnings.push(`No place is called "${row.location_name}", so ${instead(defaults.location)}`);
    return { category_id: category_id ?? defaults.category ?? null, location_id: location_id ?? defaults.location ?? null };
  });
}

// ────────────────────────── HTTP routes ──────────────────────────

// AI-REACH: exempt takes or produces a file (multipart or binary), which an action cannot carry
importRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    // Bulk import IS a create — gate it on the same capability as
    // POST /parts so a member can't bulk-insert past the permission.
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    // The table this import lands in. A named collection (a Bookshelf) has
    // its own fields under `<instance>:item` and its own rows under the
    // instance column; both used to be ignored, so a bookshelf's file came
    // back as bare parts in the base inventory.
    const instance = instanceOf(req);
    const kind = instance === "inventory" ? "inventory:part" : `${instance}:item`;
    const ctx = tenantContext(req);
    const ownFields = await platform().entities.fieldsFor(ctx.org.id, kind);
    const plan = planCsv(parsed.data.csv, ownFields);
    const resolved = await resolveNames(req, plan, { category: parsed.data.default_category_id, location: parsed.data.default_location_id });
    const answer = { rows: plan.rows, errors: plan.errors, detected_headers: plan.detected_headers, unread_columns: plan.unread_columns };

    if (parsed.data.dry_run || plan.rows.length === 0) {
      res.json({ ...answer, committed: 0 });
      return;
    }

    const db = tenantDb(req);
    const session = sessionUser(req);
    const currency = await platform().money.currency(ctx.org.id);
    const now = new Date();
    // Bulk-insert in chunks. A 40k import was 32s of row-by-row round trips;
    // chunked multi-row inserts bring it to a couple of seconds.
    const valueRows = plan.rows.map((row, i) => ({
      instance,
      name: row.name,
      description: row.description,
      qty: String(row.qty),
      approximate_qty: row.approximate_qty == null ? null : String(row.approximate_qty),
      estimated_at: row.approximate_qty == null ? null : now,
      unit: row.unit ?? instanceQtyUnit(req) ?? "each",
      cost: row.cost == null ? null : String(row.cost),
      min_qty: row.min_qty == null ? null : String(row.min_qty),
      manufacturer: row.manufacturer,
      notes: row.notes,
      state: row.state ?? "active",
      category_id: resolved[i]!.category_id,
      location_id: resolved[i]!.location_id,
      serial_number: row.serial_number,
      model_number: row.model_number,
      assigned_to: row.assigned_to,
      warranty_expires: row.warranty_expires,
      lifetime_warranty: row.lifetime_warranty,
      warranty_details: row.warranty_details,
      insured: row.insured,
      archived: row.archived,
      supplier_url: row.supplier_url,
      metadata: {
        ...row.metadata,
        ...(row.barcode ? { barcode: row.barcode } : {}),
        ...(row.cost == null ? {} : { money_currencies: { cost: fieldCurrency(row.metadata, "cost", currency) } }),
      },
    }));

    const CHUNK = 500;
    const inserted = await db.transaction().execute(async (trx) => {
      const ids: string[] = [];
      for (let i = 0; i < valueRows.length; i += CHUNK) {
        const rows = await trx
          .insertInto("inventory_parts")
          .values(valueRows.slice(i, i + CHUNK))
          .returning("id")
          .execute();
        ids.push(...rows.map((r) => r.id));
      }
      return ids;
    });

    // Each record's own History says it was made by this import (#5963):
    // one part_created per row, written in one INSERT per chunk and marked
    // as an import's row, so the feeds show only the summary line below.
    // Per-row part.created events stay dropped: nothing subscribes to them,
    // and search indexes via the generated search_blob column, not an event.
    await platform().activity.logMany({
      orgId: ctx.org.id,
      userId: session.id,
      rows: inserted.map((id, i) => ({
        action: "part_created",
        ref: { module: "inventory", entityType: "part", entityId: id },
        diff: { name: valueRows[i]?.name ?? null, qty: valueRows[i]?.qty ?? null, instance, source: "csv_import" },
      })),
    });
    // And ONE summary entry for the import itself, the feeds' line.
    try {
      await platform().activity.log({
        orgId: ctx.org.id,
        userId: session.id,
        action: "parts_imported",
        ref: { module: "inventory", entityType: "part", entityId: inserted[0] ?? "" },
        diff: { count: inserted.length, source: "csv_import" },
      });
    } catch (err) {
      console.error("[import] activity log failure:", err);
    }

    res.json({ ...answer, committed: inserted.length, ids: inserted });
  }),
);
