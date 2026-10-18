// A scan marked broken (#6889): you scan the drill you already have and say
// it is broken. The drill gets a repair entry in its service log, not a
// second drill, and the scan is done. The entry is core-maintenance's to
// write (its needs-repair action); this module only says which record, and
// only when the scan matched one thing exactly (scanBrokenTarget, the one
// rule the card, the camera sheet, the route and the assistant share).
//
// Undo is the scan's own Undo (POST /inbox/:id/unconfirm, unmarkBroken
// here): the entry comes off through the action's own undo, and the scan is
// back in the inbox.

import type { Kysely } from "kysely";
import { isActionStep, platform, type ActionUndoStep } from "@cobblr/platform-contract";
import { scanBrokenTarget, type ScanBrokenTarget, type ScanTriageRow } from "@cobblr/platform-contract/scan-triage";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { appendScanHistory } from "./scan-history.js";

export const NEEDS_REPAIR = "core-maintenance:needs-repair";
export const BROKEN_MODE = "broken";

export type MarkBrokenResult =
  | { ok: true; item: Record<string, unknown>; entry_id: string; record: ScanBrokenTarget }
  | { ok: false; status: 404 | 409; code: string; message: string };

const actor = (userId: string | null, name: string) => ({
  name,
  payload: {},
  actor: { user_id: userId, display_name: null, auth_method: "session" as const },
  timestamp: new Date().toISOString(),
  trigger_type: "user-invoked" as const,
});

export async function markBroken(db: Kysely<CoreScanDB>, orgId: string, userId: string | null, id: string, note: string | null): Promise<MarkBrokenResult> {
  const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return { ok: false, status: 404, code: "not_found", message: "inbox item not found" };
  const target = scanBrokenTarget(row as unknown as ScanTriageRow);
  if (!target) {
    return {
      ok: false,
      status: 409,
      code: row.status === "pending" ? "no_matched_record" : "already_resolved",
      message: row.status === "pending"
        ? "This scan did not match one thing you have by its code, so there is nothing to mark broken. Open the thing and log the repair there."
        : "This scan was already filed.",
    };
  }
  // Claimed first, so two taps (or the card and the assistant at once) open
  // one entry, never two.
  const claimed = await db
    .updateTable("core_scan_inbox_items")
    .set({ status: "resolved", updated_at: new Date() })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returning(["id"])
    .executeTakeFirst();
  if (!claimed) return { ok: false, status: 409, code: "already_resolved", message: "This scan was already filed." };

  const entity = { kind: target.kind, id: target.id };
  const result = (await platform()
    .actions.invoke(NEEDS_REPAIR, {
      orgId,
      userId,
      entity,
      event: actor(userId, "core-scan.scan.broken"),
      args: { ...(note ? { notes: note } : {}), source_kind: "core-scan:inbox-item", source_id: id },
    })
    .catch((err: unknown) => ({ ok: false, error: (err as Error)?.message ?? String(err) }))) as { ok?: boolean; code?: string; error?: string; result?: { id?: string } } | null;
  const entryId = result?.ok ? result.result?.id : undefined;
  if (!entryId) {
    await db.updateTable("core_scan_inbox_items").set({ status: "pending", updated_at: new Date() }).where("id", "=", id).execute();
    return {
      ok: false,
      status: 409,
      code: result?.code === "module_not_enabled" ? "maintenance_off" : "repair_refused",
      message: result?.error ?? "The repair entry could not be opened.",
    };
  }
  const undo = await platform().actions.undoFor(NEEDS_REPAIR, result, { orgId, entity }).catch(() => null);
  const item = await db
    .updateTable("core_scan_inbox_items")
    .set({
      target_module: target.kind.split(":")[0] ?? null,
      target_kind: target.kind,
      target_entity_id: target.id,
      suggested_metadata: mergeMeta({
        attached_to: { kind: target.kind, id: target.id, ...(target.instance ? { instance: target.instance } : {}), mode: BROKEN_MODE, entry_id: entryId, ...(note ? { note } : {}), undo: undo ?? [] },
      }) as never,
      resolved_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendScanHistory(db, id, { action: "broken", note: `marked broken; a repair entry is open on ${target.title}` });
  void platform().events.emit("core-scan.scan.broken", { orgId, itemId: id, record: entity, entryId, note });
  return { ok: true, item: item as unknown as Record<string, unknown>, entry_id: entryId, record: target };
}

/** Take a broken mark back: the repair entry comes off through its own
 *  action's undo. The caller reopens the row. A note when the entry could
 *  not be taken off, null when it was (or was already gone). */
export async function unmarkBroken(orgId: string, userId: string | null, attached: { kind?: string; id?: string; undo?: unknown }): Promise<string | null> {
  const steps = Array.isArray(attached.undo) ? (attached.undo as ActionUndoStep[]) : [];
  for (const step of steps) {
    if (!isActionStep(step)) continue;
    const r = (await platform()
      .actions.invoke(step.action_id, {
        orgId,
        userId,
        ...(attached.kind && attached.id ? { entity: { kind: step.entity_kind ?? attached.kind, id: step.entity_id ?? attached.id } } : {}),
        event: actor(userId, "core-scan.inbox.unconfirm"),
        args: step.args,
      })
      .catch((err: unknown) => ({ ok: false, error: (err as Error)?.message ?? String(err) }))) as { ok?: boolean; error?: string } | null;
    if (r?.ok !== true) return `The repair entry stayed on the record (${r?.error ?? "it could not be removed"}). Remove it from the record's service log.`;
  }
  return steps.length ? null : "The repair entry stayed on the record. Remove it from the record's service log.";
}

/** Whether a row was settled by a broken mark. */
export function brokenMarkOf(meta: unknown): { kind?: string; id?: string; entry_id?: string; undo?: unknown } | null {
  const a = ((meta ?? {}) as { attached_to?: { mode?: unknown } }).attached_to;
  return a && a.mode === BROKEN_MODE ? (a as { kind?: string; id?: string; entry_id?: string; undo?: unknown }) : null;
}

