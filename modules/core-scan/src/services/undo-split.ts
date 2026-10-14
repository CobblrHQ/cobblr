// Undo a split (#2945), for every door: the inbox's Undo split, an order
// line said to be "all the same" again (#5734), and that action's undo. The
// split line comes back to the inbox as it was, its parts are discarded, and
// its purchase gets its one line back. Refused while a part is filed or was
// combined into another scan: that part's count lives elsewhere now.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { SCAN_UNDO_ACTIONS } from "@cobblr/platform-contract/scan-recovery";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { relineAfterChange, type PurchaseHttp } from "./receipt-purchase.js";

export type UndoSplitResult =
  | { ok: true; parent: Awaited<ReturnType<typeof parentRow>>; live: string[] }
  | { ok: false; status: number; error: { code: string; message: string; item_id?: string } };

/** The keys a split writes on its line, and Undo split takes off. */
const SPLIT_KEYS = ["split_into", "split_prior_notes", "order_line_split", "pack_split", "line_units", "split_how"] as const;

async function parentRow(db: Kysely<CoreScanDB>, id: string) {
  return db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

/** Undo the split `id` belongs to: it may be the split line or one of its
 *  parts. */
export async function undoSplit(db: Kysely<CoreScanDB>, orgId: string, id: string, http: PurchaseHttp | null): Promise<UndoSplitResult> {
    const start = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "suggested_metadata"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!start) {
      return { ok: false as const, status: 404, error: { code: "not_found", message: "inbox item not found" } };
    }
    const startMeta = (start.suggested_metadata ?? {}) as { split_from?: string; split_into?: string[] };
    const parentId = typeof startMeta.split_from === "string" && startMeta.split_from ? startMeta.split_from : start.id;
    const parent = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", parentId)
      .executeTakeFirst();
    const parentMeta = (parent?.suggested_metadata ?? {}) as { split_into?: unknown; split_prior_notes?: unknown };
    if (!parent || !Array.isArray(parentMeta.split_into)) {
      return { ok: false as const, status: 409, error: { code: "not_split", message: "This scan was not split, so there is no split to undo." } };
    }
    const children = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "status", "suggested_name", "suggested_metadata"])
      .where(sql`suggested_metadata->>'split_from'`, "=", parent.id)
      .execute();
    const filed = children.find((c) => c.status === "resolved");
    if (filed) {
      return { ok: false as const, status: 409, error: {
          code: "child_filed",
          message: `"${filed.suggested_name ?? "One of the split items"}" was already filed from this split. Press ${SCAN_UNDO_ACTIONS.sendBack} on it in Recently committed first, then ${SCAN_UNDO_ACTIONS.undoSplit}.`,
          item_id: filed.id,
        } };
    }
    const combined = children.find(
      (c) => c.status === "discarded" && !!((c.suggested_metadata as { combined_into?: string } | null) ?? {}).combined_into,
    );
    if (combined) {
      return { ok: false as const, status: 409, error: {
          code: "child_combined",
          message: `"${combined.suggested_name ?? "One of the split items"}" was combined into another scan, and its quantity lives there now. Press ${SCAN_UNDO_ACTIONS.undoCombine} on it first if you want the group photo back.`,
          item_id: combined.id,
        } };
    }
    const now = new Date();
    const live = children.filter((c) => c.status !== "discarded").map((c) => c.id);
    // What the split was, kept on its parts so Split again can put it back
    // exactly (redoSplit): an Undo split is one tap, and one that landed by
    // accident cost the owner a split pack of ten (#6527). On the parts,
    // never the line: the line comes back exactly as it was.
    const was = Object.fromEntries(SPLIT_KEYS.filter((k) => k in (parent.suggested_metadata as Record<string, unknown>)).map((k) => [k, (parent.suggested_metadata as Record<string, unknown>)[k]]));
    if (live.length) {
      await db
        .updateTable("core_scan_inbox_items")
        // The marker keeps Recently deleted from restoring a child on its
        // own: the group it came from is back, and the two would double.
        .set({ status: "discarded", suggested_metadata: mergeMeta({ split_undone_at: now.toISOString(), split_undone: { parts: live, notes: parent.ai_notes ?? null, was } }) as never, updated_at: now })
        .where("id", "in", live)
        .execute();
    }
    const priorNotes = typeof parentMeta.split_prior_notes === "string" ? parentMeta.split_prior_notes : null;
    const restored = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "pending",
        // created_at stays: an undo puts the scan back where it was, the
        // same contract as restore and un-confirm.
        resolved_at: null,
        ai_notes: priorNotes,
        suggested_metadata: mergeMeta({}, [...SPLIT_KEYS]) as never,
        updated_at: now,
      })
      .where("id", "=", parent.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Its parts' order lines become its one line again (#5734).
    if (http && live.length) {
      await relineAfterChange(db, http, live, [parent.id]).catch((e: Error) =>
        console.warn("[core-scan] undo split: order lines kept as they were:", e.message),
      );
    }
    for (const childId of live) {
      void platform().events.emit("core-scan.scan.discarded", { orgId, itemId: childId });
    }
    return { ok: true as const, parent: restored, live };
}

