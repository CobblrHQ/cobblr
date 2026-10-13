// A scan finds the order line it is one of (#5734). The owner: "go scan
// those items and match it to that order line item".
//
// Two ways, at the end of a scan's match, once its name is known:
// - It was scanned in a session opened from the line ("Scan the items", the
//   session's `fills_line`): it fills one of that line's slots straight away.
// - It looks like the product of an open line of the same thing with a slot
//   free: it is offered, "Part of Kingroon 3D #KR52731, line 1?", and a yes
//   fills the slot. By the same name rule as "You already have", and never a
//   different variant (sameProduct) or a different stated colour: a white
//   spool is never offered to a Multicolor line, a black one never to an
//   orange line.

import { displayName } from "@cobblr/platform-contract/display-identity";
import { sql, type Kysely } from "kysely";
import { lineTakesAUnit, lineUnitsOf } from "@cobblr/platform-contract/line-units";
import { orderLineOverlap, type OrderLineProduct } from "./order-line-product.js";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { tokens } from "./entity-match.js";
import { fillLine } from "./line-slots.js";

export interface LineOffer {
  line_id: string;
  label: string;
}

/** The open line this scan is most like, with the words it is offered in. */
export async function lineOfferFor(db: Kysely<CoreScanDB>, row: OrderLineProduct & { id: string }): Promise<LineOffer | null> {
  const name = displayName(row) ?? "";
  const want = tokens(name);
  if (want.length === 0) return null;
  const lines = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "quantity", "suggested_metadata", "scan_batch_id", "created_at", "source_kind"])
    .where("source_kind", "=", "receipt")
    .where("status", "=", "pending")
    .where("quantity", ">", 1 as never)
    .where("created_at", ">", sql<Date>`now() - interval '180 days'`)
    .orderBy("created_at", "desc")
    .limit(300)
    .execute();
  let best: { line: (typeof lines)[number]; shared: number } | null = null;
  for (const line of lines) {
    if (line.id === row.id) continue;
    const m = (line.suggested_metadata ?? {}) as { line_received?: unknown; line_offer_declined_by?: unknown };
    if (!lineTakesAUnit(lineUnitsOf(line), Number(m.line_received ?? 0))) continue;
    const o = orderLineOverlap(row, line);
    if (!o.pass) continue;
    if (!best || o.shared > best.shared) best = { line, shared: o.shared };
  }
  if (!best) return null;
  const m = (best.line.suggested_metadata ?? {}) as { receipt_vendor?: unknown; receipt_line?: unknown };
  const batch = best.line.scan_batch_id
    ? await db.selectFrom("core_scan_batches").select(["order_ref", "vendor"]).where("id", "=", best.line.scan_batch_id).executeTakeFirst()
    : null;
  const at = typeof m.receipt_line === "number" ? m.receipt_line - 1 : -1;
  const vendor = (typeof m.receipt_vendor === "string" && m.receipt_vendor) || batch?.vendor || "the order";
  const ref = batch?.order_ref ? ` ${batch.order_ref.startsWith("#") ? "" : "#"}${batch.order_ref}` : "";
  return { line_id: best.line.id, label: `Part of ${vendor}${ref}${at >= 0 ? `, line ${at + 1}` : ""}?` };
}

/** The scan's line, at the end of its match: filled when it was scanned
 *  from the line, offered when it looks like one. */
export async function orderLinePass(
  db: Kysely<CoreScanDB>,
  itemId: string,
  report: (lineId: string, received: number) => Promise<void>,
): Promise<"filled" | "offered" | "none"> {
  const row = await db.selectFrom("core_scan_inbox_items").select(["id", "status", "source_kind", "suggested_name", "suggested_metadata", "scan_batch_id"]).where("id", "=", itemId).executeTakeFirst();
  if (!row || row.status !== "pending" || row.source_kind === "receipt") return "none";
  const m = (row.suggested_metadata ?? {}) as { fills_line?: unknown; fills_part?: unknown; line_offer_declined?: unknown; box_label?: { row_id?: unknown } };
  if (m.fills_line || m.fills_part) return "none";
  // Scanned in a session opened from the line ("Scan the items"), or its box
  // label named the line (box-label-pass.ts).
  const session = row.scan_batch_id ? (await db.selectFrom("core_scan_batches").select("fills_line").where("id", "=", row.scan_batch_id).executeTakeFirst())?.fills_line ?? null : null;
  const target = session ?? (typeof m.box_label?.row_id === "string" ? m.box_label.row_id : null);
  if (target) {
    const r = await fillLine(db, row.id, target);
    if (r.ok) {
      await report(target, r.received);
      return "filled";
    }
  }
  if (m.line_offer_declined) return "none";
  const offer = await lineOfferFor(db, row);
  await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: (offer ? mergeMeta({ line_offer: offer }) : mergeMeta({}, ["line_offer"])) as never })
    .where("id", "=", row.id)
    .execute();
  return offer ? "offered" : "none";
}
