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
