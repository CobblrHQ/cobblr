import type { Kysely, Updateable } from "kysely";
import type { DigifabDB } from "./db.js";
import type { MachineDriver } from "./drivers/types.js";
export async function persistResinStart(db: Kysely<DigifabDB>, driver: MachineDriver, deviceId: string, jobId: string, token: string, fields: Updateable<DigifabDB["digifab_jobs"]>): Promise<boolean> {
  const updated = await db.updateTable("digifab_jobs").set(fields).where("id", "=", jobId).where("send_token", "=", token).where("cancel_requested_at", "is", null).where("status", "not in", ["completed", "failed", "cancelled"]).returning("id").executeTakeFirst();
  if (updated) return true;
  await db.updateTable("digifab_jobs").set({ remote_file_id: fields.remote_file_id, remote_job_id: fields.remote_job_id,
    target_device: fields.target_device, sent_at: fields.sent_at, send_token: null, send_claimed_at: null,
    error: "Stop was requested. Waiting for the printer to confirm it stopped.", updated_at: new Date() })
    .where("id", "=", jobId).where("send_token", "=", token).execute();
  try { await driver.runControl?.(deviceId, "stop", {}); }
  catch { /* The saved Stop intent and polling keep an unconfirmed stop visible. */ }
  return false;
}
