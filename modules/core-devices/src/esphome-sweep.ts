import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreDevicesDB } from "./db.js";
import { esphomeDriver } from "./esphome.js";
import { applyToLinkedEntity } from "./api/action-handlers.js";

const visited = new Set<string>();
const connected = new Set<string>();
export function registerESPHomeSweep(): void {
  platform().events.on("core-devices.connection.changed", "core-devices", async raw => {
    const payload = raw as { orgId?: string; type?: string };
    if (payload.orgId && payload.type === "esphome") connected.add(payload.orgId);
  });
  platform().sweeps.register({
    name: "core-devices.esphome-readings", module: "core-devices", everyMs: 60_000, firstAfterMs: 5000,
    candidates: async (orgIds, { named }) => named ? orgIds : orgIds.filter(id => !visited.has(id) || connected.has(id)),
    visit: async ({ orgId, db }) => {
      const devices = await (db as Kysely<CoreDevicesDB>).selectFrom("core_devices_connections").select("id").where("type", "=", "esphome").where("enabled", "=", true).execute();
      visited.add(orgId);
      if (!devices.length) { connected.delete(orgId); return; }
      connected.add(orgId);
      for (const device of devices) {
        try {
          const driver = await esphomeDriver(orgId, device.id);
          const entities = await driver?.listDevices?.() ?? [];
          for (const entity of entities.filter(e => /^(sensor|binary_sensor)-/.test(e.id))) {
            try {
              const reading = await driver?.readSensor?.(entity.id);
              if (!reading) continue;
              await applyToLinkedEntity(orgId, { connection: device.id, device: entity.id, ...reading });
            // pass-catch: a sensor that has not sampled yet is read again next round
            } catch { /* A sensor may not have sampled yet; the next round reads it again. */ }
          }
        // pass-catch: a bridge being offline is the device's state, shown on the device, not a failure of the sweep
        } catch { /* A bridge being offline must not stop another device's readings. */ }
      }
    },
  });
}
