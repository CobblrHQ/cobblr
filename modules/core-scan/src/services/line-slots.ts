// An order line's slots (#5734). A line of ten of the same thing holds ten
// units; each scan of one of them fills a slot ("3 of 10 received") and
// makes nothing new: the line is the one record, quantity 10. The owner: "go
// scan those items and match it to that order line item".
//
// A scan fills at most one slot, ever. Its own row says which line it filled
// (`fills_line`), and the line's count moves in the same transaction, with
// the line locked, so a re-press, a retry, two scans at the last slot or the
// same scan offered to two lines never count one unit twice.

import { sql, type Kysely } from "kysely";
import { lineReceivedSentence, lineTakesAUnit, lineUnitsOf } from "@cobblr/platform-contract/line-units";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";

export interface LineSlots {
  line_id: string;
  name: string | null;
  count: number;
  mode: "same" | "different";
  received: number;
  sentence: string;
  units: Array<{ id: string; name: string | null; image_file_id: string | null }>;
}

type FillRefusal = { ok: false; code: "not_a_line" | "not_a_scan" | "full" | "already_counted" | "pack"; message: string };

const meta = (r: { suggested_metadata?: unknown } | undefined) => (r?.suggested_metadata ?? {}) as Record<string, unknown>;

/** A line and the units that filled it. Null when the row is not a line of
 *  several. */
export async function lineSlots(db: Kysely<CoreScanDB>, lineId: string): Promise<LineSlots | null> {
  const line = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_name", "quantity", "suggested_metadata", "source_kind"]).where("id", "=", lineId).executeTakeFirst();
  const units = line && line.source_kind === "receipt" ? lineUnitsOf(line) : null;
  if (!line || !units) return null;
  const fills = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "image_file_id"])
    .where(sql<boolean>`suggested_metadata->>'fills_line' = ${lineId}`)
    .where("status", "=", "resolved")
    .orderBy("resolved_at", "asc")
    .execute();
  return {
    line_id: line.id,
    name: line.suggested_name,
    count: units.count,
    mode: units.mode,
    received: fills.length,
    sentence: lineReceivedSentence(fills.length, units.count),
    units: fills.map((f) => ({ id: f.id, name: f.suggested_name, image_file_id: f.image_file_id })),
  };
}

/** The pending line for a purchase's order line, when the inbox has it. */
export async function lineForOrderItem(db: Kysely<CoreScanDB>, orderItemId: string): Promise<string | null> {
  const r = await db
    .selectFrom("core_scan_inbox_items")
    .select("id")
    .where("source_kind", "=", "receipt")
    .where(sql<boolean>`suggested_metadata->>'receipt_order_item_id' = ${orderItemId}`)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return r?.id ?? null;
}

/** Count a scan as one of a line's units. */
export async function fillLine(db: Kysely<CoreScanDB>, scanId: string, lineId: string): Promise<{ ok: true; received: number; count: number } | FillRefusal> {
  return db.transaction().execute(async (tx) => {
    const line = await tx
      .selectFrom("core_scan_inbox_items")
      .select(["id", "status", "source_kind", "quantity", "suggested_name", "suggested_metadata"])
      .where("id", "=", lineId)
      .forUpdate()
      .executeTakeFirst();
    const units = line && line.source_kind === "receipt" && line.status === "pending" ? lineUnitsOf(line) : null;
    if (!line || !units) return { ok: false, code: "not_a_line", message: "That is not an open order line of several." } as const;
    if (units.mode === "different") return { ok: false, code: "pack", message: "That line is a pack of different things: each has its own line to match." } as const;
    const scan = await tx.selectFrom("core_scan_inbox_items").select(["id", "status", "source_kind", "suggested_metadata"]).where("id", "=", scanId).forUpdate().executeTakeFirst();
    if (!scan || scan.id === lineId || scan.source_kind === "receipt") return { ok: false, code: "not_a_scan", message: "Only a scan can be counted as one of a line's units." } as const;
    if (meta(scan).fills_line) return { ok: false, code: "already_counted", message: "This scan is already counted as one of an order line's units." } as const;
    if (scan.status !== "pending") return { ok: false, code: "not_a_scan", message: "This scan is already filed." } as const;
    const received = Number((await tx
      .selectFrom("core_scan_inbox_items")
      .select(sql<number>`count(*)`.as("n"))
      .where(sql<boolean>`suggested_metadata->>'fills_line' = ${lineId}`)
      .where("status", "=", "resolved")
      .executeTakeFirst())?.n ?? 0);
    if (!lineTakesAUnit(units, received)) return { ok: false, code: "full", message: `All ${units.count} of that line are already received.` } as const;
    const now = new Date();
    await tx
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        resolved_at: now,
        updated_at: now,
        ai_notes: `Counted as ${received + 1} of ${units.count} for ${line.suggested_name ?? "its order line"}.`,
        suggested_metadata: mergeMeta({ fills_line: lineId }, ["line_offer"]) as never,
      })
      .where("id", "=", scanId)
      .execute();
    await tx
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ line_received: received + 1 }) as never, updated_at: now })
      .where("id", "=", lineId)
      .execute();
    return { ok: true, received: received + 1, count: units.count } as const;
  });
}

