// What a search has to find, on every door: the search page, a module's own
// list, Cobb and a page's find box. One corpus, asserted against each, so a
// door that reads differently fails the same test the others pass (#7929).
//
// Each door used to grow its own reading of a query. The inventory list read
// five columns and missed a barcode Search found (#7818); Cobb dropped every
// non-Latin letter and the hyphen in a serial before it searched (#7817); the
// find box read words and missed 0.1uF on a part typed 100n (#7893). Every
// door now asks textSearchWhere (or, in a page, valuesAnswer), and this is the
// list of answers they must agree on.

/** A record the corpus seeds, as an inventory part. */
export interface CorpusRecord {
  name: string;
  serial_number?: string;
  metadata?: Record<string, string>;
}

export const SEARCH_CORPUS_RECORDS: readonly CorpusRecord[] = [
  { name: "Precision caliper stainless", metadata: { barcode: "0705105553339" } },
  { name: "AUDIT-CAP-12", metadata: { value: "100n", package: "0603" } },
  { name: "HC49 crystal", metadata: { value: "10kHz" } },
  { name: "日本語 ドライバー" },
  { name: "مفك براغي" },
  { name: "Ключ гаечный" },
  { name: "Torque wrench", serial_number: "SER7724-00025" },
  { name: "M3 x 10 bolts" },
  { name: "M3 x 16 bolts" },
];

/** A query, and the names of the records it finds (none, for a miss). */
export interface CorpusQuery {
  q: string;
  finds: readonly string[];
}

export const SEARCH_CORPUS_QUERIES: readonly CorpusQuery[] = [
  { q: "0705105553339", finds: ["Precision caliper stainless"] },
  { q: "caliper", finds: ["Precision caliper stainless"] },
  { q: "0.1uF", finds: ["AUDIT-CAP-12"] },
  { q: "100 nF", finds: ["AUDIT-CAP-12"] },
  { q: "100000pF", finds: ["AUDIT-CAP-12"] },
  { q: "1uF", finds: [] },
  { q: "10kHz", finds: ["HC49 crystal"] },
  { q: "日本語", finds: ["日本語 ドライバー"] },
  { q: "مفك", finds: ["مفك براغي"] },
  { q: "Ключ", finds: ["Ключ гаечный"] },
  { q: "SER7724-00025", finds: ["Torque wrench"] },
  // Every word, in any order, not the words as one phrase: "M3 bolts" found
  // nothing in a workspace of "M3 x 10 bolts" (#8866).
  { q: "M3 bolts", finds: ["M3 x 10 bolts", "M3 x 16 bolts"] },
  { q: "bolts 16", finds: ["M3 x 16 bolts"] },
  { q: "zzqxvnomatch", finds: [] },
];

/** The doors the corpus is asserted on. */
export type SearchDoor = "search" | "list" | "cobb" | "find-box";

/** A door that still answers a query differently, with the issue that fixes
 *  it. The test asserts it STILL differs, so the fix fails it until its line
 *  is taken out: the list only shrinks. Keyed `<door> <q>`. */
export const SEARCH_CORPUS_GAPS: Readonly<Record<string, string>> = {
};

/** The issue a door's gap on this query waits for, if any. */
export function corpusGap(door: SearchDoor, q: string): string | undefined {
  return SEARCH_CORPUS_GAPS[`${door} ${q}`];
}
