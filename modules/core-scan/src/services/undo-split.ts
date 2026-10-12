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
    if (live.length) {
      await db
        .updateTable("core_scan_inbox_items")
        // The marker keeps Recently deleted from restoring a child on its
        // own: the group it came from is back, and the two would double.
        .set({ status: "discarded", suggested_metadata: mergeMeta({ split_undone_at: now.toISOString() }) as never, updated_at: now })
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
        suggested_metadata: mergeMeta({}, ["split_into", "split_prior_notes", "order_line_split", "pack_split", "line_units", "split_how"]) as never,
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
