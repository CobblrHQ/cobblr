// How a member's edit of a project is applied when it does not come through
// the project page: an app's edit form, the API, Cobb (platform:update-fields).
// The same rules as PATCH /projects/:id for the fields it takes: dates kept
// as the day given, custom fields cast and merged, its own history line and
// event. Finishing or giving up a project settles its pattern's yarn, so
// status goes through the same step here.

import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, type EntityUpdateContext, type EntityUpdateResult } from "@cobblr/platform-contract";
import { fieldDay } from "@cobblr/platform-contract/field-day";
import { splitFieldsForUpdate, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import type { ProjectsDB } from "../db.js";
import { PRIORITIES, PROJECT_STATUSES } from "../vocab.js";
import { settlePattern } from "./pattern-yarn.js";

const Day = z.string().nullable().refine((v) => !v || fieldDay(v) !== null, { message: "Give a day (YYYY-MM-DD)." });

const EditableNative = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(8_000).nullable(),
    status: z.enum(PROJECT_STATUSES),
    priority: z.enum(PRIORITIES).nullable(),
    start_date: Day,
    target_date: Day,
    completion_date: Day,
    color: z.string().nullable(),
  })
  .partial();

export const PROJECT_EDITABLE_KEYS: ReadonlySet<string> = new Set(Object.keys(EditableNative.shape));
const DAYS = ["start_date", "target_date", "completion_date"] as const;

export async function updateProjectFields(ctx: EntityUpdateContext): Promise<EntityUpdateResult> {
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
  const before = await db.selectFrom("projects_projects").selectAll().where("id", "=", ctx.id).executeTakeFirst();
  if (!before) return { ok: false, error: "That project is no longer there." };
  const kind = before.instance === "projects" ? "projects:project" : `${before.instance}:item`;

  let split: Awaited<ReturnType<typeof splitFieldsForUpdate>>;
  try {
    split = await splitFieldsForUpdate(ctx.orgId, kind, ctx.id, ctx.fields, PROJECT_EDITABLE_KEYS);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const parsed = EditableNative.strict().safeParse(split.native);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first?.path.join(".") || "A field"}: ${first?.message ?? "not a valid value"}` };
  }
  if (!Object.keys(parsed.data).length && !Object.keys(split.custom).length) return { ok: false, error: "Nothing to change." };

  const set: Record<string, unknown> = { updated_at: new Date(), ...parsed.data };
  for (const k of DAYS) if (typeof set[k] === "string") set[k] = fieldDay(set[k] as string);
  if (Object.keys(split.custom).length) set.metadata = split.custom;
  await db
    .updateTable("projects_projects")
    .set(withMetadataMerged(set, []) as never)
    .where("id", "=", ctx.id)
    .execute();

  await platform().activity.log({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "project_updated",
    ref: { module: "projects", entityType: "project", entityId: ctx.id },
    diff: Object.keys(split.custom).length ? { ...parsed.data, metadata: split.custom } : parsed.data,
    before,
  });
  platform().events.emit("projects.project.updated", { orgId: ctx.orgId, projectId: ctx.id });
  if (parsed.data.status === "done" || parsed.data.status === "abandoned") {
    await settlePattern(ctx.orgId, ctx.userId ?? "", ctx.id, parsed.data.status);
  }
  return { ok: true, summary: `Saved ${before.name}.`, changed: [...Object.keys(parsed.data), ...Object.keys(split.custom)] };
}
