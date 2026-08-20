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

import { platform, restoreRow, snapshotRow } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";

let registered = false;

export function registerAssetsWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("assets:asset", {
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      const inserted = await db
        .insertInto("assets_assets")
        .values({
          name: String(fields.name ?? "Untitled"),
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
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.location_id !== undefined) patch.location_id = asStr(fields.location_id);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
      if (fields.metadata !== undefined) {
        patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
      }
      await db.updateTable("assets_assets").set(patch as never).where("id", "=", id).execute();
      // No emit — see the file header.
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
      await db.deleteFrom("assets_assets").where("id", "=", id).execute();
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
