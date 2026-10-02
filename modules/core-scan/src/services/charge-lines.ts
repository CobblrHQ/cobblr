// VOCAB-ENUMERATION OK: this is the EXTRACTOR that tells a charge from a
// thing on a receipt line, and naming the words a charge is printed with is
// its whole job. Everything downstream reads the classification, never these
// words.
//
// A receipt's lines are not all things. A dealer's bill of sale for one car
// listed eight: the car, and a registration fee, sales tax, a tire fee, a
// documentary fee, a processing fee, window etching and wheel locks. Each
// became an inbox item and went looking for its photo, and found dealer ads
// and the dealership building (#4523). A fee, a tax, a title, a delivery
// charge, a service or a policy is money paid, not something you own: it is
// a line on the purchase and never an inbox item, the same family as a
// coupon belonging to the line it discounts. Heuristic first: the words are
// few and printed plainly; a line that names none of them is a thing.

/** What a receipt line is: a thing you now have, or money paid for something
 *  that is not a thing. */
export type LineKind = "item" | "charge";

// Each word is anchored so a product that happens to contain it stays a
// product: Q-tips are not a tip, a heavy-duty cord is not a duty, shipping
// boxes and etching cream are things, an inspection mirror is a tool.
const CHARGE = new RegExp(
  [
    // Fees, taxes, levies and charges, however they are prefixed.
    String.raw`\bfees?\b`,
    String.raw`\btax(?:es)?\b`,
    String.raw`\b(?:vat|gst|hst|pst|qst)\b`,
    String.raw`\bsurcharge\b`,
    String.raw`\blevy\b`,
    String.raw`\b(?:import|customs|excise)\s+duty\b`,
    String.raw`\bcharges?\b`,
    // Government paperwork.
    String.raw`\btitle\s*(?:\/|&|and)\s*registration\b`,
    String.raw`\bregistration\s*(?:\/|&|and)?\s*title\b`,
    String.raw`\bregistration\b(?!\s+(?:card|holder))`,
    String.raw`\btitle\s+(?:transfer|application)\b`,
    String.raw`\blicen[cs]e\s+(?:plate|renewal)\b`,
    String.raw`\bplates?\s+transfer\b`,
    // Paperwork and handling.
    String.raw`\bdoc(?:umentary|umentation)?\s+(?:prep|preparation)\b`,
    String.raw`\bdocumentary\b`,
    String.raw`\bprocessing\b(?!\s+(?:kit|tool|unit))`,
    String.raw`\bhandling\b`,
    // Getting it to you.
    String.raw`\bshipping\b(?!\s+(?:box(?:es)?|tape|labels?|envelopes?|bags?|supplies|scale))`,
    String.raw`\bfreight\b`,
    String.raw`^\s*delivery\b(?!\s+(?:bag|box))`,
    // Services and policies: agreements, not objects.
    String.raw`\binsurance\b`,
    String.raw`\b(?:extended\s+)?warranty\b(?!\s+card)`,
    String.raw`\bservice\s+(?:contract|plan|agreement)\b`,
    String.raw`\bprotection\s+(?:plan|package)\b`,
    String.raw`\b(?:window|vin|theft)\s+etch(?:ing)?\b`,
    String.raw`\bgap\s+(?:coverage|insurance|waiver)\b`,
    // Money about money.
    String.raw`\bfinance\s+charge\b`,
    String.raw`\binterest\s+(?:charge|paid)\b`,
    String.raw`^\s*tips?\s*$`,
    String.raw`\bgratuity\b`,
    String.raw`\b(?:bottle|crv|can|container)\s+deposit\b`,
    String.raw`\bdeposit\s+(?:fee|refund)\b`,
    String.raw`\brecycling\s+(?:fee|charge)\b`,
  ].join("|"),
  "i",
);

/** Is this line a charge (money for something that is not a thing)? */
export function lineKind(description: string): LineKind {
  return CHARGE.test(description) ? "charge" : "item";
}

/** The line that names the thing a sale is FOR on a unit document (a dealer's
 *  "Price of Unit", "Cash Price", "Vehicle Price"). */
export const UNIT_LINE = /\b(?:price\s+of\s+(?:the\s+)?(?:unit|vehicle|car|boat|trailer|motorcycle)|unit\s+price|vehicle\s+price|cash\s+price|selling\s+price|sales?\s+price|purchase\s+price|base\s+price|agreed\s+(?:upon\s+)?price)\b/i;

/** A line that is a sum or a payment, never something bought: the total,
 *  what is still owed, money put down, a trade. */
export const NOT_A_LINE = /\b(?:sub\s*-?total|total|balance|amount\s+(?:due|financed|paid)|cash\s+down|down\s+payment|deposit\s+paid|trade[\s-]*in|payoff|unpaid|rebate|net\s+(?:price|amount))\b/i;
