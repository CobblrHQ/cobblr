// Write the plan. The deciding is in bundle-locations.ts and is pure; this only
// inserts the rows that plan says are missing.
//
// Kept separate so "what will this do to my locations?" and "do it" cannot
// disagree: a preview that re-derives its answer by a different route than the
// write is a preview that eventually lies.

import { Kysely } from "kysely";
import { getTenantDb } from "../db/tenant.js";
import {
  planLocations,
  locationsToCreate,
  type BundleLocation,
  type ExistingLocation,
  type PlannedLocation,
} from "./bundle-locations.js";

interface LocationsDB {
  core_locations_locations: {
    id: string;
    name: string;
    parent_id: string | null;
    depth: number;
    kind: string;
  };
}

/** Everything already there, flattened to (name, parentName) for the planner. */
async function readExisting(db: Kysely<LocationsDB>): Promise<ExistingLocation[]> {
  const rows = await db
    .selectFrom("core_locations_locations as l")
    .leftJoin("core_locations_locations as p", "p.id", "l.parent_id")
    .select(["l.id as id", "l.name as name", "p.name as parentName"])
    .execute();
  return rows as ExistingLocation[];
}

/** What this bundle WOULD do, without doing it. Used by the install preview. */
export async function previewBundleLocations(
  orgId: string,
  wanted: BundleLocation[],
): Promise<PlannedLocation[]> {
  const db = (await getTenantDb(orgId)) as unknown as Kysely<LocationsDB>;
  return planLocations(wanted, await readExisting(db));
}

export async function applyBundleLocations(
  orgId: string,
  wanted: BundleLocation[],
): Promise<{ created: number }> {
  const db = (await getTenantDb(orgId)) as unknown as Kysely<LocationsDB>;
  const plan = planLocations(wanted, await readExisting(db));
  const todo = locationsToCreate(plan);
  if (todo.length === 0) return { created: 0 };

  // Parents first, so a child created in the same pass has something to hang
  // off. `plan` is already in that order (each parent immediately precedes
  // its children), and ids of newly-made parents get folded in as we go.
  const idByName = new Map<string, string>();
  for (const p of plan) {
    if (p.exists && p.existingId) idByName.set(p.name.toLowerCase(), p.existingId);
  }
  // Real depths for anything already there, so a child lands one below its
  // ACTUAL parent rather than one below an assumed root.
  const depthRows = await db.selectFrom("core_locations_locations").select(["id", "depth"]).execute();
  const depthById = new Map(depthRows.map((r) => [r.id, Number(r.depth)]));

  let created = 0;
    for (const p of todo) {
      const parentId = p.parentName ? (idByName.get(p.parentName.toLowerCase()) ?? null) : null;
      // A child whose parent could not be resolved is skipped rather than
      // silently created at the top level, where it would look like an
      // unrelated stray among everything else already up there.
      if (p.parentName && !parentId) {
        console.warn(`[bundles] skipping ${p.name}: parent ${p.parentName} not resolved`);
        continue;
      }
      // Depth follows the PARENT's depth, not a hardcoded 1. A Kitchen nested
      // under Home is at depth 1, so its Fridge is at 2 - writing 1 there would
      // put the row at a level the tree does not agree with.
      const parentDepth = parentId ? (depthById.get(parentId) ?? 0) : -1;
      const row = await db
        .insertInto("core_locations_locations")
        .values({
          name: p.name,
          parent_id: parentId,
          depth: parentDepth + 1,
          kind: p.kind,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
    idByName.set(p.name.toLowerCase(), row.id);
    created++;
  }
  if (created > 0) console.log(`[bundles] org ${orgId}: created ${created} location(s)`);
  return { created };
}
