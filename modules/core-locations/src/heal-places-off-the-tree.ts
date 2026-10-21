// One-shot heal: two moves that crossed (Garage into Attic, Attic into
// Garage), or the assistant putting a room inside its own shelf, could leave
// places in a loop. A place in a loop never reaches the top, so the tree draws
// neither it nor anything inside it. Each loop's most recently moved place goes
// back to the top level, where the person can see it and put it away again.
//
// DONE WHEN: every core_locations_locations row reaches a row with a null
// parent_id. Check prod, staging and dev, then delete this file and its
// registration in api/index.ts.
//
// BORN WITH: every move goes through movePlace (api/place-move.ts), which
// refuses a loop under the workspace's tree lock, and an import refuses a file
// that would make one.

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { CoreLocationsDB } from "./db.js";
import { movePlace } from "./api/place-move.js";

type Row = { id: string; parent_id: string | null; created_at: Date; updated_at: Date };

/** One loop among `rows`, as its places, or null when every place reaches the top. */
export function aLoop(rows: Row[]): Row[] | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const onTree = new Set<string>();
  for (const r of rows) {
    const chain: Row[] = [];
    const inChain = new Set<string>();
    let cur: Row | undefined = r;
    while (cur && !onTree.has(cur.id) && !inChain.has(cur.id)) {
      chain.push(cur);
      inChain.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (cur && inChain.has(cur.id)) return chain.slice(chain.indexOf(cur));
    for (const c of chain) onTree.add(c.id);
  }
  return null;
}

export async function healPlacesOffTheTree(db: Kysely<CoreLocationsDB>, since: Date): Promise<number> {
  let healed = 0;
  for (;;) {
    const rows = (await db.selectFrom("core_locations_locations").select(["id", "parent_id", "created_at", "updated_at"]).execute()) as Row[];
    const loop = aLoop(rows)?.filter((r) => new Date(r.created_at) < since);
    if (!loop?.length) return healed;
    const latest = loop.reduce((a, b) => (new Date(b.updated_at) > new Date(a.updated_at) ? b : a));
    await movePlace(db, latest.id, null);
    healed++;
  }
}

export function registerPlacesOffTheTreeHeal(): void {
  registerHealPass({
    name: "core-locations.places-off-the-tree",
    since: "2026-10-21T18:00:00Z",
    shim: "modules/core-locations/src/heal-places-off-the-tree.ts",
    module: "core-locations",
    visit: ({ db, since }) => healPlacesOffTheTree(db as Kysely<CoreLocationsDB>, since),
  });
}
