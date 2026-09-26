// Two spellings of one identifier are one identifier. An ISBN-10 and the
// ISBN-13 printed as the barcode name the same book; a serial typed with
// dashes is the serial on the label. Comparison strips punctuation and case,
// and an ISBN compares on its 13-digit form. Pure.

const clean = (v: unknown): string =>
  String(v ?? "")
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase();

/** ISBN-10 to ISBN-13 (978 prefix, GTIN check digit). null when not an ISBN-10. */
export function isbn10to13(raw: string): string | null {
  const c = clean(raw);
  if (!/^\d{9}[\dX]$/.test(c)) return null;
  const body = `978${c.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + String((10 - (sum % 10)) % 10);
}

function gtinCheck(body: string): string {
  // GS1 mod-10: weights 3,1,3,... from the rightmost digit of the body.
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

function gtinValid(c: string): boolean {
  return /^\d{8,14}$/.test(c) && gtinCheck(c.slice(0, -1)) === c.slice(-1);
}

/** The item's own 13-digit code, for a product code in any of its spellings:
 *  a UPC-A (12) is the EAN-13 with a leading 0, and a GTIN-14 with packaging
 *  indicator 1 to 8 wraps the item's code (the case or pack of it) behind a
 *  new check digit. So 877503009799 on a skein and 10877503009796 on its
 *  bulk sticker are one product (#3729). Indicator 9 is a variable-measure
 *  item and stays itself. Null for anything that is not a valid GTIN. */
export function gtinItem(raw: string): string | null {
  const c = clean(raw);
  if (!gtinValid(c)) return null;
  if (c.length === 12) return `0${c}`;
  if (c.length === 13) return c;
  if (c.length === 14) {
    if (c[0] === "0") return c.slice(1);
    if (c[0] === "9") return null;
    const body = c.slice(1, 13);
    return body + gtinCheck(body);
  }
  return null;
}

/** The case codes that could wrap an item's own code: a GTIN-14 with
 *  packaging indicator 1, 2, 3 in front of the item's 13-digit code and a new
 *  check digit. A skein sold loose carries 877503009799 and a catalog may
 *  hold only its case, 10877503009796. Indicators 1 to 3 cover the packs
 *  seen in practice; each probe is a catalog lookup against a daily quota,
 *  so the rarer 4 to 8 are not asked. Empty for anything that is not a valid
 *  12 or 13 digit item code. */
export function gtinCases(raw: string): string[] {
  const c = clean(raw);
  if (!/^\d{12,13}$/.test(c) || !gtinValid(c)) return [];
  const item = c.length === 12 ? `0${c}` : c;
  return ["1", "2", "3"].map((ind) => {
    const body = ind + item.slice(0, 12);
    return body + gtinCheck(body);
  });
}

/** The canonical form used for equality. */
export function identifierCanonical(v: unknown): string {
  const c = clean(v);
  return isbn10to13(c) ?? gtinItem(c) ?? c;
}

export function identifierEquals(a: unknown, b: unknown): boolean {
  const ca = identifierCanonical(a);
  return ca !== "" && ca === identifierCanonical(b);
}

/** Every spelling worth PROBING a list filter with for a code: the code as
 *  scanned, its cleaned form, and for an ISBN-13 with a 978 prefix its ISBN-10,
 *  since the record may hold either. Distinct, non-empty. */
export function identifierForms(code: string): string[] {
  const out = new Set<string>();
  const raw = code.trim();
  if (raw) out.add(raw);
  const c = clean(raw);
  if (c) out.add(c);
  const as13 = isbn10to13(c);
  if (as13) out.add(as13);
  // A product code's item spellings: the EAN-13 and, when it leads with 0,
  // the UPC-A a record stamped from a 12-digit scan carries.
  const item = gtinItem(c);
  if (item) {
    out.add(item);
    if (item.startsWith("0")) out.add(item.slice(1));
  }
  if (/^978\d{10}$/.test(c)) {
    const body = c.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    out.add(body + (check === 10 ? "X" : String(check)));
  }
  return [...out];
}
