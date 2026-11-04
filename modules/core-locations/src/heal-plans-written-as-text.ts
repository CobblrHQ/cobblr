// One-shot heal: importing a workspace's own Locations CSV wrote each floor
// plan back as its JSON text, so the room's plan read as empty. The text is the
// whole plan, so it goes back as the plan. A plan drawn since replaced the
// text, and is left alone.
//
// DONE WHEN: no core_locations_locations row has a string metadata.floorplan.
// Check prod, staging and dev, then delete this file and its registration in
// api/index.ts.
//
// BORN WITH: the import reads a plan's cell back as a plan and refuses any
// other (metadataFromCell in api/import-plan.ts).

import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { CoreLocationsDB } from "./db.js";

/** The plan a text holds, or null when it holds anything else. */
export function planInText(text: string): Record<string, unknown> | null {
  try {
    const plan: unknown = JSON.parse(text);
    return typeof plan === "object" && plan !== null && !Array.isArray(plan) ? (plan as Record<string, unknown>) : null;
  } catch { // pass-catch: text that is not JSON holds no plan; that is the answer, not a failure
    return null;
  }
}

export async function healPlansWrittenAsText(db: Kysely<CoreLocationsDB>, since: Date): Promise<number> {
  const rows = await sql<{ id: string; text: string }>`
    select id, metadata->>'floorplan' as text from core_locations_locations
    where jsonb_typeof(metadata->'floorplan') = 'string' and created_at < ${since}
  `.execute(db);
  let healed = 0;
  for (const r of rows.rows) {
    const plan = planInText(r.text);
    if (!plan) continue;
    // Only while it is still that text: a plan drawn meanwhile stands.
    const done = await sql`
      update core_locations_locations set metadata = jsonb_set(metadata, '{floorplan}', ${JSON.stringify(plan)}::jsonb)
      where id = ${r.id} and metadata->>'floorplan' = ${r.text} and jsonb_typeof(metadata->'floorplan') = 'string'
    `.execute(db);
    healed += Number(done.numAffectedRows ?? 0);
  }
  return healed;
}

export function registerPlansWrittenAsTextHeal(): void {
  registerHealPass({
    name: "core-locations.plans-written-as-text",
    since: "2026-11-04T16:06:00Z",
    shim: "modules/core-locations/src/heal-plans-written-as-text.ts",
    module: "core-locations",
    visit: ({ db, since }) => healPlansWrittenAsText(db as Kysely<CoreLocationsDB>, since),
  });
}
