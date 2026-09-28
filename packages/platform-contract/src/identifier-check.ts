// Check digits for the product and book codes people keep in lists. One copy,
// read by the scanner (is this reading a real code?) and by the spreadsheet
// reader (is this column a column of codes?), so the two cannot disagree about
// what a valid barcode is.

/** GS1 mod-10 check over a UPC-A / EAN-13 / GTIN-14 (or EAN-8) digit string. */
export function gtinChecksumOk(digits: string): boolean {
  const check = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** ISBN-10 mod-11 check (final char may be X = 10). */
export function isbn10ChecksumOk(code: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(code[i]);
  const last = code[9] === "X" ? 10 : Number(code[9]);
  return (sum + last) % 11 === 0;
}

/** What a cell holding a code IS, with its check digit verified, or null.
 *  Hyphens and spaces are allowed (ISBNs are usually printed with them). */
export function productCodeKind(raw: string): "isbn" | "gtin" | null {
  const c = raw.trim().toUpperCase().replace(/[-\s]/g, "");
  if (/^97[89]\d{10}$/.test(c) && gtinChecksumOk(c)) return "isbn";
  if (/^\d{9}[\dX]$/.test(c) && isbn10ChecksumOk(c)) return "isbn";
  if (/^\d{12,14}$/.test(c) && gtinChecksumOk(c)) return "gtin";
  if (/^\d{8}$/.test(c) && gtinChecksumOk(c)) return "gtin";
  return null;
}
