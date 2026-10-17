import type { Kysely } from "kysely";
import { z } from "zod";
import type { DigifabDB } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { EdgeAdapterDriver } from "../drivers/edge-adapter.js";
import { authorizeKiln } from "./station.js";
import { KilnRefusal } from "./store.js";
import { TelemetrySchema } from "./model.js";
export const ControlSchema = z.object({ station_token: z.string().min(32).max(128), operation: z.enum(["start", "stop"]) });
export async function controlFiring(db: Kysely<DigifabDB>, orgId: string, id: string, input: z.infer<typeof ControlSchema>) {
 const firing = await db.selectFrom("digifab_firings").selectAll().where("id", "=", id).executeTakeFirst();
 if (!firing?.connection_id || !firing.device_id || firing.ended_at) throw new KilnRefusal("Choose an unfinished firing with a connected kiln.");
 const permit = await authorizeKiln(db, firing.connection_id, firing.device_id, input.station_token);
 const driver = await buildDriverById(db, orgId, firing.connection_id);
 if (!(driver instanceof EdgeAdapterDriver)) throw new KilnRefusal("The kiln must be connected through your shop's bridge.");
 if (input.operation === "start") {
  const device = (await driver.listDevices()).find(d => d.id === firing.device_id);
  const telemetry = TelemetrySchema.parse(device?.raw?.kiln);
  if (telemetry.running || firing.status !== "planned") throw new KilnRefusal("This kiln is already firing or this log has already been started.");
  const claimed = await db.updateTable("digifab_firings").set({ status: "starting", started_at: new Date() }).where("id", "=", id).where("status", "=", "planned").returning("id").executeTakeFirst();
  if (!claimed) throw new KilnRefusal("Another screen is starting this firing.");
 }
 // Start asks again, just before the kiln is told and once it answers, whether
 // this screen still holds the kiln and the firing is still the one it claimed:
 // a revoke or a change in between withdraws the Start (#7171).
 let checks = 0, withdrawnAfterStart = false;
 const checkStartAllowed = async () => {
  checks++;
  try {
   await authorizeKiln(db, firing.connection_id!, firing.device_id!, input.station_token);
   const now = await db.selectFrom("digifab_firings").select(["status", "ended_at"]).where("id", "=", id).executeTakeFirst();
   if (!now || now.ended_at || now.status !== "starting") throw new KilnRefusal("This firing changed while it was starting. Check it before starting it again.");
  } catch (e) { if (checks > 1) withdrawnAfterStart = true; throw e; }
 };
 const result = await driver.kilnAtStation(permit, input.operation, { name: firing.name, schedule: firing.recipe.schedule.map(s => [s.ramp_c_per_hour, s.target_c, s.hold_minutes]) }, input.operation === "start" ? checkStartAllowed : undefined);
 if (!result.ok && input.operation === "start") {
  if (withdrawnAfterStart) await db.updateTable("digifab_firings").set({ status: "stopped", ended_at: new Date() }).where("id", "=", id).where("status", "=", "starting").execute();
  else await db.updateTable("digifab_firings").set({ status: "planned", started_at: null }).where("id", "=", id).where("status", "=", "starting").execute();
 }
 if (!result.ok) throw new KilnRefusal(result.detail ?? "The controller did not accept the command. Check it at the kiln before trying again.");
 if (input.operation === "start") await db.updateTable("digifab_firings").set({ status: "running" }).where("id", "=", id).execute();
 return { ok: true };
}
