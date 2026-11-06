// One-shot heal: put back the library file names an upload mangled.
//
// DONE WHEN: no digifab_library row made before `since` has a name that mangledNameRepaired changes. Check prod,
// staging and dev, then delete this file and its onBoot call.
//
// BORN WITH: uploads.ts reads a multipart file name as UTF-8, so a file uploaded now is named right.
//
// WHY IT EXISTS: a name's UTF-8 bytes were read as Latin-1, so a print file called "支架.3mf" was unreadable in the
// library and on what it sent to a machine.

import { mangledNameRepaired } from "@cobblr/platform-contract/mangled-name";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

export async function healMangledLibraryNames(db: Kysely<DigifabDB>, since: Date): Promise<number> {
  let healed = 0;
  const rows = await db.selectFrom("digifab_library").select(["id", "name"]).where("created_at", "<", since).where(sql<boolean>`name ~ '[^\\x01-\\x7f]'`).execute();
  for (const row of rows) {
    const fixed = mangledNameRepaired(row.name);
    if (!fixed) continue;
    await db.updateTable("digifab_library").set({ name: fixed }).where("id", "=", row.id).where("name", "=", row.name).execute();
    healed++;
  }
  return healed;
}

export function registerMangledLibraryNamesHeal(): void {
  registerHealPass({
    name: "digifab.mangled-library-names",
    since: "2026-11-06T02:00:00Z",
    shim: "modules/digifab/src/heal-mangled-library-names.ts",
    module: "digifab",
    visit: ({ db, since }) => healMangledLibraryNames(db as Kysely<DigifabDB>, since),
  });
}
