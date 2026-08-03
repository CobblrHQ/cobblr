// The barcode is a FACT the user can correct.
//
// Two real failures made this module exist (the author, 2026-08-03):
//
//   1. A label whose code the camera couldn't read was photographed instead, and
//      the vision OCR got one digit wrong. There was no way to edit the barcode:
//      the row's `barcode_text` was display-only, and every re-run re-resolved
//      the same misread code.
//   2. The user then did the reasonable thing - typed a hint "correct barcode
//      X" - and the hint rode into the prompts as advisory prose while the
//      actual `barcode_text` stayed wrong. The one field the correction was
//      about was the one field the correction could not reach.
//
// So: a correction can arrive EXPLICITLY (the barcode editor / the `barcode`
// field on rerun) or INSIDE A HINT, and both land on `barcode_text` itself,
// after which the normal barcode resolution re-runs. Extraction from prose is
// deliberately conservative - rewriting the identity off a misparse would be
// worse than ignoring the hint - so a digit run in a hint only counts as a
// barcode when the hint says it is one, or when the GS1 check digit proves it.

/** Digits only, tolerating the spaces/dashes people type from a label.
 *  Null unless the result is a real barcode length (EAN-8/UPC-A/EAN-13/ITF-14). */
export function normalizeBarcode(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || !/^[\d\s-]+$/.test(s)) return null;
  const digits = s.replace(/[\s-]/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

/** The GS1 mod-10 check digit (last digit) validates for EAN-8 / UPC-A /
 *  EAN-13 / ITF-14 alike: weight 3 on alternating positions from the right. */
export function gs1CheckDigitValid(code: string): boolean {
  if (!/^\d{8,14}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    // From the RIGHT of the payload, odd positions (1st, 3rd, …) weigh 3.
    const fromRight = digits.length - i;
    sum += digits[i]! * (fromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** Words that mark a digit run in a hint as being ABOUT the barcode. */
const BARCODE_WORDS = /\b(barcode|bar code|upc|ean|gtin|code)\b/i;

/**
 * The corrected barcode a hint carries, or null.
 *
 * A hint is prose, and prose is full of digit runs that are not barcodes -
 * "expires 20261231" is eight digits, a model number can be twelve. The rule:
 *
 *   - the hint names the code ("correct barcode 5060218983330", "upc is …")
 *     → any real barcode length counts, or
 *   - the run is 12-14 digits AND its GS1 check digit validates - long enough
 *     that prose collisions are rare, and the checksum kills 90% of those.
 *
 * A run equal to the item's current barcode is not a correction.
 */
export function barcodeFromHint(
  hint: string | null | undefined,
  currentBarcode: string | null | undefined,
): string | null {
  const s = (hint ?? "").trim();
  if (!s) return null;
  const named = BARCODE_WORDS.test(s);
  // Digit runs, allowing internal spaces/dashes ("5060 2189 8333 0" off a label).
  const runs = s.match(/\d[\d\s-]*\d/g) ?? [];
  for (const run of runs) {
    const code = normalizeBarcode(run);
    if (!code || code === (currentBarcode ?? "")) continue;
    if (named) return code;
    if (code.length >= 12 && gs1CheckDigitValid(code)) return code;
  }
  return null;
}