/** Take a scan back off its line: the slot is free and the scan is back in
 *  the inbox. */
export async function unfillLine(db: Kysely<CoreScanDB>, scanId: string): Promise<{ ok: true; lineId: string; received: number } | { ok: false; message: string }> {
  return db.transaction().execute(async (tx) => {
    const scan = await tx.selectFrom("core_scan_inbox_items").select(["id", "suggested_metadata"]).where("id", "=", scanId).forUpdate().executeTakeFirst();
    // A box scan that confirmed one part of a pack (box-label-pass.ts): the
    // part forgets the box and its batch, and the scan is back in the inbox.
    const partId = typeof meta(scan).fills_part === "string" ? (meta(scan).fills_part as string) : null;
    if (scan && partId) {
      const part = await tx.selectFrom("core_scan_inbox_items").select(["id", "suggested_metadata"]).where("id", "=", partId).forUpdate().executeTakeFirst();
      const was = meta(part).box_scan as { scan_id?: unknown; lot_before?: unknown } | undefined;
      const now = new Date();
      if (part && was?.scan_id === scanId) {
        const before = typeof was.lot_before === "string" ? was.lot_before : null;
        await tx
          .updateTable("core_scan_inbox_items")
          .set({ suggested_metadata: (before ? mergeMeta({ lot: before }, ["box_scan"]) : mergeMeta({}, ["box_scan", "lot"])) as never, updated_at: now })
          .where("id", "=", partId)
          .execute();
      }
      await tx
        .updateTable("core_scan_inbox_items")
        .set({ status: "pending", resolved_at: null, ai_notes: null, updated_at: now, suggested_metadata: mergeMeta({}, ["fills_part"]) as never })
        .where("id", "=", scanId)
        .execute();
      return { ok: true, lineId: partId, received: 0 } as const;
    }
    const lineId = typeof meta(scan).fills_line === "string" ? (meta(scan).fills_line as string) : null;
    if (!scan || !lineId) return { ok: false, message: "This scan is not counted toward an order line." } as const;
    await tx.selectFrom("core_scan_inbox_items").select("id").where("id", "=", lineId).forUpdate().executeTakeFirst();
    const now = new Date();
    await tx
      .updateTable("core_scan_inbox_items")
      .set({ status: "pending", resolved_at: null, ai_notes: null, updated_at: now, suggested_metadata: mergeMeta({}, ["fills_line"]) as never })
      .where("id", "=", scanId)
      .execute();
    const received = Number((await tx
      .selectFrom("core_scan_inbox_items")
      .select(sql<number>`count(*)`.as("n"))
      .where(sql<boolean>`suggested_metadata->>'fills_line' = ${lineId}`)
      .where("status", "=", "resolved")
      .executeTakeFirst())?.n ?? 0);
    await tx
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ line_received: received }) as never, updated_at: now })
      .where("id", "=", lineId)
      .execute();
    return { ok: true, lineId, received } as const;
  });
}
