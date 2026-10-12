// The session an order is already in, for a receipt read again from a new
// email. A store's order number is unique per shop, so the same (shop,
// number) is the same order. A session read before #5722 is named for the
// forwarding banner ("---------- Forwarded message") or has no shop, and one
// may have no number at all: the same number there, or the same lines
// (content_key), is this order too. Without those a re-forward of the
// owner's Kingroon email made a second session of the same lines (#6004).
// Only a LIVE session counts (one with a line not thrown away): a receipt
// whose lines were all discarded imports again.
import { sql, type Kysely } from "kysely";
import { isMailTitle } from "./receipt-shared.js";

interface PriorDB {
  core_scan_batches: { id: string; label: string | null; vendor: string | null; order_ref: string | null; content_key: string | null; created_at: Date };
  core_scan_inbox_items: { id: string; scan_batch_id: string | null; status: string };
}

export interface PriorSession { id: string; label: string | null; vendor: string | null; order_ref: string | null }

export async function priorSessionOfOrder(
  db: Kysely<never>,
  key: { vendor: string; orderRef: string },
  contentKey: string | null,
): Promise<PriorSession | undefined> {
  const k = db as unknown as Kysely<PriorDB>;
  const live = sql<boolean>`exists (select 1 from core_scan_inbox_items i where i.scan_batch_id = b.id and i.status <> 'discarded')`;
  const cols = ["b.id", "b.label", "b.vendor", "b.order_ref"] as const;
  const sameShop = await k
    .selectFrom("core_scan_batches as b")
    .select(cols)
    .where(sql<boolean>`lower(regexp_replace(coalesce(b.vendor, ''), '[^a-zA-Z0-9]', '', 'g')) = ${key.vendor}`)
    .where("b.order_ref", "=", key.orderRef)
    .where(live)
    .orderBy("b.created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (sameShop) return sameShop;
  const sameNumber = (
    await k.selectFrom("core_scan_batches as b").select(cols).where("b.order_ref", "=", key.orderRef).where(live).orderBy("b.created_at", "desc").execute()
  ).find((b) => !b.vendor?.trim() || isMailTitle(b.vendor));
  if (sameNumber) return sameNumber;
  if (!contentKey) return undefined;
  return k
    .selectFrom("core_scan_batches as b")
    .select(cols)
    .where("b.content_key", "=", contentKey)
    .where((eb) => eb.or([eb("b.order_ref", "is", null), eb("b.order_ref", "=", key.orderRef)]))
    .where(live)
    .orderBy("b.created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}
