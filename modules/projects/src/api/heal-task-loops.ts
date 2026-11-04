// One-shot heal: two people linking tasks at once, each to the other, could
// both land, because the loop check and the write weren't held together. Tasks
// in a loop read as blocked until someone finishes one anyway. Each loop's most
// recent link goes, which frees them and leaves the wait people meant first.
//
// DONE WHEN: no projects_task_dependencies row is part of a loop. Check prod,
// staging and dev, then delete this file and its registration in api/index.ts.
//
// BORN WITH: every link between tasks goes through addTaskDependency
// (deps.ts), which refuses a loop under the workspace's dependency lock.

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { ProjectsDB } from "../db.js";

export type Link = { id: string; task_id: string; depends_on_task_id: string; created_at: Date };

/** One loop among `links`, as its links, or null when there is none. */
export function aTaskLoop(links: Link[]): Link[] | null {
  const out = new Map<string, Link[]>();
  for (const l of links) out.set(l.task_id, [...(out.get(l.task_id) ?? []), l]);
  const done = new Set<string>();
  for (const start of out.keys()) {
    if (done.has(start)) continue;
    const path: Link[] = [];
    const onPath = new Set<string>([start]);
    const stack: Array<{ task: string; next: number }> = [{ task: start, next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const link = out.get(top.task)?.[top.next++];
      if (!link) {
        done.add(top.task);
        onPath.delete(top.task);
        stack.pop();
        path.pop();
        continue;
      }
      if (onPath.has(link.depends_on_task_id)) {
        const from = path.findIndex((l) => l.task_id === link.depends_on_task_id);
        return [...path.slice(from < 0 ? path.length : from), link];
      }
      if (done.has(link.depends_on_task_id)) continue;
      path.push(link);
      onPath.add(link.depends_on_task_id);
      stack.push({ task: link.depends_on_task_id, next: 0 });
    }
  }
  return null;
}

export async function healTaskLoops(db: Kysely<ProjectsDB>, since: Date): Promise<number> {
  let healed = 0;
  for (;;) {
    const rows = await db
      .selectFrom("projects_task_dependencies")
      .select(["id", "task_id", "depends_on_task_id", "created_at"])
      .where("depends_on_task_id", "is not", null)
      .execute();
    const loop = aTaskLoop(rows as Link[])?.filter((l) => new Date(l.created_at) < since);
    if (!loop?.length) return healed;
    const latest = loop.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
    await db.deleteFrom("projects_task_dependencies").where("id", "=", latest.id).execute();
    healed++;
  }
}

export function registerTaskLoopsHeal(): void {
  registerHealPass({
    name: "projects.task-loops",
    since: "2026-11-05T00:46:00Z",
    shim: "modules/projects/src/api/heal-task-loops.ts",
    module: "projects",
    visit: ({ db, since }) => healTaskLoops(db as Kysely<ProjectsDB>, since),
  });
}
