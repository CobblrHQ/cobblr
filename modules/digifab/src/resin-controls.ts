import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { pollJob, buildDriverById } from "./jobs-core.js";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import type { MachineDriver, CommandResult } from "./drivers/types.js";
import { mayControl, RUN_MACHINES_REFUSAL } from "./motion-gate.js";
export async function controlResinPrinter(db: Kysely<DigifabDB>, orgId: string, driver: MachineDriver, deviceId: string, operation: string, connectionId: string): Promise<CommandResult> {
  if (driver.printProcess !== "resin" || !driver.runControl || !["stop", "pause", "resume"].includes(operation)) return { ok: false, detail: "Choose Stop, Pause or Resume on a connected resin printer." };
  const stopping = operation === "stop" ? await db.updateTable("digifab_jobs")
    .set({ cancel_requested_at: new Date(), updated_at: new Date() })
    .where("connection_id", "=", connectionId).where("target_device", "=", deviceId)
    .where(eb => eb.or([eb("status", "in", ["queued", "sent", "printing", "paused", "assigning"]), eb("send_token", "is not", null)]))
    .returning(["id", "remote_job_id"]).execute() : [];
  const result = await driver.runControl(deviceId, operation, {});
  if (result.ok) {
    const jobs = operation === "stop" ? stopping : await db.selectFrom("digifab_jobs")
      .select(["id", "remote_job_id"]).where("connection_id", "=", connectionId).where("target_device", "=", deviceId)
      .where("status", "in", ["sent", "printing", "paused"]).execute();
    for (const job of jobs) if (job.remote_job_id) await pollJob(db, orgId, job.id);
  }
  return result;
}

export const ResinControl = z.object({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200), operation: z.enum(["stop", "pause", "resume"]) });
export function registerResinControlAction(): void {
  platform().actions.registerHandler("digifab.resin-control", async ctx => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) return { ok: false, error: "Sign in to this workspace to control its resin printers." };
    const parsed = ResinControl.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    if (!await mayControl({ orgId: ctx.orgId, userId: ctx.userId, operation: parsed.data.operation })) return { ok: false, error: RUN_MACHINES_REFUSAL };
    const b = parsed.data, db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
    const driver = await buildDriverById(db, ctx.orgId, b.connection_id);
    if (!driver) return { ok: false, error: "The resin printer is not connected." };
    const result = await controlResinPrinter(db, ctx.orgId, driver, b.device_id, b.operation, b.connection_id);
    return result.ok ? { ok: true } : { ok: false, error: result.detail ?? "The printer did not accept the control." };
  });
}
