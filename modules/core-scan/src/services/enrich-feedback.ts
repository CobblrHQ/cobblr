/** Saying so when a re-run decided against the answer it went and got.
 *
 *  `enrichThinHit` fetches a web identify and then holds it to an acceptance
 *  bar: same product, fuller name, a real brand. When the result fails that
 *  bar the function returns, which is correct — a worse name must not land on
 *  the row.
 *
 *  What was missing is that the row never heard about it. Somebody typed a
 *  research hint, pressed the button, watched the spinner, and got back exactly
 *  what they started with and no explanation (reported 2026-08-14: "I re-ran AI
 *  with the hint and nothing changed"). From the outside, "your hint was
 *  considered and rejected" and "your hint was silently dropped on the floor"
 *  look identical, and one of those is a bug — so the row has to be able to
 *  tell you which happened.
 *
 *  Only for work a PERSON asked for. The passive auto-enrich rejects results
 *  constantly and correctly, and narrating that on every scan would be noise
 *  nobody asked for. */

export type RejectedRequest = "hint" | "enrich";

export type RejectionReason =
  /** The result described a different product than the one on the row. */
  | "different-product"
  /** Same product, but the name was no better than the one already there. */
  | "no-better";

/** What to tell someone whose explicit re-run changed nothing, and why. */
export function rejectionNote(request: RejectedRequest, reason: RejectionReason): string {
  if (reason === "different-product") {
    return request === "hint"
      ? "Your hint pointed at a different product than this barcode resolves to, so the name was left alone. Fix the name directly, or re-scan if the barcode is wrong."
      : "The web search came back with a different product, so the name was left alone.";
  }
  return request === "hint"
    ? "Your hint was used, and the web search still had nothing better than the current name."
    : "The web search found nothing better than the current name.";
}