export type RedoSplitResult =
  | { ok: true; parent: Awaited<ReturnType<typeof parentRow>>; parts: string[] }
  | { ok: false; status: number; error: { code: string; message: string } };

/** Split again: put back the parts an Undo split took out of the inbox, and
 *  the line as it was split. The same parts, not a new split, so a part
 *  someone renamed or recoloured before the undo comes back as it was. A row
 *  undone before the split was kept on it finds its parts by split_from.
 *  Refused once the line has been filed, split again, or one of its parts
 *  has come back on its own. */
export async function redoSplit(db: Kysely<CoreScanDB>, id: string, http: PurchaseHttp | null): Promise<RedoSplitResult> {
  const parent = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
  if (!parent) return { ok: false, status: 404, error: { code: "not_found", message: "inbox item not found" } };
  const meta = (parent.suggested_metadata ?? {}) as { split_into?: unknown };
  if (parent.status !== "pending" || Array.isArray(meta.split_into)) {
    return { ok: false, status: 409, error: { code: "not_undone", message: "This line is not waiting as one, so there is no undone split to put back." } };
  }
  const discarded = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_metadata", "created_at"])
    .where(sql`suggested_metadata->>'split_from'`, "=", parent.id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  // The undo's own record of the split, on its parts.
  const stamp = discarded.map((c) => ((c.suggested_metadata ?? {}) as { split_undone?: { parts?: unknown; notes?: unknown; was?: unknown } | null }).split_undone).find((x) => x && typeof x === "object") ?? null;
  const undone = { split_undone: stamp };
  const kept = Array.isArray(undone.split_undone?.parts) ? (undone.split_undone!.parts as unknown[]).filter((p): p is string => typeof p === "string") : null;
  const parts = kept
    ? kept.map((p) => discarded.find((c) => c.id === p)).filter((c): c is (typeof discarded)[number] => !!c)
    : discarded.filter((c) => !!((c.suggested_metadata ?? {}) as { split_undone_at?: unknown }).split_undone_at);
  if (parts.length === 0 || (kept && parts.length !== kept.length)) {
    return { ok: false, status: 409, error: { code: "no_parts", message: "The parts this line was split into are no longer there to put back." } };
  }
  const back = parts.find((c) => c.status !== "discarded" || !((c.suggested_metadata ?? {}) as { split_undone_at?: unknown }).split_undone_at);
  if (back) {
    return { ok: false, status: 409, error: { code: "part_back", message: "One of its parts is back in the inbox on its own, so the split cannot be put back as it was." } };
  }
  const now = new Date();
  // In the split's own order (the parts' order, a photo's left to right),
  // which the undo kept; a row undone before that keeps creation order.
  const was0 = (undone.split_undone?.was && typeof undone.split_undone.was === "object" ? undone.split_undone.was : {}) as { split_into?: unknown };
  const order = Array.isArray(was0.split_into) ? (was0.split_into as unknown[]) : [];
  const at = (id: string) => (order.indexOf(id) < 0 ? order.length : order.indexOf(id));
  const ids = parts.map((c) => c.id).sort((a, b) => at(a) - at(b));
  await db
    .updateTable("core_scan_inbox_items")
    .set({ status: "pending", suggested_metadata: mergeMeta({}, ["split_undone_at", "split_undone"]) as never, updated_at: now })
    .where("id", "in", ids)
    .execute();
  const was = (undone.split_undone?.was && typeof undone.split_undone.was === "object" ? undone.split_undone.was : {}) as Record<string, unknown>;
  const notes = typeof undone.split_undone?.notes === "string" ? undone.split_undone.notes : `Split into ${ids.length} item${ids.length === 1 ? "" : "s"}.`;
  const restored = await db
    .updateTable("core_scan_inbox_items")
    .set({
      status: "resolved",
      resolved_at: now,
      ai_notes: notes,
      suggested_metadata: mergeMeta({ split_prior_notes: parent.ai_notes ?? null, ...was, split_into: ids }, [...SPLIT_KEYS]) as never,
      updated_at: now,
    })
    .where("id", "=", parent.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  // The line's one order line becomes its parts' lines again (#5734).
  if (http) {
    await relineAfterChange(db, http, [parent.id], ids).catch((e: Error) => console.warn("[core-scan] split again: order lines kept as they were:", e.message));
  }
  return { ok: true, parent: restored, parts: ids };
}
