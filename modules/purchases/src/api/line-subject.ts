// VOCAB-ENUMERATION OK: turning an order line into the acquisition facts it
// is evidence for is this file's subject, the same translation a receipt's
// facts go through; naming the three roles is the point.
//
// What an order line bought, and what that line tells the thing about itself.
//
// One way only (#3856, the owner's decision): the record's own Acquired from /
// Acquired on / Paid fields are what every screen, Cobb and export read. The
// order is evidence that fills them, once when a line is claimed and again
// when the order's vendor, date or the line's amount changes, and never over
// what a person typed (`mayWriteField`: person beats evidence beats a guess).
// A field edit never reaches back into the order. The link runs both ways:
// the thing is `bought-in` the order, so the printer opens its order and the
// order opens the printer.
import {
  mapRoledFacts,
  platform,
  roledFactsPatch,
  roledNativePatch,
  type RoledFacts,
} from "@cobblr/platform-contract";
import {
  FIELD_PROVENANCE_KEY,
  fieldProvenanceOf,
  mayWriteField,
  type FieldProvenanceMap,
} from "@cobblr/platform-contract/acquisition-source";

export const BOUGHT_IN = "bought-in";
export const ORDER_KIND = "purchases:order";

export interface LineSubject {
  kind: string;
  id: string;
}

export interface OrderEvidence {
  orderId: string;
  vendor: string | null;
  orderedAt: string | Date | null;
  qty: number | string | null;
  unitCost: number | string | null;
  lineAmount: number | string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** What one line says about the thing it bought. Paid is what ONE of them
 *  cost: the line's stated amount when it bought one, else the unit cost. */
export function orderFacts(e: OrderEvidence): RoledFacts {
  const facts: RoledFacts = {};
  if (e.vendor && e.vendor.trim()) facts["acquired-from"] = e.vendor.trim();
  if (e.orderedAt) {
    const d = e.orderedAt instanceof Date ? e.orderedAt.toISOString().slice(0, 10) : String(e.orderedAt).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) facts["acquired-on"] = d;
  }
  const qty = num(e.qty) ?? 1;
  const paid = qty === 1 ? (num(e.lineAmount) ?? num(e.unitCost)) : num(e.unitCost);
  if (paid !== null) facts["acquired-for"] = paid;
  return facts;
}

/** Fill the thing's acquisition fields from the order, as evidence that
 *  opens the order. Returns the field names written. A field a person set is
 *  left alone; a field this workspace does not have is simply not there. */
export async function stampFromOrder(orgId: string, subject: LineSubject, e: OrderEvidence): Promise<string[]> {
  const roled = await platform().entities.roledFieldsFor(orgId, subject.kind);
  const mapped = mapRoledFacts(orderFacts(e), roled);
  // The record's own columns (a vehicle's Paid, Purchased at, Bought from)
  // and its metadata fields, judged by the same rules and written each
  // through its own door.
  const nativePatch = roledNativePatch(mapped);
  const patch = { ...roledFactsPatch(mapped), ...nativePatch };
  if (Object.keys(patch).length === 0) return [];
  // The whole row, not the projected lookup: what the record holds now and
  // who put it there are both in metadata, which a lookup does not expose.
  const row = await platform().entities.snapshot(orgId, subject.kind, subject.id).catch(() => null);
  if (!row) return [];
  const rawMeta = (row as { metadata?: unknown }).metadata;
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : (rawMeta ?? {})) as Record<string, unknown>;
  const prov: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  const roleOf = new Map(roled.map((f) => [f.name, f.field_role]));
  const writes: Record<string, unknown> = {};
  const at = new Date().toISOString();
  for (const [field, value] of Object.entries(patch)) {
    const had = field in nativePatch ? (row as Record<string, unknown>)[field] : meta[field];
    const hasValue = had !== null && had !== undefined && had !== "";
    if (!mayWriteField(prov[field], "evidence", { hasEvidence: true, hasValue })) continue;
    // Another source's evidence stays: a receipt writes Paid only when its
    // own numbers reconciled, and an order line's raw total must not undo that.
    const was = prov[field];
    if (was?.by === "evidence" && was.from !== "order") continue;
    // A value with no stamp at all was typed before stamps existed: a person's.
    if (hasValue && !was) continue;
    writes[field] = value;
    prov[field] = { by: "evidence", from: "order", ref: { kind: ORDER_KIND, id: e.orderId }, at, ...(roleOf.get(field) ? { role: String(roleOf.get(field)) } : {}) };
  }
  if (Object.keys(writes).length === 0) return [];
  const nativeWrites = Object.fromEntries(Object.entries(writes).filter(([k]) => k in nativePatch));
  const metaWrites = Object.fromEntries(Object.entries(writes).filter(([k]) => !(k in nativePatch)));
  let nativeWritten: string[] = [];
  if (Object.keys(nativeWrites).length) {
    const writer = await platform().entities.getWriter(orgId, subject.kind);
    if (writer) {
      await writer.update(orgId, subject.id, nativeWrites);
      nativeWritten = Object.keys(nativeWrites);
    } else {
      // Nothing can write the kind's own column: no stamp claims it was.
      for (const k of Object.keys(nativeWrites)) delete prov[k];
    }
  }
  const ok = await platform().entities.mergeMetadata(orgId, subject.kind, subject.id, { ...metaWrites, [FIELD_PROVENANCE_KEY]: prov });
  return [...(ok ? Object.keys(metaWrites) : []), ...nativeWritten];
}

