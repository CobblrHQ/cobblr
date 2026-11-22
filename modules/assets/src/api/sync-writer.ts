// In-process entity writer for assets:asset.
//
// The isolation-clean way for another module to READ + WRITE an asset without
// touching assets' table directly or looping through the HTTP route.
// core-mobility uses it to stamp `away_since` / return an item home.
//
// DELIBERATELY SILENT — update() does NOT emit `assets.asset.updated`: the
// writer's consumer today is a reactor that runs ON that event and writes back
// to the same asset; an emit here would re-fire the wire. Same reasoning as
// inventory's writer (see modules/inventory/src/api/sync-writer.ts).

import { custodyFromLoan } from "./custody.js";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";
import { AssetCreate, AssetUpdate } from "./asset-fields.js";
import { adoptAxisValuesIntoField, findRowIdByKey, mergeRowMetadata, platform, restoreRow, snapshotRow, snapshotRowTree, restoreRowTree, rowVersionOf, updateRowAt } from "@cobblr/platform-contract";
import { storedPicture } from "@cobblr/platform-contract/image-reference";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";
import { DISPOSITION_LABELS, dispositionOf } from "@cobblr/platform-contract/disposition";

const PRIOR_STATE = "state_before_it_left";

let registered = false;

/** What the page's route would be handed for these fields: the keys this writer
 *  reads itself (the picture, a null bag, a price it coerces) are left out or
 *  put in the shape it already accepted, the rest goes to the schema as is. */
function bodyOf(fields: Record<string, unknown>): Record<string, unknown> {
  const { image_path: _picture, metadata, purchase_price_cents: price, ...rest } = fields;
  const body: Record<string, unknown> = { ...rest };
  for (const k of ["location_id", "type", "notes", "short_name", "warranty_until", "manufacturer", "model", "serial_number", "purchased_at", "vendor"]) {
    if (body[k] !== undefined) body[k] = asStr(body[k]);
  }
  // A source that brings a timestamp for a day means that day.
  for (const k of ["purchased_at", "warranty_until"]) {
    const v = body[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) body[k] = v.slice(0, 10);
  }
  if (body.name !== undefined) body.name = String(body.name);
  if (metadata !== undefined && metadata !== null) body.metadata = metadata;
  if (price !== undefined) {
    const c = price === null ? null : Number(price);
    body.purchase_price_cents = c === null || Number.isFinite(c) ? c : null;
  }
  return body;
}

/** The fields, held to what the page's route holds a body to. Keys the schema
 *  does not know (instance, custom fields) pass through untouched. */
function checked(fields: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const parsed = creating ? AssetCreate.safeParse(bodyOf(fields)) : AssetUpdate.safeParse(bodyOf(fields));
  if (!parsed.success) throw new Error(invalidBodyMessage(parsed.error.issues));
  const { metadata: _bag, ...given } = parsed.data;
  return { ...fields, ...given };
}

/** What `update` and `updateIf` write for these fields. */
function patchOf(fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (fields.name !== undefined) patch.name = String(fields.name);
  if (fields.location_id !== undefined) patch.location_id = asStr(fields.location_id);
  if (fields.type !== undefined) patch.type = asStr(fields.type);
  if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
  // What a source that mirrors a register brings: the tag printed on it (the
  // short name), its picture and when the warranty ends.
  if (fields.short_name !== undefined) patch.short_name = asStr(fields.short_name);
  if (fields.image_path !== undefined) patch.image_path = storedPicture(fields.image_path);
  if (fields.warranty_until !== undefined) patch.warranty_until = asStr(fields.warranty_until);
  // What paperwork fills, by role or by its own words (a bill of sale's
  // make, model, VIN, date, price and dealer).
  if (fields.manufacturer !== undefined) patch.manufacturer = asStr(fields.manufacturer);
  if (fields.model !== undefined) patch.model = asStr(fields.model);
  if (fields.serial_number !== undefined) patch.serial_number = asStr(fields.serial_number);
  if (fields.purchased_at !== undefined) patch.purchased_at = asStr(fields.purchased_at);
  if (fields.vendor !== undefined) patch.vendor = asStr(fields.vendor);
  if (fields.purchase_price_cents !== undefined) {
    const c = fields.purchase_price_cents === null ? null : Number(fields.purchase_price_cents);
    patch.purchase_price_cents = c === null || Number.isFinite(c) ? c : null;
  }
  if (fields.metadata !== undefined) {
    patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
  }
  return patch;
}

