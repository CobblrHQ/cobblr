// One-shot heal: a task or project could be saved named only spaces or invisible
// characters, which draws a row with nothing on it to read or press. Each gets
// a plain name, so it can be seen and renamed or deleted.
//
// DONE WHEN: no projects_tasks.title or projects_projects.name lacks something
// to read. Check prod, staging and dev, then delete this file and its
// registration in api/index.ts.
//
// BORN WITH: the task and project doors refuse such a name (hasSomethingToRead).

import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { hasSomethingToRead } from "@cobblr/platform-contract/readable-text";
import type { ProjectsDB } from "../db.js";

export const NO_TITLE = "Untitled task";
export const NO_NAME = "Unnamed project";

export async function healUnreadableNames(db: Kysely<ProjectsDB>, since: Date): Promise<number> {
  let healed = 0;
  const tasks = await sql<{ id: string; title: string }>`select id, title from projects_tasks where created_at < ${since} and title !~ '[[:alnum:]]'`.execute(db);
  for (const t of tasks.rows) {
    if (hasSomethingToRead(t.title)) continue;
    await sql`update projects_tasks set title = ${NO_TITLE} where id = ${t.id}`.execute(db);
    healed++;
  }
  const projects = await sql<{ id: string; name: string }>`select id, name from projects_projects where created_at < ${since} and name !~ '[[:alnum:]]'`.execute(db);
  for (const p of projects.rows) {
    if (hasSomethingToRead(p.name)) continue;
    await sql`update projects_projects set name = ${NO_NAME} where id = ${p.id}`.execute(db);
    healed++;
  }
  return healed;
}

export function registerUnreadableNamesHeal(): void {
  registerHealPass({
    name: "projects.unreadable-names",
    since: "2026-11-05T01:20:00Z",
    shim: "modules/projects/src/api/heal-unreadable-names.ts",
    module: "projects",
    visit: ({ db, since }) => healUnreadableNames(db as Kysely<ProjectsDB>, since),
  });
}
