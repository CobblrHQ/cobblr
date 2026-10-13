// What a purchase line offers that depends on its things arriving: scanning
// its units in, and starting a return. One rule for every surface that draws
// a line, so a button is never offered that cannot do what it says.
//
// "Scan the items" sat on a typed-in line of two with the order's stock
// reception off; it opened nothing, because only a line read from a receipt
// has units to scan in, and said nothing (#6219). A line that cannot scan in
// does not offer to; when the reason is one the person can change (the
// order's stock reception), the line says so.

export type LineOffer = { offered: true } | { offered: false; reason: string | null };

export interface PurchaseLineContext {
  order: { status: string; add_to_stock?: boolean | null };
  item: { qty: number; received_at: string | null; part_id: string | null };
  /** Whether the line has units to scan in: true when its receipt line was
   *  found and is several of the same thing, false when the scan module said
   *  there is none or it is a pack of different things, null while that is
   *  not known. */
  scanLine: boolean | null;
}

export const STOCK_RECEPTION_OFF = "Stock reception is off for this order, so there is nothing to scan in.";

export function purchaseLineActions(ctx: PurchaseLineContext): { scanIn: LineOffer; startReturn: LineOffer } {
  return { scanIn: scanIn(ctx), startReturn: startReturn(ctx) };
}

function scanIn({ order, item, scanLine }: PurchaseLineContext): LineOffer {
  // A line of one, a line already in, or a line kept as one of your things
  // has no units to count: nothing to offer and nothing to explain.
  if (item.qty <= 1 || item.received_at || item.part_id) return { offered: false, reason: null };
  if (order.status === "cancelled") return { offered: false, reason: null };
  if (order.add_to_stock === false) return { offered: false, reason: STOCK_RECEPTION_OFF };
  return scanLine === true ? { offered: true } : { offered: false, reason: null };
}

function startReturn({ order }: PurchaseLineContext): LineOffer {
  return order.status === "arrived" ? { offered: true } : { offered: false, reason: null };
}
