// Pure decision layer for the receipts+ inbound EMAIL path — no DB, no network,
// so the never-vanish invariant is unit-testable in isolation.
//
// A forwarded receipt email carries its line items in the BODY, not a file
// attachment. This path used to hard-drop such an email with zero feedback
// ("I emailed a receipt and nothing happened"). planBodyCapture guards that
// class: a substantive body is NEVER "skip".

// Body long enough to be worth capturing (a bare "thanks!" isn't a receipt).
export const MIN_BODY_CHARS = 40;

/** How to capture a forwarded-receipt email BODY when no file attachment
 *  produced items. A substantive body (≥ MIN_BODY_CHARS) is ALWAYS run through
 *  the receipt PARSER first — it has an AI tier that extracts line items from any
 *  receipt-shaped text, so a forwarded order-confirmation ("Knipex Wire
 *  Stripper … $34.99") becomes one row per line. (An earlier version gated this
 *  on a crude "looksMultiItem" regex for `2x`/`qty:` patterns, which real
 *  order emails don't match — so a genuine multi-line receipt was mis-routed to a
 *  single useless note.) The note is only a RUNTIME fallback, when the parser
 *  itself returns nothing. Only a too-short/empty body skips. */
export function planBodyCapture(text: string | undefined): "receipt" | "skip" {
  const body = (text ?? "").trim();
  if (body.length < MIN_BODY_CHARS) return "skip";
  return "receipt";
}

/** What to do with an email the parser took NO line from: open the order its
 *  subject and link name, keep the whole body as a note, or nothing.
 *
 *  Decided here, apart from the body's length, because it was once decided
 *  inside the "is the body long enough to parse" branch: an Amazon "Ordered: 1
 *  Electronics item" is 27 characters of plain text and a link, so it was too
 *  short to parse, and the order that the shipping notices needed to attach
 *  to was never opened. The order number comes from the subject and the html
 *  link, and a body of any length, or none, is enough to open it. The note is
 *  the last resort and only for a body worth keeping. */
export function planEmptyRead(input: {
  text: string | undefined;
  parsedCount: number;
  duplicate: boolean;
  appliedShipment: boolean;
  /** The classifier read a store and an order number out of the email. */
  orderNotice: boolean;
  /** A store's machine sent something unreadable: archived and dropped. */
  machineNoise: boolean;
}): "order-notice" | "note" | "nothing" {
  if (input.parsedCount > 0 || input.duplicate || input.appliedShipment) return "nothing";
  if (input.orderNotice) return "order-notice";
  if (input.machineNoise) return "nothing";
  return planBodyCapture(input.text) === "receipt" ? "note" : "nothing";
}
