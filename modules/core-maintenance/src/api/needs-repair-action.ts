// Needs repair (core-maintenance:needs-repair, #6889): a thing found broken
// gets one entry, due now, so it sits in the due list and the record's service
// log until somebody logs the repair. A scan marked broken reaches it (core-scan
// names the record; this module owns the write), and so can the assistant on a
// record. What reported it is kept on the entry. Its undo removes the entry.
// Wired in ./handlers.ts.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreMaintenanceDB } from "../db.js";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function registerNeedsRepairAction(): void {
  platform().actions.registerHandler("core-maintenance.needs-repair", async (ctx) => {
    const e = ctx.entity;
    if (!e) return { ok: false, error: "Say which thing is broken." };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const [entityModule, entityType] = e.kind.includes(":") ? [e.kind.split(":")[0]!, e.kind.split(":")[1]!] : [e.kind, e.kind];
    const sourceKind = str(args.source_kind);
    const sourceId = str(args.source_id);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const row = await db
      .insertInto("core_maintenance_entries")
      .values({
        entity_module: entityModule,
        entity_type: entityType,
        entity_id: e.id,
        name: "Needs repair",
        notes: str(args.notes),
        scheduled_at: new Date(),
        metadata: sourceKind && sourceId ? { reported_by: { kind: sourceKind, id: sourceId } } : {},
      })
      .returning(["id", "name", "scheduled_at"])
      .executeTakeFirstOrThrow();
    return { ok: true, result: { id: row.id, name: row.name, scheduled_at: row.scheduled_at }, summary: "Marked as needing repair." };
  });
  platform().actions.registerUndo("core-maintenance.needs-repair", (result) => {
    const r = result as { ok?: unknown; result?: { id?: unknown } } | null;
    return r?.ok === true && typeof r.result?.id === "string" ? { action_id: "core-maintenance:remove-entry", args: { entry_id: r.result.id } } : null;
  });
}
