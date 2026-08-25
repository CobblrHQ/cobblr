/** Turning a parsed receipt into a purchases order — the ONE implementation.
 *
 *  This used to live inline in the receipt-group confirm handler, which meant
 *  an order was born only if somebody triaged. A receipt nobody got to was not
 *  in Purchases at all, and a receipt attached to an already-triaged item had
 *  no moment at which its order could appear. The birthplace moved to parse
 *  time (docs/design-decisions/order-at-parse.md) and the code moved here so
 *  the two callers cannot drift into two slightly different orders.
 *
 *  EVERY CALL IS BEST-EFFORT. purchases may not be enabled, and a workspace
 *  without it still uploads receipts, still triages them and still commits
 *  them — it simply has no order. Failures are warned and swallowed, never
 *  thrown, because losing the order must not lose the receipt.
 *
 *  Module isolation: purchases is reached over its HTTP API, never its tables
 *  (CLAUDE.md §4). That this file names `purchases` at all is counted by
 *  scripts/census-module-coupling.ts — see
 *  docs/architecture/module-coupling-census.md for why the count matters.
 */

import { arrivedEverywhere } from "@cobblr/platform-contract";
import { fileReceiptAs, type KnownShipment } from "./receipt-arrival.js";

export interface ReceiptOrderInput {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
  vendor: string | null;
  orderRef: string | null;
  orderedAt: string | null;
  trackingNumber: string | null;
  knownShipment: KnownShipment | null;
  /** The receipt's promised delivery date, when it stated one. Reaches the
   *  order's own expected_arrival - before this it lived only on scan-item
   *  metadata, so the order had no ETA, no calendar event, and no due ask. */
  expectedArrival?: string | null;
  /** Receipt total, when the parse actually saw one. */
  total: number | null;
  groupId: string;
  sourceFileId: string | null;
}

/** Find-or-create the vendor RECORD, so an order points at a managed vendor
 *  rather than carrying loose text. Null when purchases is off or the receipt
 *  named nobody — the order then keeps the legacy vendor string. */
export async function linkVendor(
  input: Pick<ReceiptOrderInput, "baseUrl" | "slug" | "headers" | "vendor">,
): Promise<string | null> {
  const { vendor } = input;
  if (!vendor) return null;
  try {
    const base = `${input.baseUrl}/api/v1/orgs/${input.slug}/modules/purchases/vendors`;
    const listRes = await fetch(base, { headers: input.headers });
    if (!listRes.ok) return null;
    const items = ((await listRes.json()) as { items?: Array<{ id: string; name: string }> }).items ?? [];
    const hit = items.find((v) => v.name.trim().toLowerCase() === vendor.trim().toLowerCase());
    if (hit) return hit.id;
    const cRes = await fetch(base, { method: "POST", headers: input.headers, body: JSON.stringify({ name: vendor }) });
    return cRes.ok ? ((await cRes.json()) as { id: string }).id : null;
  } catch (err) {
    console.warn("[core-scan] receipt vendor link threw:", (err as Error).message);
    return null;
  }
}

/** Create the order for a parsed receipt. Returns its id, or null when
 *  purchases is disabled or the call failed — both of which are survivable. */
export async function createReceiptOrder(input: ReceiptOrderInput): Promise<string | null> {
  const vendorId = await linkVendor(input);
  try {
    const res = await fetch(`${input.baseUrl}/api/v1/orgs/${input.slug}/modules/purchases/orders`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({
        vendor_id: vendorId ?? undefined,
        vendor: vendorId ? undefined : input.vendor, // vendor_id dual-writes the name
        order_number: input.orderRef ?? undefined,
        ordered_at: input.orderedAt,
        // Already here, or still coming — the tracking number or a future
        // promised date decides. See services/receipt-arrival.ts; the arrival
        // sweep skips 'arrived'.
        ...fileReceiptAs(
          input.trackingNumber,
          input.orderedAt,
          input.knownShipment,
          input.expectedArrival ?? null,
          arrivedEverywhere(new Date()),
        ),
        expected_arrival: input.expectedArrival ?? undefined,
        total_cost: input.total ?? undefined,
        notes: "Imported from a receipt.",
        metadata: {
          receipt_group_id: input.groupId,
          source: "receipt",
          receipt_file_id: input.sourceFileId ?? undefined,
        },
      }),
    });
    if (res.ok) return ((await res.json()) as { id: string }).id;
    console.warn(`[core-scan] receipt PO create skipped (${res.status}) — purchases disabled?`);
    return null;
  } catch (err) {
    console.warn("[core-scan] receipt PO create threw:", (err as Error).message);
    return null;
  }
}

