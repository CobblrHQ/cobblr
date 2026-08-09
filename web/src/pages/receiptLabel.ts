// How a pending receipt names itself.
//
// The Purchases banner listed them as "KC Tool (16) · KC Tool (7) · KC Tool (1)"
// - three receipts from one vendor, told apart only by a line count, which is a
// SIZE, not an identity (reported 2026-08-03). You cannot tell which is which, and
// the count changes as you confirm lines out of them.
//
// A receipt's identifier, when it states one, is its order/invoice number - the
// same thing the scan session header shows ("Receipt · KC Tool #426613") and the
// same thing "+ PO#" edits. So use it when it exists, and fall back to today's
// shape when it does not.

export interface PendingReceiptGroup {
  vendor: string | null;
  /** Order / invoice / reference number, when the receipt stated one. */
  orderRef?: string | null;
  count: number;
}

/**
 * One receipt, named as distinctly as its data allows:
 *
 *   vendor + ref  →  "KC Tool #426613 (16)"
 *   vendor only   →  "KC Tool (16)"
 *   neither       →  "Receipt (16)"
 *
 * The count stays in every form: it is what the banner is counting, and it says
 * how much work confirming this one is.
 */
export function receiptGroupLabel(g: PendingReceiptGroup): string {
  const vendor = (g.vendor ?? "").trim();
  const ref = (g.orderRef ?? "").trim();
  const who = vendor || "Receipt";
  return ref ? `${who} #${ref} (${g.count})` : `${who} (${g.count})`;
}

/** The banner's one-line summary: the first few receipts, then an ellipsis. */
export function receiptGroupSummary(groups: PendingReceiptGroup[], max = 4): string {
  const shown = groups.slice(0, max).map(receiptGroupLabel).join(" · ");
  return groups.length > max ? `${shown} · …` : shown;
}
