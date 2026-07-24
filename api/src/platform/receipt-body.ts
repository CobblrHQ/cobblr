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
