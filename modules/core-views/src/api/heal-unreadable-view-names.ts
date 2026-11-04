// One-shot heal: a view could be saved named only spaces or invisible
// characters, which draws a row with nothing on it to read or press. Each gets
// a plain name, so it can be seen and renamed or deleted.
//
// DONE WHEN: no core_views_views.name lacks something to read. Check prod,
// staging and dev, then delete this file and its registration in api/index.ts.
//
// BORN WITH: the view routes refuse such a name (hasSomethingToRead).

import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { hasSomethingToRead } from "@cobblr/platform-contract/readable-text";

export const NO_NAME = "Unnamed view";

export async function healUnreadableViewNames(db: Kysely<unknown>, since: Date): Promise<number> {
  const rows = await sql<{ id: string; name: string }>`select id, name from core_views_views where created_at < ${since} and name !~ '[[:alnum:]]'`.execute(db);
  let healed = 0;
  for (const r of rows.rows) {
    if (hasSomethingToRead(r.name)) continue;
    await sql`update core_views_views set name = ${NO_NAME} where id = ${r.id}`.execute(db);
    healed++;
  }
  return healed;
}

export function registerUnreadableViewNamesHeal(): void {
  registerHealPass({
    name: "core-views.unreadable-names",
    since: "2026-11-05T01:20:00Z",
    shim: "modules/core-views/src/api/heal-unreadable-view-names.ts",
    module: "core-views",
    visit: ({ db, since }) => healUnreadableViewNames(db as Kysely<unknown>, since),
  });
}