/** The thing is bought in the order: once, whichever door claims it. */
export async function linkBoughtIn(orgId: string, subject: LineSubject, orderId: string, userId: string | null): Promise<void> {
  const existing = await platform().pairings.findBySources({
    orgId,
    sourceKind: subject.kind,
    sourceIds: [subject.id],
    targetKind: ORDER_KIND,
    relationshipKind: BOUGHT_IN,
  });
  if (existing.some((p) => p.targetId === orderId)) return;
  await platform().pairings.create({
    orgId,
    sourceKind: subject.kind,
    sourceId: subject.id,
    targetKind: ORDER_KIND,
    targetId: orderId,
    relationshipKind: BOUGHT_IN,
    createdBy: userId,
  });
}

export async function unlinkBoughtIn(orgId: string, subject: LineSubject, orderId: string): Promise<void> {
  await platform().pairings.remove({
    orgId,
    sourceKind: subject.kind,
    sourceId: subject.id,
    targetKind: ORDER_KIND,
    targetId: orderId,
    relationshipKind: BOUGHT_IN,
  });
}

/** Claim (or, with null, release) one line for a record: the line's subject,
 *  `part_id` kept for a part so its readers are unchanged, the bought-in link,
 *  and the thing's fields filled from the order. One place, for the claim
 *  route and for adding a line that already names what it bought. */
export async function claimLine(args: {
  db: import("kysely").Kysely<import("../db.js").PurchasesDB>;
  orgId: string;
  userId: string | null;
  orderId: string;
  itemId: string;
  subject: LineSubject | null;
}): Promise<Record<string, unknown> | null> {
  const { db, orgId, orderId, itemId, subject } = args;
  const before = await db
    .selectFrom("purchases_order_items")
    .select(["subject_kind", "subject_id"])
    .where("id", "=", itemId)
    .where("order_id", "=", orderId)
    .executeTakeFirst();
  if (!before) return null;
  const isPart = subject ? (await platform().entities.baseKindOf(orgId, subject.kind)) === "inventory:part" : false;
  const updated = await db
    .updateTable("purchases_order_items")
    .set({
      subject_kind: subject?.kind ?? null,
      subject_id: subject?.id ?? null,
      part_id: subject && isPart ? subject.id : null,
      updated_at: new Date(),
    } as never)
    .where("id", "=", itemId)
    .where("order_id", "=", orderId)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (before.subject_kind && before.subject_id && (before.subject_kind !== subject?.kind || before.subject_id !== subject?.id)) {
    const stillClaimed = await db
      .selectFrom("purchases_order_items")
      .select("id")
      .where("order_id", "=", orderId)
      .where("subject_kind", "=", before.subject_kind)
      .where("subject_id", "=", before.subject_id)
      .executeTakeFirst();
    if (!stillClaimed) await unlinkBoughtIn(orgId, { kind: before.subject_kind, id: before.subject_id }, orderId);
  }
  if (subject) {
    await linkBoughtIn(orgId, subject, orderId, args.userId);
    await stampLine(db, orgId, orderId, itemId);
  }
  return updated as Record<string, unknown>;
}

/** Re-read one claimed line and its order, and fill the thing from them. */
export async function stampLine(
  db: import("kysely").Kysely<import("../db.js").PurchasesDB>,
  orgId: string,
  orderId: string,
  itemId?: string,
): Promise<number> {
  const order = await db.selectFrom("purchases_orders").select(["id", "vendor", "ordered_at"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return 0;
  let q = db
    .selectFrom("purchases_order_items")
    .select(["id", "subject_kind", "subject_id", "qty", "unit_cost", "line_amount"])
    .where("order_id", "=", orderId)
    .where("subject_id", "is not", null);
  if (itemId) q = q.where("id", "=", itemId);
  let n = 0;
  for (const line of await q.execute()) {
    if (!line.subject_kind || !line.subject_id) continue;
    const written = await stampFromOrder(orgId, { kind: line.subject_kind, id: line.subject_id }, {
      orderId,
      vendor: order.vendor,
      orderedAt: order.ordered_at as unknown as string | Date | null,
      qty: line.qty,
      unitCost: line.unit_cost,
      lineAmount: line.line_amount,
    }).catch(() => []);
    if (written.length) n++;
  }
  return n;
}
