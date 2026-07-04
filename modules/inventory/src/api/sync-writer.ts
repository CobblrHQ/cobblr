// In-process entity writer for inventory:part.
//
// The isolation-clean way for another module to READ + WRITE a part without
// touching inventory's table directly (module-isolation) or looping through the
// HTTP route. core-mobility uses it to stamp `away_since` / return an item home.
//
// DELIBERATELY SILENT — update() does NOT emit `inventory.part.updated`. A
// reactor like core-mobility runs ON that event and writes back to the same
// part; an emit here would re-fire the wire. (Contrast machines' writer, which
// emits for the sync engine — inventory's sole writer-consumer today is a
// same-part reactor, so silence is correct. Add an opt-in emit if a future sync
// TARGET needs the cascade.)

import { platform } from "@cobblr/platform-contract";
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
          location_id: asStr(fields.location_id),
          notes: asStr(fields.notes),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.location_id !== undefined) patch.location_id = asStr(fields.location_id);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
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

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
