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
      // Say NO to a field this writer will not apply, rather than dropping it.
      // Every unlisted key below used to be discarded in silence while
      // updated_at was bumped anyway, so the call returned 200 and read as
      // applied. Ask Cobb set `position` 0-11 across twelve racks that way:
      // twelve successful updates, nothing moved, and the only reason anyone
      // noticed is that it read the records back afterwards (2026-08-18).
      const SERVER_OWNED: Record<string, string> = {
        position: "sibling order is set by dragging in the tree (the reorder endpoint), not by updating a location",
        depth: "depth follows parent_id and is recomputed on every move",
      };
      const refused = Object.keys(fields).filter((k) => k in SERVER_OWNED);
      if (refused.length > 0) {
        throw new Error(
          `can't set ${refused.join(", ")} on a location — ${refused.map((k) => SERVER_OWNED[k]).join("; ")}`,
        );
      }
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.short_name !== undefined) patch.short_name = asStr(fields.short_name);
      if (fields.kind !== undefined) patch.kind = normalizeKind(fields.kind);
      if (fields.description !== undefined) patch.description = asStr(fields.description);
      if (fields.notes !== undefined) patch.notes = asStr(fields.notes);
      if (fields.image_path !== undefined) patch.image_path = asStr(fields.image_path);
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
    // room/bin that already exists by name links into it instead of
    // duplicating. Name-only match (parent precision is best-effort here).
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const rows = await db
        .selectFrom("core_locations_locations")
        .select(["id", "name", "parent_id"])
        .execute();
      return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
    },

    // Current fields of one location — lets the import preview show the
    // both-sides diff (what's there now vs what a merge would write).
    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const row = await db
        .selectFrom("core_locations_locations")
        .select(["name", "short_name", "kind", "parent_id", "metadata", "description", "notes", "image_path"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        name: row.name,
        short_name: row.short_name,
        kind: row.kind,
        parent_id: row.parent_id,
        metadata: row.metadata,
        description: row.description,
        notes: row.notes,
        image_path: row.image_path,
      };
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
