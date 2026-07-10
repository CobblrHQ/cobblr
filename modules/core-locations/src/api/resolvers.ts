// Entity-kind resolvers for core-locations. Lets every module that
// references a location_id resolve it back to a human-displayable
// chip without knowing the locations table shape.

import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";

let registered = false;

export function registerLocationsResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver(
    "core-locations:location",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const row = await db
        .selectFrom("core_locations_locations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toResolved(row);
    },
  );

  platform().entities.registerListResolver(
    "core-locations:location",
    async (orgId, query) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
      const limit = Math.min(query.limit ?? 50, 200);
      const offset = query.offset ?? 0;
      let q = db.selectFrom("core_locations_locations").selectAll();
      if (query.q && query.q.length > 0) {
        const needle = `%${query.q.toLowerCase()}%`;
        q = q.where((eb) =>
          eb.or([
            eb(eb.fn("lower", ["name"]), "like", needle),
            eb(eb.fn("lower", ["short_name"]), "like", needle),
          ]),
        );
      }
      if (query.filter) {
        for (const [key, val] of Object.entries(query.filter)) {
          if (val === undefined || val === null) continue;
          if (key === "kind" && typeof val === "string") {
            q = q.where("kind", "=", val as "area" | "container");
            continue;
          }
          if (key === "parent_id" && typeof val === "string") {
            q = q.where("parent_id", "=", val);
            continue;
          }
          if (key === "_tag") {
            const tagName = String(val).trim().toLowerCase();
            q = q.where(sql<boolean>`exists (
              select 1 from core_tags_assignments a
              join core_tags_tags t on t.id = a.tag_id
              where a.source_module = 'core-locations'
                and a.source_type = 'location'
                and a.source_id = core_locations_locations.id
                and lower(t.name) = ${tagName}
            )`);
            continue;
          }
          // Fall through to metadata field lookup.
          q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
        }
      }
      const rows = await q
        // Match the /locations list endpoint's order EXACTLY so the user's
        // manual sibling order (set by drag → `position`) is honoured
        // EVERYWHERE locations surface through the generic layer — pickers,
        // the labels browser, other modules' location dropdowns — not just on
        // the Locations page. Shallow first, then manual order, then natural
        // name as the tiebreaker.
        .orderBy("depth")
        .orderBy("position")
        .orderBy("name")
        .limit(limit)
        .offset(offset)
        .execute();
      return { items: rows.map(toResolved) };
    },
  );
}

function toResolved(row: {
  id: string;
  name: string;
  short_name: string | null;
  metadata?: Record<string, unknown> | null;
  kind: "area" | "container";
  parent_id: string | null;
  depth: number;
  position?: number;
}): ResolvedEntity {
  return {
    kind: "core-locations:location",
    id: row.id,
    title: row.short_name ?? row.name,
    subtitle: row.kind,
    fields: {
      name: row.name,
      short_name: row.short_name,
      kind: row.kind,
      parent_id: row.parent_id,
      depth: row.depth,
      position: row.position,
      // Declared interior size ({x,y,z} in mm) — the ONLY metadata key
      // exposed through the generic layer; the rest of the blob stays
      // private to core-locations.
      interior_mm: (row.metadata as { interior_mm?: unknown } | null)?.interior_mm ?? null,
    },
  };
}
