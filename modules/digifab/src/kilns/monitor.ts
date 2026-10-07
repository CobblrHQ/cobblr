import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { TelemetrySchema } from "./model.js";
export function registerKilnMonitor() {
 platform().sweeps.register({ name: "digifab.kiln-monitor", module: "digifab", everyMs: 15000, firstAfterMs: 10000,
  visit: async ({ orgId, db }) => {
   const tenant = db as Kysely<DigifabDB>;
   const active = await tenant.selectFrom("digifab_firings").select(["id", "connection_id", "device_id"]).where("status", "in", ["starting", "running"]).where("ended_at", "is", null).execute();
   await Promise.all(active.map(async firing => {
    if (!firing.connection_id || !firing.device_id) return;
    try {
     const driver = await buildDriverById(tenant, orgId, firing.connection_id);
     const device = (await driver?.listDevices())?.find(d => d.id === firing.device_id);
     const telemetry = TelemetrySchema.parse(device?.raw?.kiln);
     await tenant.updateTable("digifab_firings").set({ peak_c: sql`greatest(coalesce(peak_c, ${telemetry.temperature_c}), ${telemetry.temperature_c})`, duration_hours: sql`nullif(greatest(coalesce(duration_hours, 0), ${telemetry.elapsed_sec / 3600}), 0)` }).where("id", "=", firing.id).where("ended_at", "is", null).execute();
    } catch (err) { platform().health.notePassFailure("digifab.kiln-monitor", `${orgId}:${firing.id}`, err); }
   }));
  },
 });
}
