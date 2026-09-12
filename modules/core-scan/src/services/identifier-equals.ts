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

/** The canonical form used for equality. */
export function identifierCanonical(v: unknown): string {
  const c = clean(v);
  return isbn10to13(c) ?? c;
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
  if (/^978\d{10}$/.test(c)) {
    const body = c.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    out.add(body + (check === 10 ? "X" : String(check)));
  }
  return [...out];
}
