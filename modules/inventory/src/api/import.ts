// CSV bulk import. Dependency-free parser — RFC 4180-ish (handles
// quoted fields, escaped quotes, CRLF). Generic header detection
// matches the columns the user is likely to have without forcing a
// specific schema.
//
// Two modes via `dry_run`: preview (parse + return rows, no DB
// write) and commit (parse + insert). Activity log + part.created
// events fire on commit, one per row.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
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

interface ParsedRow {
  name: string;
  qty: number;
  unit: string | null;
  cost: number | null;
  min_qty: number | null;
  manufacturer: string | null;
  notes: string | null;
  category_name: string | null;
  location_name: string | null;
  // HomeBox parity fields.
  serial_number: string | null;
  model_number: string | null;
  warranty_expires: string | null; // YYYY-MM-DD
  lifetime_warranty: boolean;
  warranty_details: string | null;
  insured: boolean;
  archived: boolean;
  supplier_url: string | null;
  // Verbatim from the CSV so the UI can show which row had a problem.
  row_number: number;
  warnings: string[];
}

function asBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

function asDate(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: { row_number: number; message: string }[];
  detected_headers: Record<string, string | null>;
}

// ─────────────────────────── CSV tokenizer ────────────────────────

/** Parse a single CSV line into its fields. Handles quoted values
 *  with embedded commas + doubled-quotes (RFC 4180). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function splitLines(text: string): string[] {
  // Strip BOM. Split on CRLF/LF/CR, drop empty trailing lines.
  const t = text.replace(/^﻿/, "");
  const lines: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      lines.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines.filter((l) => l.trim().length > 0);
}

// ─────────────────────── Header detection ────────────────────────

const HEADER_SYNONYMS: Record<string, string[]> = {
  name: ["name", "part", "item", "title", "description", "product"],
  qty: ["qty", "quantity", "count", "stock", "on_hand", "on hand"],
  unit: ["unit", "uom"],
  cost: ["cost", "price", "unit_cost", "unit_price", "unit cost", "each", "value"],
  min_qty: ["min_qty", "minimum", "min", "reorder", "reorder_at", "threshold"],
  manufacturer: ["manufacturer", "brand", "maker", "vendor"],
  notes: ["notes", "note", "comment", "remarks", "description"],
  category: ["category", "type", "group", "kind"],
  location: ["location", "bin", "shelf", "where", "place"],
  // HomeBox parity fields (round-trips with /parts/export.csv).
  serial_number: ["serial_number", "serial", "sn"],
  model_number: ["model_number", "model", "model_no"],
  warranty_expires: ["warranty_expires", "warranty", "warranty_until", "expires"],
  warranty_details: ["warranty_details", "warranty_notes"],
  lifetime_warranty: ["lifetime_warranty", "lifetime"],
  insured: ["insured"],
  archived: ["archived"],
  supplier_url: ["supplier_url", "supplier", "url", "link"],
};

function detectHeaders(rawHeaders: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  const norm = rawHeaders.map((h) => h.toLowerCase().trim());
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const syn of synonyms) {
      const idx = norm.indexOf(syn);
      // First match wins. If 'description' appears twice (name +
      // notes both have it), the synonym ordering above resolves
      // the precedence.
      if (idx >= 0 && result[field] === undefined) {
        result[field] = idx;
        break;
      }
    }
  }
  return result;
}

// ───────────────────────── Row processing ────────────────────────

function asNumber(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  // Strip currency-y stuff: $, €, commas as thousands separators.
  const cleaned = v.replace(/[$€£¥]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text: string): ParseResult {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return { rows: [], errors: [{ row_number: 0, message: "Empty CSV" }], detected_headers: {} };
  }
  const headers = parseCsvLine(lines[0]!);
  const colIdx = detectHeaders(headers);

  const detected_headers: Record<string, string | null> = {};
  for (const field of Object.keys(HEADER_SYNONYMS)) {
    const idx = colIdx[field];
    detected_headers[field] = idx === undefined ? null : (headers[idx] ?? null);
  }

  if (colIdx.name === undefined) {
    return {
      rows: [],
      errors: [
        { row_number: 1, message: "No 'name' column detected — couldn't find one of: " + HEADER_SYNONYMS.name!.join(", ") },
      ],
      detected_headers,
    };
  }

  const rows: ParsedRow[] = [];
  const errors: { row_number: number; message: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    const get = (col: string): string | undefined => {
      const idx = colIdx[col];
      return idx === undefined ? undefined : fields[idx];
    };

    const name = (get("name") ?? "").trim();
    if (!name) {
      errors.push({ row_number: i + 1, message: "Missing name, skipped" });
      continue;
    }

    const warnings: string[] = [];
    const qtyRaw = get("qty");
    const qty = qtyRaw ? asNumber(qtyRaw) : 0;
    if (qtyRaw && qty == null) warnings.push(`unparseable qty "${qtyRaw}" → 0`);

    rows.push({
      name,
      qty: qty ?? 0,
      unit: get("unit") || null,
      cost: asNumber(get("cost")),
      min_qty: asNumber(get("min_qty")),
      manufacturer: get("manufacturer") || null,
      notes: get("notes") || null,
      category_name: get("category") || null,
      location_name: get("location") || null,
      serial_number: get("serial_number")?.trim() || null,
      model_number: get("model_number")?.trim() || null,
      warranty_expires: asDate(get("warranty_expires")),
      lifetime_warranty: asBool(get("lifetime_warranty")),
      warranty_details: get("warranty_details")?.trim() || null,
      insured: asBool(get("insured")),
      archived: asBool(get("archived")),
      supplier_url: get("supplier_url")?.trim() || null,
      row_number: i + 1,
      warnings,
    });
  }
  return { rows, errors, detected_headers };
}

// ────────────────────────── HTTP routes ──────────────────────────

importRouter.post(
  "/parts/import",
  asyncHandler(async (req, res) => {
    // Bulk import IS a create — gate it on the same capability as
    // POST /parts so a member can't bulk-insert past the permission.
    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const result = parseCsv(parsed.data.csv);

    if (parsed.data.dry_run || result.rows.length === 0) {
      res.json({
        rows: result.rows,
        errors: result.errors,
        detected_headers: result.detected_headers,
        committed: 0,
      });
      return;
    }

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Look up category by name once (case-insensitive) so we don't
    // N+1. Names that don't match anything fall back to the supplied
    // defaults (or null).
    const cats = await db
      .selectFrom("inventory_categories")
      .select(["id", "name"])
      .execute();
    const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
    // Locations are owned by core-locations — cross-module read goes
    // through the platform resolver, never a direct SELECT.
    const locsResult = await platform().entities.list(
      ctx.org.id,
      "core-locations:location",
      { limit: 500 },
    );
    const locByName = new Map<string, string>();
    for (const loc of locsResult.items) {
      const name = String(loc.title ?? "").toLowerCase();
      if (name) locByName.set(name, loc.id);
    }

    // Resolve category/location per row up-front (pure, no I/O), then
    // bulk-insert in chunks. A 40k import was 32s of row-by-row round
    // trips; chunked multi-row inserts bring it to a couple of seconds.
    const valueRows = result.rows.map((row) => ({
      name: row.name,
      qty: String(row.qty),
      unit: row.unit ?? "each",
      cost: row.cost == null ? null : String(row.cost),
      min_qty: row.min_qty == null ? null : String(row.min_qty),
      manufacturer: row.manufacturer,
      notes: row.notes,
      category_id:
        (row.category_name ? catByName.get(row.category_name.toLowerCase()) : undefined) ??
        parsed.data.default_category_id ??
        null,
      location_id:
        (row.location_name ? locByName.get(row.location_name.toLowerCase()) : undefined) ??
        parsed.data.default_location_id ??
        null,
      serial_number: row.serial_number,
      model_number: row.model_number,
      warranty_expires: row.warranty_expires ? new Date(row.warranty_expires) : null,
      lifetime_warranty: row.lifetime_warranty,
      warranty_details: row.warranty_details,
      insured: row.insured,
      archived: row.archived,
      supplier_url: row.supplier_url,
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

    // ONE summary activity entry — not 40k. A bulk import is a single
    // deliberate action; per-row audit at scale just floods the log
    // (and 40k inserts blew the request budget). Per-row part.created
    // events are dropped too: nothing subscribes to them, and search
    // indexes via the generated search_blob column, not an event.
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

    res.json({
      rows: result.rows,
      errors: result.errors,
      detected_headers: result.detected_headers,
      committed: inserted.length,
      ids: inserted,
    });
  }),
);
