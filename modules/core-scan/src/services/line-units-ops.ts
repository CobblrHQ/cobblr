// An order line's units, as operations (#5734): one implementation behind
// every door. The inbox's routes call these with the request's session; the
// core-scan actions (the assistant and the MCP server, through invoke_action
// and its change ledger) call them with a session minted for the person.

import type { Kysely } from "kysely";
import { countOf } from "@cobblr/platform-contract";
import { lineUnitsOf } from "@cobblr/platform-contract/line-units";
import type { CoreScanDB } from "../db.js";
import { intakeRow } from "./intake.js";
import { mergeMeta } from "./metadata.js";
import { rejoinPart, splitOffPart, splitRowIntoParts, type Admit } from "./row-parts.js";
import { fillLine, lineForOrderItem, unfillLine } from "./line-slots.js";
import { relineAfterChange, splitOrderLineForParts, type PurchaseHttp } from "./receipt-purchase.js";
import { undoSplit } from "./undo-split.js";
import { reportReceived } from "./receipt-order.js";

/** Who is acting, and how to reach the rest of the workspace as them. */
export interface LineDoor {
  db: Kysely<CoreScanDB>;
  orgId: string;
  orgSlug: string;
  userId: string | null;
  token: string | null;
  baseUrl: string;
}

export type LineOpResult = { ok: true; ids: string[]; received?: number; count?: number } | { ok: false; status: number; code: string; message: string; item_id?: string };

const refuse = (status: number, code: string, message: string, item_id?: string): LineOpResult => ({ ok: false, status, code, message, ...(item_id ? { item_id } : {}) });

function purchaseOf(d: LineDoor): PurchaseHttp | null {
  return d.token ? { baseUrl: d.baseUrl, slug: d.orgSlug, headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" } } : null;
}

function admitFor(d: LineDoor): Admit {
  return async (values) =>
    (await intakeRow({ db: d.db, orgId: d.orgId, orgSlug: d.orgSlug, userId: d.userId, token: d.token, baseUrl: d.baseUrl, door: "receipt", values: values as never })).row as { id: string };
}

/** Tell the purchase how many of its line's units are in hand. */
export async function reportLineReceived(d: LineDoor, lineId: string, received: number): Promise<void> {
  const http = purchaseOf(d);
  if (!http) return;
  const line = await d.db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", lineId).executeTakeFirst();
  const m = (line?.suggested_metadata ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown };
  if (typeof m.receipt_order_id === "string" && typeof m.receipt_order_item_id === "string") {
    await reportReceived({ ...http, orderId: m.receipt_order_id, itemId: m.receipt_order_item_id, received }).catch((e: Error) =>
      console.warn("[core-scan] received count not reported:", e.message),
    );
  }
}

/** The line says which it is: "a pack of N different" makes its N rows;
 *  "they are all the same" puts a split line back together. */
export async function setLineUnits(d: LineDoor, itemId: string, mode: "same" | "different"): Promise<LineOpResult> {
  const row = await d.db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirst();
  if (!row) return refuse(404, "not_found", "inbox item not found");
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  // A part of a split line speaks for the line it came from.
  if (mode === "same" && (typeof meta.split_from === "string" || Array.isArray(meta.split_into))) {
    const back = await undoSplit(d.db, d.orgId, row.id, purchaseOf(d));
    if (!back.ok) return refuse(back.status, back.error.code, back.error.message, back.error.item_id);
    await d.db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ line_units: { mode: "same", by: "person" } }) as never }).where("id", "=", back.parent.id).execute();
    return { ok: true, ids: [back.parent.id] };
  }
  const units = row.source_kind === "receipt" && row.status === "pending" ? lineUnitsOf(row) : null;
  if (!units) return refuse(409, "not_a_line", "Only an open order line of several has units to sort.");
  if (mode === "same") {
    await d.db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ line_units: { mode: "same", by: "person" } }) as never, updated_at: new Date() }).where("id", "=", row.id).execute();
    return { ok: true, ids: [row.id] };
  }
  if (Number(meta.line_received ?? 0) > 0) return refuse(409, "counted", "Some of this line's units are already counted by scan. Take them back off first.");
  const pack = meta.line_pack as { each?: string | null } | undefined;
  const parts = Array.from({ length: units.count }, () => ({
    name: row.suggested_name ?? "Part of an order line",
    n: 1,
    // Each carries the line's name until a person names it: unnamed parts
    // are not known to be the same thing (pack-groups.ts).
    meta: { unit_unnamed: true, ...(pack ? { line_pack: { ask: false, count: 1, each: pack.each ?? null, whole: null } } : {}) },
  }));
  const children = await splitRowIntoParts({ db: d.db, admit: admitFor(d) }, row, meta, parts, {
    note: `Split into ${countOf(units.count, { singular: "different thing", plural: "different things" })} by hand.`,
    mark: { line_units: { mode: "different", by: "person" }, split_how: "hand" },
  });
  const http = purchaseOf(d);
  if (http) await splitOrderLineForParts(d.db, row.id, http).catch((e: Error) => console.warn("[core-scan] split by hand: order line kept:", e.message));
  return { ok: true, ids: children };
}

