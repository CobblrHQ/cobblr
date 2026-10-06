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

import { adoptAxisValuesIntoField, findRowIdByKey, mergeRowMetadata, platform, restoreRow, snapshotRow, snapshotRowTree, restoreRowTree, rowVersionOf, updateRowAt } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";
import { DISPOSITION_LABELS, dispositionOf } from "@cobblr/platform-contract/disposition";

const PRIOR_STATE = "state_before_it_left";

let registered = false;

/** What `update` and `updateIf` write for these fields. */
function patchOf(fields: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (fields.name !== undefined) patch.name = String(fields.name);
  if (fields.location_id !== undefined) patch.location_id = asStr(fields.location_id);
  if (fields.type !== undefined) patch.type = asStr(fields.type);
  if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
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
    snapshotDeletion: async (orgId, id) => snapshotRowTree(await platform().tenants.getDb(orgId), "assets_assets", id, "assets_"),
    restoreDeletion: async (orgId, snapshot) => restoreRowTree(await platform().tenants.getDb(orgId), "assets_assets", snapshot, "assets_"),
    // A record that already carries the source's key is adopted by a sync, never
    // duplicated (#3836).
    findByKey: async (orgId, key, value) => findRowIdByKey(await platform().tenants.getDb(orgId), "assets_assets", key, value),
    mergeMetadata: async (orgId, id, fields) => mergeRowMetadata(await platform().tenants.getDb(orgId), "assets_assets", id, fields),
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const inserted = await db
        .insertInto("assets_assets")
        .values({
          name: String(fields.name ?? "Untitled"),
          // The asset's category (its declared categoryField): an import or a
          // sync that knows it writes it here, the one place the form shows.
          type: asStr(fields.type),
          location_id: asStr(fields.location_id),
          notes: asStr(fields.notes),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      await db.updateTable("assets_assets").set(patchOf(fields) as never).where("id", "=", id).execute();
      // No emit — see the file header.
    },

    version: async (orgId, id) => rowVersionOf(await platform().tenants.getDb(orgId), "assets_assets", id),

    async updateIf(orgId, id, fields, version) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const v = await updateRowAt(db, "assets_assets", id, patchOf(fields), version);
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
