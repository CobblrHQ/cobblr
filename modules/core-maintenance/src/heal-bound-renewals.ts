// DONE WHEN: this boot has seeded every configured collection at its current binding revision.
// PERMANENT RECONCILE: a configured collection seeds its existing renewals once
// per binding. Settled collections need only their config read.
// BORN WITH: core-maintenance:ensure-renewal runs on create and update wires.
// SINCE BY MARKER: it runs once per binding revision (renewal_fields_seeded),
// and seeding a record made since is the same idempotent ensure its create
// wire already ran, so it changes nothing there.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { RenewalBindingSchema } from "@cobblr/platform-contract/record-creation";
import type { Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import { ensureBoundRenewal } from "./bound-renewal.js";

export async function healBoundRenewals(orgId: string, db: Kysely<CoreMaintenanceDB>): Promise<number> {
  let seeded = 0;
  for (const instance of await platform().instances.list(orgId)) {
    const config = await platform().instances.configOf(orgId, instance.instance_name);
    const parsed = RenewalBindingSchema.safeParse(config?.renewal_fields);
    if (!parsed.success) continue;
    const marker = JSON.stringify(parsed.data);
    if (config?.renewal_fields_seeded === marker) continue;
    const kind = `${instance.instance_name}:item`;
    for (let offset = 0; ; offset += 200) {
      const page = await platform().entities.list(orgId, kind, { limit: 200, offset, sort: ["id"] });
      for (const row of page.items) { await ensureBoundRenewal(db, orgId, kind, row.id, parsed.data); seeded++; }
      if (page.items.length < 200) break;
    }
    await platform().instances.patchDerivedConfig(orgId, instance.module_name, instance.instance_name, { renewal_fields_seeded: marker });
  }
  return seeded;
}
export function registerBoundRenewalsHeal(): void {
  registerHealPass({ name: "core-maintenance.bound-renewals", since: "2026-10-08T18:06:14Z", shim: "modules/core-maintenance/src/heal-bound-renewals.ts", module: "core-maintenance", visit: ({ orgId, db }) => healBoundRenewals(orgId, db as Kysely<CoreMaintenanceDB>) });
}
