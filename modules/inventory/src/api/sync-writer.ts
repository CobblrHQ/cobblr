// In-process entity writer for inventory:part.
//
// The isolation-clean way for another module to READ + WRITE a part without
// touching inventory's table directly (module-isolation) or looping through the
// HTTP route. core-mobility uses it to stamp `away_since` / return an item home;
// core-integrations' sync engine uses it to MIRROR a full external item.
//
// It maps every native inventory column the caller supplies (a sync source
// brings serial / warranty / cost / manufacturer …) — anything with no native
// column rides in `metadata`. Only keys actually present in `fields` are
// written, so a partial write (core-mobility stamping one metadata key) touches
// nothing else, and a full mirror (the Homebox sync) lands every column.
//
// DELIBERATELY SILENT — update() does NOT emit `inventory.part.updated`. A
// reactor like core-mobility runs ON that event and writes back to the same
// part; an emit here would re-fire the wire. (Contrast machines' writer, which
// emits for the sync engine — inventory's writer-consumers today are a same-part
// reactor + the sync engine's own upsert, so silence is correct. Add an opt-in
// emit if a future sync TARGET needs the downstream cascade.)

import { platform, restoreRow, snapshotRow } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { InventoryDB } from "../db.js";

let registered = false;

export function registerInventoryWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("inventory:part", {
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const inserted = await db
        .insertInto("inventory_parts")
        .values({
          name: String(fields.name ?? "Untitled"),
          ...nativeValues(fields),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const patch: Record<string, unknown> = { updated_at: new Date(), ...nativeValues(fields) };
      if (fields.metadata !== undefined) {
        patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
      }
      await db.updateTable("inventory_parts").set(patch as never).where("id", "=", id).execute();
      // No emit — see the file header.
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      await db.deleteFrom("inventory_parts").where("id", "=", id).execute();
    },

    /** Put the row back exactly as it was, id and all (EntityWriter.restore).
     *  Not a create: no name-clash rule, no re-derived id, no new row for
     *  everything that pointed at the old one to miss. */
    async restore(orgId, image) {
      await restoreRow(await platform().tenants.getDb(orgId), "inventory_parts", image);
    },

    /** Every column of one row — the state a change ledger keeps so an undo
     *  has something real to put back (EntityWriter.snapshot). */
    async snapshot(orgId, id) {
      return snapshotRow(await platform().tenants.getDb(orgId), "inventory_parts", id);
    },

    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .select(["name", "location_id", "metadata"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return { name: row.name, location_id: row.location_id, metadata: row.metadata };
    },
  });
}

/** Map the supplied `fields` onto native inventory columns, coercing each to the
 *  column's type (numerics → string for kysely, dates as 'YYYY-MM-DD', booleans
 *  normalised). Only keys PRESENT in `fields` are emitted — an absent key leaves
 *  the column at its DB default (create) or untouched (update). `name` +
 *  `metadata` are handled by the caller; everything else lives here. */
function nativeValues(fields: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  const has = (k: string): boolean => k in fields && fields[k] !== undefined;
  if (has("name")) v.name = String(fields.name);
  // The target instance a sync routes into (targetInstance / instanceBy) — so a
  // mirrored item lands under the chosen nav entry, not always the base.
  if (has("instance")) { const i = asStr(fields.instance); if (i != null) v.instance = i; }
  if (has("description")) v.description = asStr(fields.description);
  if (has("category_id")) v.category_id = asStr(fields.category_id);
  if (has("location_id")) v.location_id = asStr(fields.location_id);
  // qty is NOT NULL default 0 — never write null; a null coercion is dropped.
  if (has("qty")) { const n = asNum(fields.qty); if (n != null) v.qty = n; }
  if (has("unit")) { const u = asStr(fields.unit); if (u != null) v.unit = u; }
  if (has("cost")) v.cost = asNum(fields.cost);
  if (has("min_qty")) v.min_qty = asNum(fields.min_qty);
  if (has("manufacturer")) v.manufacturer = asStr(fields.manufacturer);
  if (has("supplier_url")) v.supplier_url = asStr(fields.supplier_url);
  if (has("image_path")) v.image_path = asStr(fields.image_path);
  if (has("notes")) v.notes = asStr(fields.notes);
  if (has("serial_number")) v.serial_number = asStr(fields.serial_number);
  if (has("model_number")) v.model_number = asStr(fields.model_number);
  if (has("warranty_details")) v.warranty_details = asStr(fields.warranty_details);
  if (has("warranty_expires")) v.warranty_expires = asDate(fields.warranty_expires);
  if (has("lifetime_warranty")) v.lifetime_warranty = asBool(fields.lifetime_warranty);
  if (has("insured")) v.insured = asBool(fields.insured);
  if (has("archived")) v.archived = asBool(fields.archived);
  return v;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Numeric columns are text-typed to kysely; return a string or null. */
function asNum(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** A `date` column — pass the raw 'YYYY-MM-DD' (pg casts text→date with no TZ
 *  math, so no midnight-UTC-rolls-to-yesterday drift). Anything else → null. */
function asDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
