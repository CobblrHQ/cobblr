// digifab registers the platform device-driver PROVIDER — it owns the driver
// REGISTRY (the fab + generic driver factories), so it builds the driver a
// consumer asks for via platform().devices.getDriver(). The connection DATA now
// lives in core-devices (via the connection store); buildDriverById fetches it
// from there and resolves the driver against digifab's registry. The ACTUATOR
// action (digifab:run-command) moved to core-devices; the deprecated alias below
// delegates to it. See docs/architecture/core-devices-extraction.md §2/§6.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { buildDriverById } from "../jobs-core.js";
import type { DigifabDB } from "../db.js";

let registered = false;

export function registerDeviceSeam(): void {
  if (registered) return;
  registered = true;

  // MachineDriver is a structural superset of DeviceDriver (it adds the
  // fabrication methods), so it satisfies the seam's contract. buildDriverById
  // takes a ref (id OR label) and pulls the connection from the core-devices store.
  platform().devices.registerDriverProvider(async (orgId, ref) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    return buildDriverById(db, orgId, ref);
  });

  // The deprecated digifab:run-command alias — delegate to the canonical
  // core-devices:run-command so wires in already-installed bundles keep working.
  platform().actions.registerHandler("digifab.run-command", async (ctx) => {
    return platform().actions.invoke("core-devices:run-command", ctx);
  });
}
