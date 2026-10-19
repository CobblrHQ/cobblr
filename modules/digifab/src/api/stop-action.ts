// Stop is its own action, and it does not wait for a yes (#5091).
//
// It only ever brings a machine toward stopped: cancel or pause a job, or stop
// or pause a machine. It never starts, resumes, frames or homes anything, so it
// declares `effect: "stops"`, which every AI door runs without a confirm: an
// emergency stop that waits for a Confirm press comes late. Starting and
// resuming stay physical and confirm-gated in their own actions.
//
// The calls are the page's own: a job's Cancel and Pause (api/jobs.ts), and a
// machine's Stop and Pause through its control (laser, resin, cutter), so the
// assistant's stop is the same stop a person presses.
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { familyStopping } from "../core/families.js";
import { cancelJob, controlJobById } from "./jobs.js";
import { stopLargePrint } from "../large-format/service.js";

/** The only two things this action can ask for. */
export const STOP_COMMANDS = ["stop", "pause"] as const;

export const StopArgs = z
  .object({
    command: z.enum(STOP_COMMANDS).default("stop"),
    job_id: z.string().uuid().optional(),
    connection_id: z.string().uuid().optional(),
    device_id: z.string().min(1).max(200).optional(),
  })
  .refine((a) => !!a.job_id || (!!a.connection_id && !!a.device_id), { message: "Say which job (job_id), or which machine (connection_id and device_id)." });

type Outcome = { ok: true; summary: string } | { ok: false; error: string };

/** Stop or pause a machine that has no job id to name (a laser mid-cut, a
 *  cutter streaming), through its own control. */
async function stopMachine(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string, command: (typeof STOP_COMMANDS)[number]): Promise<Outcome> {
  const driver = await buildDriverById(db, orgId, connectionId);
  if (!driver) return { ok: false, error: "That machine is not connected." };
  const done = command === "stop" ? "Stopped" : "Paused";
  const own = await familyStopping(driver);
  if (own?.stopsWithoutJob) {
    const r = await own.run(db, orgId, driver, deviceId, command, {}, connectionId);
    return r.ok ? { ok: true, summary: `${done} the ${own.noun}.` } : { ok: false, error: r.detail ?? `The ${own.noun} did not confirm.` };
  }
  if (driver.printProcess === "large-format") {
    if (command !== "stop") return { ok: false, error: "Use Stop for this large-format printer." };
    try {
      await stopLargePrint(db, orgId, { connection_id: connectionId, device_id: deviceId });
      return { ok: true, summary: "Stop sent; check the printer's status." };
    } catch (err) {
      return { ok: false, error: (err as Error).message || "Use Stop on the printer. Its bridge is unavailable." };
    }
  }
  return { ok: false, error: "Name the job to stop on this machine (job_id): it is stopped through its print." };
}

export async function stopAction(db: Kysely<DigifabDB>, orgId: string, args: unknown): Promise<Outcome> {
  const parsed = StopArgs.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Say what to stop." };
  const a = parsed.data;
  if (a.job_id) {
    const out = a.command === "stop" ? await cancelJob(db, orgId, a.job_id) : await controlJobById(db, orgId, a.job_id, "pause");
    if (out.status >= 400) {
      const e = (out.body.error as { message?: string } | undefined)?.message;
      return { ok: false, error: e ?? "The machine did not confirm." };
    }
    const waiting = out.status === 202;
    return { ok: true, summary: a.command === "pause" ? "Paused the print." : waiting ? "Stop sent; the machine confirms when it has stopped." : "Stopped the print." };
  }
  return stopMachine(db, orgId, a.connection_id!, a.device_id!, a.command);
}

export function registerStopAction(): void {
  platform().actions.registerHandler("digifab.stop", async (ctx) => {
    // Anyone in the workspace may stop a machine, as on the page.
    if (!ctx.userId || !(await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" }))) {
      return { ok: false, error: "Sign in to this workspace to stop its machines." };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const out = await stopAction(db, ctx.orgId, ctx.args);
    return out.ok ? { ok: true, summary: out.summary } : { ok: false, error: out.error };
  });
}
