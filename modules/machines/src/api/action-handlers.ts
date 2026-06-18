// Machine action handlers. Currently one: machines.record-usage — accrue
// lifetime usage counters on a machine (print_count, print_hours). Generic by
// design (no farm/use-case in the name or logic); the digifab.print.completed →
// machines:record-usage wire is what turns it into "maintenance by usage", but
// any source can fire it.

import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

export function registerMachinesActionHandlers(): void {
  platform().actions.registerHandler("machines.record-usage", async (ctx) => {
    // Args (a hardwired wire value) take precedence; else the event payload.
    const args = (ctx.args ?? {}) as { machineId?: string; prints?: number; hours?: number };
    const ev = (ctx.event?.payload ?? {}) as {
      machineId?: string;
      linkedMachineId?: string;
      prints?: number;
      hours?: number;
    };
    const machineId = args.machineId ?? ev.machineId ?? ev.linkedMachineId;
    const prints = Number(args.prints ?? ev.prints ?? 1) || 0;
    const hours = Number(args.hours ?? ev.hours ?? 0) || 0;
    if (!machineId || (prints === 0 && hours === 0)) {
      return { ok: true, skipped: true, reason: "no machineId or nothing to add" };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<MachinesDB>;
    const updated = await db
      .updateTable("machines_machines")
      .set({
        // Increment two numeric keys inside the metadata jsonb in one shot.
        metadata: sql`jsonb_set(
          jsonb_set(coalesce(metadata, '{}'::jsonb), '{print_count}',
            to_jsonb(coalesce((metadata->>'print_count')::numeric, 0) + ${prints})),
          '{print_hours}',
            to_jsonb(coalesce((metadata->>'print_hours')::numeric, 0) + ${hours}))` as never,
        updated_at: new Date(),
      })
      .where("id", "=", machineId)
      .returning(["id"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "machine_not_found" };
    return { ok: true, machineId, prints, hours };
  });
}
