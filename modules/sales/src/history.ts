// An order's history: what happened to it, when, and who did it.
//
// orderHappened is the one door every change to an order goes through, from
// whichever place made it (a route, an action, Fulfill, Ship, Make this). It
// writes the order's own timeline, the workspace activity log and, for a
// status move, the sales.order.status_changed event. Before it, each place
// wrote what it remembered: Fulfill and Ship moved the status with no event,
// line changes left no trace at all, and a wire on status_changed missed
// every order that shipped.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesHistoryKind } from "./db.js";

export interface HistoryEntry {
  kind: SalesHistoryKind;
  from_status?: string | null;
  to_status?: string | null;
  detail?: Record<string, unknown>;
  by_user?: string | null;
}

/** The workspace log's word for an entry. An order's first status is its
 *  creation, which the creating door logs with the order's name. */
function actionFor(e: HistoryEntry): string | null {
  switch (e.kind) {
    case "status":
      return e.from_status ? "order_status_changed" : null;
    case "stock":
      return "order_stock_taken";
    case "shipped":
      return "order_shipped";
    case "email":
      return "order_emailed";
    case "work_order":
      return "order_make_started";
    case "line":
      return `order_line_${String(e.detail?.change ?? "changed")}`;
    case "delivered":
      return "order_delivered";
  }
}

// Transactions defer activity and bus effects until their history row commits.
export async function orderHappened(db: Kysely<SalesDB>, orgId: string, orderId: string, e: HistoryEntry, afterCommit?: Array<() => Promise<void>>): Promise<void> {
  await db
    .insertInto("sales_order_history")
    .values({
      order_id: orderId,
      kind: e.kind,
      from_status: e.from_status ?? null,
      to_status: e.to_status ?? null,
      detail: sql`${JSON.stringify(e.detail ?? {})}::jsonb` as never,
      by_user: e.by_user ?? null,
    })
    .execute();
  const publish = async () => {
    const action = actionFor(e);
    if (action) {
      await platform().activity.log({
        orgId,
        userId: e.by_user ?? null,
        action,
        ref: { module: "sales", entityType: "order", entityId: orderId },
        diff: { ...(e.kind === "status" ? { status: { from: e.from_status ?? null, to: e.to_status ?? null } } : {}), ...(e.detail ?? {}) },
      });
    }
    if (e.kind === "status" && e.from_status && e.to_status && e.from_status !== e.to_status) {
      await platform().events.emit("sales.order.status_changed", { orgId, orderId, from: e.from_status, to: e.to_status });
    }
  };
  if (afterCommit) afterCommit.push(publish);
  else await publish();
}

export async function readHistory(db: Kysely<SalesDB>, orderId: string) {
  return db
    .selectFrom("sales_order_history")
    .selectAll()
    .where("order_id", "=", orderId)
    .orderBy("created_at", "asc")
    .execute();
}