/** What one order line costs each, from what the parse actually read.
 *
 *  A receipt line arrives with EITHER a unit price or a line amount, and which
 *  one depends on the receipt's own columns: the CSV mapper fills `unit_price`
 *  only when there is a unit-price column, and `line_total` from a plain
 *  "price"/"amount" column. Reading only `unit_price` drops the cost of every
 *  receipt of the second kind — which is most of them, and which is exactly
 *  what shipped and was caught by running it against staging rather than by
 *  any test.
 *
 *  The amount is what must survive: qty × unit_cost has to reconstruct what the
 *  line said, or the order totals a different number than the receipt. So a
 *  line amount is divided back down rather than dropped or stored as if it were
 *  per-unit. */
export function lineUnitCost(
  unitPrice: number | null,
  lineTotal: number | null,
  qty: number,
): number | null {
  if (unitPrice != null && Number.isFinite(unitPrice)) return unitPrice;
  if (lineTotal == null || !Number.isFinite(lineTotal)) return null;
  const n = Number.isFinite(qty) && qty > 0 ? qty : 1;
  // Two decimals: money, and 12/3 must not become 3.9999999999999996.
  return Math.round((lineTotal / n) * 100) / 100;
}

/** Record a parsed line on the order WITHOUT claiming anything was acquired.
 *
 *  A line on a receipt is not a thing you own — most of a grocery order is
 *  eaten — so `part_id` stays null until somebody promotes the line into an
 *  item. The nullable column is exactly this shape, and the count of null ones
 *  is what the inbox banner offers. */
export async function addOrderLine(args: {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
  orderId: string;
  description: string;
  qty: number;
  unitCost: number | null;
  /** What the receipt line actually said, when it stated an amount rather than
   *  a per-unit price. Sent alongside the derived unit cost because the two are
   *  not always reconcilable: 1.50 over qty 4 is 0.375, money is two decimals,
   *  and 4 x 0.38 comes back as 1.52. The amount is the thing the receipt is
   *  authority on, so it travels rather than being recomputed. */
  lineAmount?: number | null;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${args.baseUrl}/api/v1/orgs/${args.slug}/modules/purchases/orders/${args.orderId}/items`,
      {
        method: "POST",
        headers: args.headers,
        body: JSON.stringify({
          description: args.description,
          qty: args.qty,
          unit_cost: args.unitCost ?? undefined,
          line_amount: args.lineAmount ?? undefined,
        }),
      },
    );
    if (!res.ok) console.warn(`[core-scan] receipt order line skipped (${res.status})`);
    return res.ok;
  } catch (err) {
    console.warn("[core-scan] receipt order line threw:", (err as Error).message);
    return false;
  }
}

/** The receipt was thrown away, so the order it created should not outlive it.
 *
 *  Only needed because the order is now created EAGERLY: before this moved, an
 *  abandoned receipt never reached Purchases at all. Cancelled rather than
 *  deleted — the status already exists, and a cancelled order is a truer record
 *  of "this was uploaded and discarded" than a gap. */
export async function cancelReceiptOrder(args: {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
  orderId: string;
}): Promise<void> {
  try {
    await fetch(`${args.baseUrl}/api/v1/orgs/${args.slug}/modules/purchases/orders/${args.orderId}`, {
      method: "PATCH",
      headers: args.headers,
      body: JSON.stringify({ status: "cancelled" }),
    });
  } catch (err) {
    console.warn("[core-scan] receipt order cancel threw:", (err as Error).message);
  }
}
