/** Has anybody actually been issued this barcode's prefix?
 *
 *  A rotated or partially-read symbol can decode as a DIFFERENT code whose
 *  check digit is genuinely valid, so the checksum cannot reject it. Measured
 *  from a real scan (2026-08-05, reported 2026-08-14):
 *
 *    real     859337002726   12 digits, valid UPC-A
 *    misread  6876437002726  13 digits, valid EAN-13
 *
 *  The last EIGHT digits are identical and the prefixes differ entirely. The
 *  same physical label had already produced an 8-digit misread at ~45 degrees
 *  (see scanDedup) — one barcode, misreads in both directions.
 *
 *  That LONGER misread is why the existing defence missed it: the agreement
 *  gate demands a longer streak for SHORT codes, on the reasoning that a slice
 *  of a long code reads as a short one. It does, but it also reads as a longer
 *  one, and a 13-digit code was getting the lenient requirement.
 *
 *  What the phantom cannot fake is an ISSUED prefix. GS1 has allocated only
 *  part of the 3-digit space; `687` is in the part it has not. A code claiming
 *  an unissued prefix is not a product anybody has ever labelled.
 *
 *  DELIBERATELY NOT A REJECTION. GS1 allocates new prefixes over time, so this
 *  table rots, and a rotted hard-reject would silently refuse exactly the
 *  newest products while looking like a broken scanner. Treated instead as
 *  "needs more agreement", a prefix that becomes legitimate tomorrow still
 *  scans — about 100ms slower — while an unstable phantom still cannot repeat
 *  itself often enough to get in.
 *
 *  Measured against a real 93-barcode scanning history before shipping: zero
 *  flagged, including books (978), German (405) and UK (501) codes. It catches
 *  the reported misread. It is worth being clear that it is PARTIAL — 284 of
 *  1000 prefixes are unallocated, so it covers roughly 28% of the ways a
 *  misread can land, and is a second net rather than the answer.
 *
 *  Source: GS1 prefix allocations, https://en.wikipedia.org/wiki/List_of_GS1_country_codes
 */

/** Allocated 3-digit GS1 prefix ranges, inclusive. */
const ALLOCATED: ReadonlyArray<readonly [number, number]> = [
  [0, 139], // UPC-A compatible: US, drugs, restricted circulation, GS1 US reserved
  [200, 299], // restricted circulation within a geographic region
  [300, 379], [380, 380], [381, 381], [383, 383], [385, 385], [387, 387], [389, 389],
  [400, 440], [450, 459], [460, 469], [470, 471], [474, 489], [490, 499],
  [500, 509], [520, 521], [528, 531], [535, 535], [539, 549], [560, 560], [569, 569],
  [570, 579], [590, 590], [594, 594], [599, 601], [603, 609], [611, 613], [615, 632],
  [640, 649], [680, 681], [690, 699], [700, 709], [729, 729], [730, 739], [740, 746],
  [750, 750], [754, 755], [759, 759], [760, 769], [770, 771], [773, 773], [775, 775],
  [777, 777], [778, 780], [784, 784], [786, 786], [789, 790], [800, 839], [840, 849],
  [850, 850], [858, 860], [865, 865], [867, 867], [868, 869], [870, 879], [880, 881],
  [883, 885], [887, 888], [890, 890], [893, 894], [896, 896], [899, 899], [900, 919],
  [930, 939], [940, 949], [950, 952], [955, 955], [958, 958], [960, 969],
  [977, 980], [981, 983], [990, 999],
];

/** Is this 3-digit GS1 prefix one that has been issued to somebody? */
export function prefixAllocated(prefix: number): boolean {
  return ALLOCATED.some(([lo, hi]) => prefix >= lo && prefix <= hi);
}

/** Does this code claim a GS1 prefix nobody has been given?
 *
 *  Only 13-digit codes are judged. A 12-digit UPC-A is an EAN-13 with an
 *  implicit leading zero, which always lands in the US/Canada block, so asking
 *  the question of one would only ever produce a false alarm. */
export function hasUnallocatedPrefix(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return !prefixAllocated(Number(code.slice(0, 3)));
}
