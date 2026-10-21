// In-process entity writer for core-locations:location.
//
// Lets cross-module writers (the core-integrations sync engine, mirroring an
// external system) create/update/delete locations with NO HTTP loopback or
// user token. Depth is recomputed from the parent and the same module events
// fire, so hierarchy + wires + views stay consistent with the HTTP path.

import { duplicateSiblingMessage, siblingNamed } from "./siblings.js";
import { DuplicateRecordError, findRowIdByKey, imageId, platform, restoreRow, snapshotRow, snapshotRowTree, restoreRowTree } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";
import { deletePlace, restoreDeletedPlace } from "./place-delete.js";
import { movePlace } from "./place-move.js";

let registered = false;

export function registerLocationsWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("core-locations:location", {
    table: "core_locations_locations",
    // A record that already carries the source's key is adopted by a sync, never
    // duplicated (#3836).
    findByKey: async (orgId, key, value) => findRowIdByKey(await platform().tenants.getDb(orgId), "core_locations_locations", key, value),
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      // Same rule as the REST route, because this is the door an assistant
      // comes through. The THROW is the point: the agent loop feeds a failed
      // write back to the model, so it learns the shelf is already there and
      // says so, instead of quietly making a second one.
      if (fields.allow_duplicate !== true) {
        const parentId = asStr(fields.parent_id);
        const name = String(fields.name ?? "Untitled");
        const clash = await siblingNamed(db, parentId, name);
        if (clash) {
          const place = parentId
            ? await db
                .selectFrom("core_locations_locations")
                .select("name")
                .where("id", "=", parentId)
                .executeTakeFirst()
            : null;
          throw new DuplicateRecordError(duplicateSiblingMessage(name, place?.name ?? null), clash.id);
        }
      }
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
      // A move goes through the one seam that refuses a loop (place-move.ts);
      // the throw reaches the assistant, which says why the room stayed put.
      if (fields.parent_id !== undefined) await movePlace(db, id, asStr(fields.parent_id));
      await db
        .updateTable("core_locations_locations")
        .set(patch as never)
        .where("id", "=", id)
        .execute();
      void platform().events.emit("core-locations.location.updated", { orgId, locationId: id });
    },

    async delete(orgId, id) {
      await deletePlace(orgId, id, null);
    },

    /** Put the row back exactly as it was, id and all (EntityWriter.restore).
     *  Not a create: no name-clash rule, no re-derived id, no new row for
     *  everything that pointed at the old one to miss. A place that was
     *  deleted comes back with every place that went with it and each thing
     *  where it was (place-delete.ts), not as one empty shelf. */
    async restore(orgId, image) {
      const id = imageId(image);
      if (id && (await restoreDeletedPlace(orgId, id))) return;
      await restoreRow(await platform().tenants.getDb(orgId), "core_locations_locations", image);
    },

    /** Every column of one row — the state a change ledger keeps so an undo
     *  has something real to put back (EntityWriter.snapshot). */
    async restoreDeletion(orgId, snapshot) {
      const id = imageId(snapshot.image);
      if (id && await restoreDeletedPlace(orgId, id)) return;
      await restoreRowTree(await platform().tenants.getDb(orgId), "core_locations_locations", snapshot, "core_locations_");
    },
    async snapshotDeletion(orgId, id) {
      return snapshotRowTree(await platform().tenants.getDb(orgId), "core_locations_locations", id, "core_locations_");
    },
    async snapshot(orgId, id) {
      return snapshotRow(await platform().tenants.getDb(orgId), "core_locations_locations", id);
    },

    /** What a delete would take with it. The table cascades on parent_id, so
     *  removing a rack removes its shelves — silently, and after any check the
     *  caller made about the rack itself (EntityWriter.dependents). */
    async dependents(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const kids = await db
        .selectFrom("core_locations_locations")
        .select("name")
        .where("parent_id", "=", id)
        .execute();
      return kids.map((k) => k.name);
    },

    // Existing locations, for the import preview's name-merge — so importing a
    // room/bin that already exists by name links into it instead of
    // duplicating.
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const rows = await db
        .selectFrom("core_locations_locations")
        .select(["id", "name", "parent_id", "kind"])
        .execute();
      // Kind and parent are what make a same-name place the same place: a
      // "Shed" in the garage is not the garden's (#6336).
      return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, kind: r.kind }));
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
