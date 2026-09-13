// Which field NAMES hold a receipt's facts.
//
// The provenance preset ships `acquired_from` / `acquired_on`; a workspace may
// have written `bought_from`, `store` or `purchase_date` by hand. The server
// writes the till's date and shop into whichever of these the table declares,
// and the card in the browser hides the same chip again when the session
// header already states it. One list, read by both, so the field the server
// fills is always the field the card recognises.

export const RECEIPT_DATE_NAMES = /^(acquired|purchased|bought)_(on|at|date)$|^purchase_date$|^date_(acquired|purchased|bought)$/;
export const RECEIPT_FROM_NAMES = /^(acquired|purchased|bought|sourced)_from$|^(vendor|store|retailer|shop|supplier|source_store|purchased_at_store)$/;
export const RECEIPT_WEIGHT_NAMES = /^(net_)?weight$/;
export const RECEIPT_WEIGHT_UNIT_NAMES = /^weight_unit$/;
export const RECEIPT_UNIT_PRICE_NAMES = /^(unit_price|price_per_unit|price_per_lb|price_per_kg)$/;

export function isReceiptDateField(name: string): boolean {
  return RECEIPT_DATE_NAMES.test(name.trim().toLowerCase());
}

export function isReceiptFromField(name: string): boolean {
  return RECEIPT_FROM_NAMES.test(name.trim().toLowerCase());
}

/** The fields that say where, when and for how much a thing was BOUGHT: the
 *  seller and the shop, the price, the order or invoice number, the date.
 *  They are filled only from purchase evidence (a receipt, an order, a
 *  person's own words); a photo of the thing cannot say any of it, and a
 *  model asked to route a photo will name a shop anyway ("Amazon", "Local
 *  yarn shop" on four balls of yarn, #2970). One list, so the server strips
 *  what the evidence cannot support and the card can say what kind of
 *  field it is. */
export const PURCHASE_SELLER_NAMES = /^(seller|sold_by|merchant|marketplace_seller)$/;
export const PURCHASE_PRICE_NAMES = /^(price|cost|paid|amount_paid|price_paid|purchase_price|total_price|unit_price|price_per_unit)$/;
export const PURCHASE_REF_NAMES = /^(order_ref|order_number|order_no|order_id|invoice|invoice_number|invoice_no|receipt_number|receipt_no|po_number|purchase_order)$/;
export function isPurchaseField(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    RECEIPT_FROM_NAMES.test(n) ||
    RECEIPT_DATE_NAMES.test(n) ||
    RECEIPT_UNIT_PRICE_NAMES.test(n) ||
    PURCHASE_SELLER_NAMES.test(n) ||
    PURCHASE_PRICE_NAMES.test(n) ||
    PURCHASE_REF_NAMES.test(n)
  );
}
