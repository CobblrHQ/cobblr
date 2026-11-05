// One-shot heal: put back the file names an upload mangled, and break any folder loop two moves at once made.
//
// DONE WHEN: no core_files_files row made before `since` has a filename that mangledNameRepaired changes, and no
// core_files_folders row is in a loop of parents. Check prod, staging and dev, then delete this file and its onBoot call.
//
// BORN WITH: uploads.ts reads a multipart file name as UTF-8, and PATCH /folders/:id moves one folder at a time per
// workspace, so a file or folder made now needs neither.
//
// WHY IT EXISTS: a name's UTF-8 bytes were read as Latin-1, so "café.txt" was kept as "cafÃ©.txt" and any name in
// Japanese became unreadable. A loop of folders hangs from nothing, so it and its files drop out of the tree.

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { sql, type Kysely } from "kysely";
import type { CoreFilesDB } from "./db.js";

/** The name it should have been, or null when this isn't UTF-8 read as Latin-1. PURE. A real "é" alone isn't valid
 *  UTF-8 once read back as a byte, so a correct name in French or German is left alone. */
export function mangledNameRepaired(name: string): string | null {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) return null;
  const bytes = Buffer.from(name, "latin1");
  const fixed = bytes.toString("utf8");
  // Bytes that aren't valid UTF-8 don't survive the round trip: this was never a mangled name.
  return Buffer.from(fixed, "utf8").equals(bytes) && fixed !== name ? fixed : null;
}

/** The one folder to lift to the top from each loop of parents. PURE. */
export function foldersToBreakLoops(folders: ReadonlyArray<{ id: string; parent_id: string | null }>): string[] {
  const parent = new Map(folders.map((f) => [f.id, f.parent_id]));
  const safe = new Set<string>();
  const lift: string[] = [];
  for (const f of folders) {
    const path: string[] = [];
    let at: string | null | undefined = f.id;
    while (at && !safe.has(at) && !path.includes(at)) {
      path.push(at);
      at = parent.get(at);
    }
    if (at && path.includes(at)) {
      const loop = path.slice(path.indexOf(at));
      const first = [...loop].sort()[0]!;
      lift.push(first);
      parent.set(first, null);
    }
    for (const id of path) safe.add(id);
  }
  return lift;
}

export async function healFileNamesAndFolderLoops(db: Kysely<CoreFilesDB>, since: Date): Promise<number> {
  let healed = 0;
  const named = await db.selectFrom("core_files_files").select(["id", "filename"]).where("created_at", "<", since).where(sql<boolean>`filename ~ '[^\\x01-\\x7f]'`).execute();
  for (const row of named) {
    const fixed = mangledNameRepaired(row.filename);
    if (!fixed) continue;
    await db.updateTable("core_files_files").set({ filename: fixed }).where("id", "=", row.id).where("filename", "=", row.filename).execute();
    healed++;
  }
  const lift = foldersToBreakLoops(await db.selectFrom("core_files_folders").select(["id", "parent_id"]).execute());
  for (const id of lift) {
    // A folder at the top may already have this name: the lifted one keeps it, with its id's start to tell them apart.
    const taken = await sql<{ taken: boolean }>`
      select exists (select 1 from core_files_folders f join core_files_folders me on me.id = ${id} where f.parent_id is null and f.name = me.name and f.id <> me.id) as taken`.execute(db);
    await db
      .updateTable("core_files_folders")
      .set((eb) => ({ parent_id: null, name: taken.rows[0]?.taken ? sql<string>`left(${eb.ref("name")}, 110) || ' ' || left(${id}, 8)` : eb.ref("name") }))
      .where("id", "=", id)
      .execute();
    healed++;
  }
  return healed;
}

export function registerFileNamesAndFolderLoopsHeal(): void {
  registerHealPass({
    name: "core-files.file-names-and-folder-loops",
    since: "2026-11-06T02:00:00Z",
    shim: "modules/core-files/src/heal-file-names-and-folder-loops.ts",
    module: "core-files",
    visit: ({ db, since }) => healFileNamesAndFolderLoops(db as Kysely<CoreFilesDB>, since),
  });
}