/** Some of a line's units differ ("8 white, 2 black"): they leave as a row
 *  of their own; the line keeps the rest. */
export async function splitOffUnits(d: LineDoor, itemId: string, count: number, name?: string): Promise<LineOpResult> {
  const row = await d.db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirst();
  const units = row && row.source_kind === "receipt" && row.status === "pending" ? lineUnitsOf(row) : null;
  if (!row || !units) return refuse(409, "not_a_line", "Only an open order line of several can have some split off.");
  if (!(count >= 1) || count >= units.count) return refuse(400, "too_many", `A line of ${units.count} can split off between 1 and ${units.count - 1}.`);
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const childId = await splitOffPart({ db: d.db, admit: admitFor(d) }, row, meta, { name: name?.trim() || row.suggested_name || "Part of an order line", n: count });
  const http = purchaseOf(d);
  if (http) await relineAfterChange(d.db, http, [row.id], [row.id, childId]).catch((e: Error) => console.warn("[core-scan] split off: order lines kept:", e.message));
  return { ok: true, ids: [row.id, childId] };
}

/** A part split off goes back into its line. */
export async function rejoinOrderLine(d: LineDoor, partId: string): Promise<LineOpResult> {
  const r = await rejoinPart(d.db, partId);
  if (!r.ok) return refuse(409, r.code, r.message);
  const http = purchaseOf(d);
  if (http) await relineAfterChange(d.db, http, [r.lineId, partId], [r.lineId]).catch((e: Error) => console.warn("[core-scan] rejoin: order lines kept:", e.message));
  return { ok: true, ids: [r.lineId] };
}

/** This scan is one of an order line's units. */
export async function fillOrderLine(d: LineDoor, scanId: string, line: { line_id?: string; order_item_id?: string }): Promise<LineOpResult> {
  const lineId = line.line_id ?? (line.order_item_id ? await lineForOrderItem(d.db, line.order_item_id) : null);
  if (!lineId) return refuse(404, "no_line", "That purchase line is not waiting in the inbox.");
  const r = await fillLine(d.db, scanId, lineId);
  if (!r.ok) return refuse(r.code === "already_counted" || r.code === "full" ? 409 : 400, r.code, r.message);
  await reportLineReceived(d, lineId, r.received);
  return { ok: true, ids: [lineId, scanId], received: r.received, count: r.count };
}

/** The scan was not one of the line's units after all. */
export async function unfillOrderLine(d: LineDoor, scanId: string): Promise<LineOpResult> {
  const r = await unfillLine(d.db, scanId);
  if (!r.ok) return refuse(409, "not_counted", r.message);
  await reportLineReceived(d, r.lineId, r.received);
  return { ok: true, ids: [r.lineId, scanId], received: r.received };
}
