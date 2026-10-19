// What every connected machine runs, read once an hour from each connection's
// driver (readVersions) and kept per device. A device linked to a machine
// record hands its reading on (digifab.device.versions_reported); machines
// stores it on the record, with its source and when it was seen.
//
// Never on the fleet poll: a version changes when someone updates the
// machine, and asking every ten seconds would be a request per printer for an
// answer that is the same all day. A reading that stops arriving goes stale on
// the machine (machines/src/versions.ts), so a silent printer is never counted
// as up to date.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import type { DeviceVersions } from "./drivers/types.js";
import { availableDriverKeys } from "./drivers/registry.js";
import { buildDriverById } from "./jobs-core.js";

export const VERSION_READ_PASS = "digifab.version-read";
const EVERY_MS = 60 * 60 * 1000;
const READ_TIMEOUT_MS = 20_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("the machine did not say what it runs in time")), ms); })]);
}

type Stored = { firmware: string | null; software: string | null; controller: string | null; model: string | null; seen_at: Date };

/** Hand one device's reading to the machine it is linked to. */
async function report(orgId: string, machineId: string, connectionId: string, deviceId: string, r: Stored): Promise<void> {
  await platform().events.emit("digifab.device.versions_reported", {
    orgId,
    linkedMachineId: machineId,
    connectionId,
    deviceId,
    firmware: r.firmware,
    software: r.software,
    controller: r.controller,
    model: r.model,
    seen_at: new Date(r.seen_at).toISOString(),
  });
}

/** One workspace: ask each connection what its devices run, keep it, and
 *  report it for every device linked to a machine. */
export async function readVersionsFor(orgId: string, db: Kysely<DigifabDB>, now = new Date()): Promise<{ read: number; reported: number }> {
  const driveable = new Set(await availableDriverKeys(db));
  const conns = (await platform().devices.connections().list(orgId)).filter((c) => c.enabled && driveable.has(c.type));
  let read = 0;
  let reported = 0;
  if (!conns.length) return { read, reported };
  const links = await db.selectFrom("digifab_device_links").select(["connection_id", "remote_device_id", "machine_id"])
    .where("connection_id", "in", conns.map((c) => c.id)).execute();
  for (const conn of conns) {
    let readings: Array<DeviceVersions & { deviceId: string }>;
    try {
      const driver = await buildDriverById(db, orgId, conn.id);
      if (!driver?.readVersions) continue;
      readings = await within(driver.readVersions(), READ_TIMEOUT_MS);
    } catch (err) {
      // Unreachable is not "no version": the last reading stays, and goes stale on its own.
      platform().health.notePassFailure(VERSION_READ_PASS, `${orgId}:${conn.id}`, err);
      continue;
    }
    for (const r of readings) {
      const row: Stored = { firmware: r.firmware ?? null, software: r.software ?? null, controller: r.controller ?? null, model: r.model ?? null, seen_at: now };
      await db.insertInto("digifab_device_versions")
        .values({ connection_id: conn.id, remote_device_id: r.deviceId, ...row })
        .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet(row))
        .execute();
      read++;
      for (const link of links) {
        if (link.connection_id !== conn.id || link.remote_device_id !== r.deviceId) continue;
        await report(orgId, link.machine_id, conn.id, r.deviceId, row);
        reported++;
      }
    }
  }
  return { read, reported };
}

/** A device just linked to a machine: the machine gets the device's last
 *  reading now, not at the next hour. Nothing to hand on when it never said. */
export async function reportLinkedVersions(db: Kysely<DigifabDB>, orgId: string, link: { connection_id: string; remote_device_id: string; machine_id: string }): Promise<void> {
  const r = await db.selectFrom("digifab_device_versions").selectAll()
    .where("connection_id", "=", link.connection_id).where("remote_device_id", "=", link.remote_device_id).executeTakeFirst();
  if (r) await report(orgId, link.machine_id, link.connection_id, link.remote_device_id, r);
}

export function registerVersionRead(): void {
  platform().sweeps.register({
    name: VERSION_READ_PASS,
    module: "digifab",
    everyMs: EVERY_MS,
    visit: ({ orgId, db, now }) => readVersionsFor(orgId, db as Kysely<DigifabDB>, now),
  });
}
