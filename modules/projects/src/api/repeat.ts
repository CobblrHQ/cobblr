// A repeating task comes round again: finishing it makes the next one, due
// one interval after this one was due (or, with no due date, after it was
// done), with the same name, details, assignee and steps, the steps unticked.
// The calendar step is the one rule every repeating thing shares
// (@cobblr/platform-contract/interval).

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { addInterval, seriesAnchorDay, INTERVAL_UNITS, type IntervalUnit } from "@cobblr/platform-contract/interval";
import type { ChecklistItem, ProjectsDB } from "../db.js";

export interface RepeatRule {
  every_n: number;
  every_unit: IntervalUnit;
  /** The day of the month a month or year series falls on (31 for "the end
   *  of every month" begun on Jan 31). Written by the first step, so the
   *  series returns to it after a short month instead of keeping the 28th. */
  anchor_day?: number;
}

export function repeatOf(v: unknown): RepeatRule | null {
  const r = v as { every_n?: unknown; every_unit?: unknown } | null;
  if (!r || typeof r.every_n !== "number" || r.every_n < 1) return null;
  if (!INTERVAL_UNITS.includes(r.every_unit as IntervalUnit)) return null;
  const anchor = (v as { anchor_day?: unknown }).anchor_day;
  return {
    every_n: r.every_n,
    every_unit: r.every_unit as IntervalUnit,
    ...(typeof anchor === "number" && anchor >= 1 && anchor <= 31 ? { anchor_day: anchor } : {}),
  };
}

/** The next one of a task that was just finished, or null when it does not
 *  repeat. Finishing the same task again (reopened, then done) or finishing it
 *  twice at once gives back the one that is already there: the task row is
 *  locked while the answer is looked up and made, and the next one names the one
 *  it came from (`occurrence_of`, unique), so there is never a second (#7121). */
export async function makeNextOccurrence(orgId: string, db: Kysely<ProjectsDB>, taskId: string): Promise<string | null> {
  const made = await db.transaction().execute(async (trx) => {
    const t = await trx.selectFrom("projects_tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirst();
    if (!t) return null;
    const rule = repeatOf(t.repeat);
    if (!rule) return null;
    const already = await trx.selectFrom("projects_tasks").select("id").where("occurrence_of", "=", t.id).executeTakeFirst();
    if (already) return { id: already.id, created: false as const, from: t.id };
    // DAY-OK: projects_tasks.due_date is a timestamptz, read here as the instant it holds.
    const from = new Date(t.due_date ?? t.completed_at ?? new Date());
    // A series on a due date keeps its day of the month across short months;
    // one with no due date counts from when it was done and has no anchor.
    const anchor = t.due_date ? seriesAnchorDay(from, rule.anchor_day, rule.every_unit) : null;
    const due = addInterval(from, rule.every_n, rule.every_unit, 1, anchor);
    const nextRule: RepeatRule = { every_n: rule.every_n, every_unit: rule.every_unit, ...(anchor ? { anchor_day: anchor } : {}) };
    const top = t.project_id
      ? await trx.selectFrom("projects_tasks").select(sql<number>`coalesce(min(order_within), 0)`.as("m")).where("project_id", "=", t.project_id).executeTakeFirst()
      : undefined;
    const steps = ((t.checklist as ChecklistItem[] | null) ?? []).map((i) => ({ ...i, done: false }));
    // check-then-insert: the finished task's row is locked FOR UPDATE above and occurrence_of is unique, so a second request waits and then finds this one.
    const next = await trx
      .insertInto("projects_tasks")
      .values({
        project_id: t.project_id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        energy: t.energy,
        due_date: due,
        metadata: JSON.stringify(t.metadata ?? {}) as never,
        checklist: JSON.stringify(steps) as never,
        repeat: JSON.stringify(nextRule) as never,
        occurrence_of: t.id,
        instance: t.instance,
        ...(top ? { order_within: Number(top.m) - 1 } : {}),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { id: next.id, created: true as const, from: t.id };
  });
  if (!made) return null;
  if (made.created) platform().events.emit("projects.task.created", { orgId, taskId: made.id, repeatOf: made.from });
  return made.id;
}

/** Take the next occurrence back when finishing was undone, but only if
 *  nobody has touched it: one that was edited, finished or moved is the
 *  person's now and stays. Reopening the finished one later still finds it
 *  there, so finishing again makes no second. */
export async function withdrawUntouchedOccurrence(db: Kysely<ProjectsDB>, taskId: string): Promise<string | null> {
  const gone = await db
    .deleteFrom("projects_tasks")
    .where("occurrence_of", "=", taskId)
    .where("status", "=", "todo")
    .where(sql<boolean>`updated_at = created_at`)
    .returning(["id"])
    .executeTakeFirst();
  return gone?.id ?? null;
}