export function registerAssetsWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("assets:asset", {
    table: "assets_assets",
    counters: {
      // What a tool counts while installed in a machine (assets:record-wear),
      // so a schedule on the tool is due by its own use.
      defs: [{ key: "production_cycles", label: "test cycles" }, { key: "used_cycles", label: "cycles in use" }, { key: "used_prints", label: "prints in use" }, { key: "used_hours", label: "hours in use" }],
      async read(orgId, id) {
        const db = await platform().tenants.getDb(orgId) as Kysely<AssetsDB>;
        const row = await db.selectFrom("assets_assets").select("metadata").where("id", "=", id).executeTakeFirst();
        const m = (row?.metadata as Record<string, unknown> | null) ?? {};
        const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
        return { production_cycles: num(m.production_cycles), used_cycles: num(m.used_cycles), used_prints: num(m.used_prints), used_hours: num(m.used_hours) };
      },
    },
    snapshotDeletion: async (orgId, id) => snapshotRowTree(await platform().tenants.getDb(orgId), "assets_assets", id, "assets_"),
    restoreDeletion: async (orgId, snapshot) => restoreRowTree(await platform().tenants.getDb(orgId), "assets_assets", snapshot, "assets_"),
    // A record that already carries the source's key is adopted by a sync, never
    // duplicated (#3836).
    findByKey: async (orgId, key, value) => findRowIdByKey(await platform().tenants.getDb(orgId), "assets_assets", key, value),
    mergeMetadata: async (orgId, id, fields) => mergeRowMetadata(await platform().tenants.getDb(orgId), "assets_assets", id, fields),
    // A loan shows in Who has it and Due back (custody.ts), and Due back is
    // already a deadline the calendar and Needs you read.
    onLoan: custodyFromLoan,
    loanDueField: "due_back",
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const given = checked({ ...fields, name: fields.name ?? "Untitled" }, true);
      const inserted = await db
        .insertInto("assets_assets")
        .values({
          // Every column the caller supplies lands on the first write, as on an
          // update: a sync mirrors a whole record, and a serial or a picture that
          // only arrived on the SECOND run would never arrive (the hash is stored
          // after the first). `type` is the asset's category (its declared
          // categoryField), the one place the form shows it.
          ...patchOf(given),
          name: String(given.name ?? "Untitled"),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      await db.updateTable("assets_assets").set(patchOf(checked(fields, false)) as never).where("id", "=", id).execute();
      // No emit — see the file header.
    },

    version: async (orgId, id) => rowVersionOf(await platform().tenants.getDb(orgId), "assets_assets", id),

    async updateIf(orgId, id, fields, version) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const v = await updateRowAt(db, "assets_assets", id, patchOf(checked(fields, false)), version);
      // No emit — see the file header.
      return v;
    },

    /** Something that left is put away: out of the register and its totals,
     *  history kept, its State saying how it left. The state it had is kept
     *  so bringing it back puts it back as it was. How it left is in its
     *  metadata (`disposition`). */
    async retire(orgId, id, how) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const row = await db.selectFrom("assets_assets").select("state").where("id", "=", id).executeTakeFirst();
      if (row?.state && !dispositionOf(row.state)) await mergeRowMetadata(db, "assets_assets", id, { [PRIOR_STATE]: row.state });
      await db
        .updateTable("assets_assets")
        .set({ archived_at: sql`coalesce(archived_at, now())`, state: DISPOSITION_LABELS[how.disposition], updated_at: new Date() } as never)
        .where("id", "=", id)
        .execute();
    },

    async unretire(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const row = await db.selectFrom("assets_assets").select(["state", "metadata"]).where("id", "=", id).executeTakeFirst();
      if (!row) return;
      const prior = (row.metadata as Record<string, unknown> | null)?.[PRIOR_STATE];
      await db
        .updateTable("assets_assets")
        .set({
          archived_at: null,
          ...(dispositionOf(row.state) ? { state: typeof prior === "string" ? prior : null } : {}),
          updated_at: new Date(),
        } as never)
        .where("id", "=", id)
        .execute();
      await mergeRowMetadata(db, "assets_assets", id, { [PRIOR_STATE]: null });
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      await db.deleteFrom("assets_assets").where("id", "=", id).execute();
    },

    /** The scan placeholder's values move into `type`, the asset's own
     *  category, before the platform removes the placeholder (#4115). */
    async adoptAxisValues(orgId, args) {
      return adoptAxisValuesIntoField(await platform().tenants.getDb(orgId), "assets_assets", args);
    },

    /** Put the row back exactly as it was, id and all (EntityWriter.restore).
     *  Not a create: no name-clash rule, no re-derived id, no new row for
     *  everything that pointed at the old one to miss. */
    async restore(orgId, image) {
      await restoreRow(await platform().tenants.getDb(orgId), "assets_assets", image);
    },

    /** Every column of one row — the state a change ledger keeps so an undo
     *  has something real to put back (EntityWriter.snapshot). */
    async snapshot(orgId, id) {
      return snapshotRow(await platform().tenants.getDb(orgId), "assets_assets", id);
    },

    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const row = await db
        .selectFrom("assets_assets")
        .select(["name", "location_id", "metadata"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return { name: row.name, location_id: row.location_id, metadata: row.metadata };
    },
  });
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
