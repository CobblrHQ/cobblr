// Which of the three re-buy answers leads, pure so it is a test.
//
// "Replaced the one that ran out" is the everyday re-buy and leads by
// default. The record and the ledger can overrule it: stock already past its
// expiry date, or a ledger that has worked out the shelf went off, makes
// "Old one went bad" the honest first choice, and a shelf with nothing on it
// leaves only "+N to it" (there is nothing to have replaced).

export type RepurchaseAnswer = "replaced" | "add" | "went_bad";

export function leadAnswer(
  match: { qty: number | null; expired?: boolean },
  repurchaseMeans: string | null | undefined,
): RepurchaseAnswer | null {
  if (match.qty == null) return null;
  if (match.qty <= 0) return "add";
  if (match.expired || repurchaseMeans === "discard") return "went_bad";
  return "replaced";
}
