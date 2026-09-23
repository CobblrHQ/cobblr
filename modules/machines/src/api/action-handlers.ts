// Machine action handlers. Currently one: machines.record-usage — accrue
// lifetime usage counters on a machine (print_count, print_hours). Generic by
// design (no farm/use-case in the name or logic); the digifab.print.completed →
// machines:record-usage wire is what turns it into "maintenance by usage", but
// any source can fire it.

import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

export function registerMachinesActionHandlers(): void {
  registerUndos();
  platform().actions.registerHandler("machines.record-usage", async (ctx) => {
    // Args (a hardwired wire value) take precedence; else the event payload.
    const args = (ctx.args ?? {}) as { machineId?: string; prints?: number; hours?: number };
    const ev = (ctx.event?.payload ?? {}) as {
      machineId?: string;
      linkedMachineId?: string;
      prints?: number;
      hours?: number;
    };
    // The action is declared on machines ("that machine ran four hours"), so
    // the record it is run on IS the machine. Read from args alone, the
    // assistant's invoke on the Rostock with {hours: 4} was refused as "no
    // machineId" on every bench run for a week (the 2026-09-22 nightly's
    // transcripts, #3142).
    const onMachine = ctx.entity?.kind === "machines:machine" ? ctx.entity.id : undefined;
    const machineId = args.machineId ?? onMachine ?? ev.machineId ?? ev.linkedMachineId;
    // A print is counted when there is evidence of one. A wire fires this on
    // an event, and the event IS the print: one per firing when the payload
    // does not count them, which is what every existing wire has meant since
    // it was made, so nothing a person built changes. A person or the
    // assistant pressing it with no count has no such evidence, and a call
    // that said nothing used to record one print and report it (#3141).
    const evidenced = ctx.event?.trigger_type && ctx.event.trigger_type !== "user-invoked" ? 1 : 0;
    const prints = Number(args.prints ?? ev.prints ?? evidenced) || 0;
    const hours = Number(args.hours ?? ev.hours ?? 0) || 0;
    // A wire whose event names no machine skips, as it always has; a person
    // or the assistant is told what was missing, in words they can act on.
    const pressed = !ctx.event?.trigger_type || ctx.event.trigger_type === "user-invoked";
    if (!machineId) {
      return pressed ? { ok: false, error: "which machine? run this on the machine, or pass its id as machineId" } : { ok: true, skipped: true, reason: "no machineId" };
    }
    if (prints === 0 && hours === 0) {
      return pressed ? { ok: false, error: "nothing to add: say the hours or the prints" } : { ok: true, skipped: true, reason: "nothing to add" };
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
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "that machine is not here any more" };
    // The card's line after Do it: it read a bare "Done." (#3255).
    const what = [hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "", prints ? `${prints} print${prints === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    return { ok: true, machineId, prints, hours, summary: `${what} recorded on "${updated.name}"` };
  });
}

function registerUndos(): void {
  platform().actions.registerUndo("machines.record-usage", (result, ctx) => {
    const r = result as { ok?: unknown; skipped?: unknown; machineId?: unknown; prints?: unknown; hours?: unknown } | null;
    if (r?.ok !== true || r.skipped || typeof r.machineId !== "string") return null;
    const prints = typeof r.prints === "number" ? -r.prints : 0;
    const hours = typeof r.hours === "number" ? -r.hours : 0;
    if (!prints && !hours) return null;
    const on = ctx.entity ? { entity_kind: ctx.entity.kind, entity_id: ctx.entity.id } : { entity_kind: "machines:machine", entity_id: r.machineId };
    return { action_id: "machines:record-usage", args: { machineId: r.machineId, prints, hours }, ...on };
  });
}
