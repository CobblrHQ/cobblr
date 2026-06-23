// In-process entity writer for core-locations:location.
//
// Lets cross-module writers (the core-integrations sync engine, mirroring an
// external system) create/update/delete locations with NO HTTP loopback or
// user token. Depth is recomputed from the parent and the same module events
// fire, so hierarchy + wires + views stay consistent with the HTTP path.

import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";

let registered = false;

export function registerLocationsWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("core-locations:location", {
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const inserted = await db
        .insertInto("core_locations_locations")
        .values({
          name: String(fields.name ?? "Untitled"),
          short_name: asStr(fields.short_name),
          parent_id: asStr(fields.parent_id),
          depth: await depthFor(db, asStr(fields.parent_id)),
          kind: normalizeKind(fields.kind),
          metadata: sql`${JSON.stringify(fields.metadata ?? {})}::jsonb` as never,
          description: asStr(fields.description),
          notes: asStr(fields.notes),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      void platform().events.emit("core-locations.location.created", {
        orgId,
        locationId: inserted.id,
      });
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.short_name !== undefined) patch.short_name = asStr(fields.short_name);
      if (fields.kind !== undefined) patch.kind = normalizeKind(fields.kind);
      if (fields.description !== undefined) patch.description = asStr(fields.description);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
      if (fields.metadata !== undefined) {
        patch.metadata = sql`${JSON.stringify(fields.metadata ?? {})}::jsonb`;
      }
      if (fields.parent_id !== undefined) {
        const parentId = asStr(fields.parent_id);
        patch.parent_id = parentId;
        patch.depth = await depthFor(db, parentId);
      }
      await db
        .updateTable("core_locations_locations")
        .set(patch as never)
        .where("id", "=", id)
        .execute();
      void platform().events.emit("core-locations.location.updated", { orgId, locationId: id });
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      await db.deleteFrom("core_locations_locations").where("id", "=", id).execute();
      void platform().events.emit("core-locations.location.deleted", { orgId, locationId: id });
    },

    // Existing locations, for the import preview's name-merge — so importing a
    // companion app room/bin that already exists by name links into it instead of
    // duplicating. Name-only match (parent precision is best-effort here).
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const rows = await db
        .selectFrom("core_locations_locations")
        .select(["id", "name", "parent_id"])
        .execute();
      return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
    },
  });
}

/** Depth = parent's depth + 1 (a cheap lookup; the locations module tracks
 *  depth server-side to avoid recursive CTEs on read). */
async function depthFor(db: Kysely<CoreLocationsDB>, parentId: string | null): Promise<number> {
  if (!parentId) return 0;
  const parent = await db
    .selectFrom("core_locations_locations")
    .select("depth")
    .where("id", "=", parentId)
    .executeTakeFirst();
  return parent ? parent.depth + 1 : 0;
}

function normalizeKind(k: unknown): "container" | "area" {
  return k === "area" ? "area" : "container";
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
