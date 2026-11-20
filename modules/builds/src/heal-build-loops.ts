// One-shot heal pass that only counts: builds saved as each other's
// sub-assembly before the sub-assembly lock (#9649).
//
// DONE WHEN: no tenant DB has a builds_components sub-assembly chain that
// comes back to the build it started from. Check with, per tenant:
//   with recursive up(start, at, seen, looped) as (
//     select build_id, sub_assembly_build_id, array[build_id], false
//       from builds_components where sub_assembly_build_id is not null
//     union all
//     select u.start, c.sub_assembly_build_id, u.seen || u.at, u.at = any(u.seen)
//       from up u join builds_components c on c.build_id = u.at and c.sub_assembly_build_id is not null
//      where not u.looped and cardinality(u.seen) < 64)
//   select count(distinct start) from up where at = start;
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its onBoot call.
//
// BORN WITH: addComponent takes the sub-assembly lock around its loop check
// and its insert (#9649), so a build made now is never made with itself.
//
// WHY IT EXISTS, AND WHY IT ONLY COUNTS: two builds added into each other at
// once, before the lock, were both saved. Which of the two lines is the
// mistake is the person's to say, and taking a line out of a recipe is a
// change to what they wrote, so this heals nothing: each such build says so on
// its page and refuses to run short (loopSentence), and this pass counts them
// until they are gone.

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { sql, type Kysely } from "kysely";
import type { BuildsDB } from "./db.js";

/** How many builds in this workspace are made with themselves. */
export async function buildsInALoop(db: Kysely<BuildsDB>, since: Date): Promise<number> {
  const rows = await sql<{ n: string }>`
    with recursive up(start, at, seen, looped) as (
      select c.build_id, c.sub_assembly_build_id, array[c.build_id], false
        from builds_components c
       where c.sub_assembly_build_id is not null and c.created_at < ${since}
      union all
      select u.start, c.sub_assembly_build_id, u.seen || u.at, u.at = any(u.seen)
        from up u
        join builds_components c on c.build_id = u.at and c.sub_assembly_build_id is not null
       where not u.looped and cardinality(u.seen) < 64
    )
    select count(distinct start)::text as n from up where at = start`.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}

export function registerBuildLoopsCount(): void {
  registerHealPass({
    name: "builds.count-build-loops",
    since: "2026-11-20T00:00:00Z",
    shim: "modules/builds/src/heal-build-loops.ts",
    module: "builds",
    // Found and left: settled, so the workspace is not reopened every round.
    visit: async ({ db, since }) => ({ found: await buildsInALoop(db as Kysely<BuildsDB>, since), settled: true }),
  });
}
