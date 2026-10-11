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
 *  repeat. */
export async function makeNextOccurrence(orgId: string, db: Kysely<ProjectsDB>, taskId: string): Promise<string | null> {
  const t = await db.selectFrom("projects_tasks").selectAll().where("id", "=", taskId).executeTakeFirst();
  if (!t) return null;
  const rule = repeatOf(t.repeat);
  if (!rule) return null;
  // DAY-OK: projects_tasks.due_date is a timestamptz, read here as the instant it holds.
  const from = new Date(t.due_date ?? t.completed_at ?? new Date());
  // A series on a due date keeps its day of the month across short months;
  // one with no due date counts from when it was done and has no anchor.
  const anchor = t.due_date ? seriesAnchorDay(from, rule.anchor_day, rule.every_unit) : null;
  const due = addInterval(from, rule.every_n, rule.every_unit, 1, anchor);
  const nextRule: RepeatRule = { every_n: rule.every_n, every_unit: rule.every_unit, ...(anchor ? { anchor_day: anchor } : {}) };
  const top = t.project_id
    ? await db.selectFrom("projects_tasks").select(sql<number>`coalesce(min(order_within), 0)`.as("m")).where("project_id", "=", t.project_id).executeTakeFirst()
    : undefined;
  const steps = ((t.checklist as ChecklistItem[] | null) ?? []).map((i) => ({ ...i, done: false }));
  const next = await db
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
      instance: t.instance,
      ...(top ? { order_within: Number(top.m) - 1 } : {}),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  platform().events.emit("projects.task.created", { orgId, taskId: next.id, repeatOf: t.id });
  return next.id;
}
