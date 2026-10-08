import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { MaintenanceRefusal } from "../refusal.js";
import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { tenantDb, type CoreMaintenanceDB } from "../db.js";
import { asyncHandler, badBody } from "./util.js";

export const remindersRouter = Router({ mergeParams: true });
export const CadenceBody = z.object({ overdue_every: z.enum(["day", "week", "month", "off"]) });
export const NagBody = z.object({
  mode: z.enum(["snooze", "stop", "resume"]),
  until: z.string().datetime().optional(),
  duration: z.enum(["week", "month"]).optional(),
}).refine((d) => d.mode !== "snooze" || !!d.until || !!d.duration, "Choose when reminders resume");

export async function changeNag(db: Kysely<CoreMaintenanceDB>, id: string, d: z.infer<typeof NagBody>) {
  return db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).where("performed_at", "is", null).forUpdate().executeTakeFirst();
    if (!before) throw new MaintenanceRefusal("This service is already done or no longer scheduled");
    const now = new Date();
    let until = d.until ? new Date(d.until) : null;
    if (d.mode === "snooze" && !until) {
      const { addInterval } = await import("../schedule.js");
      until = addInterval(now, 1, d.duration!);
    }
    if (d.mode === "snooze" && (!until || until <= now)) throw new MaintenanceRefusal("Choose a future date");
    const entry = await tx.updateTable("core_maintenance_entries").set({
      nag_stopped_at: d.mode === "stop" ? now : null,
      nag_snoozed_until: d.mode === "snooze" ? until : null,
      updated_at: now,
    }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
    return { entry, was: { nag_stopped_at: before.nag_stopped_at, nag_snoozed_until: before.nag_snoozed_until } };
  });
}

remindersRouter.get("/preferences", asyncHandler(async (req, res) => {
  const row = await tenantDb(req).selectFrom("core_maintenance_preferences").selectAll().executeTakeFirst();
  res.json({ overdue_every: row?.overdue_every ?? "week" });
}));

// AI-REACH: action core-maintenance:reminder-default
remindersRouter.put("/preferences", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:reminder-default"))) return;
  const parsed = CadenceBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  await tenantDb(req).insertInto("core_maintenance_preferences").values({ id: true, ...parsed.data }).onConflict((c) => c.column("id").doUpdateSet(parsed.data)).execute();
  res.json(parsed.data);
}));

// AI-REACH: action core-maintenance:reminders
remindersRouter.patch("/:id", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:reminders"))) return;
  const parsed = NagBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  res.json(await changeNag(tenantDb(req), String(req.params.id), parsed.data));
}));
