// What became of a thing that is no longer yours: sold, given away, parted
// out, turned into something else. One vocabulary for every door that learns
// it (an imported sheet's "Fate" column today, a hand edit or the assistant
// tomorrow), and one reading of the words people write for it, so "Sold for
// $100" means the same wherever it arrives.
//
// A record that has one of these is RETIRED in the sense of
// `ResolvedEntity.retired`: it still exists, its history is worth keeping,
// and it must not generate work. How a kind records that is the owning
// module's business (a machine's lifecycle state, an inventory part's archive
// flag), reached through `EntityWriter.retire`.

// VOCAB-ENUMERATION OK: the disposition vocabulary's own declaration
export const DISPOSITIONS = ["sold", "given-away", "parted-out", "converted", "traded", "lost", "scrapped"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** How each reads to a person, lower case, as it would sit in a sentence or a
 *  lifecycle list ("sold", "parted out"). */
export const DISPOSITION_LABELS: Record<Disposition, string> = {
  sold: "sold",
  "given-away": "given away",
  "parted-out": "parted out",
  converted: "converted",
  traded: "traded",
  lost: "lost",
  scrapped: "scrapped",
};

// Read from the START of what was written: "Given to Son/Now Sold" was given
// away first, and what happened after is the note's to tell.
const READINGS: Array<[Disposition, RegExp]> = [
  ["sold", /^(sold|resold|flipped)\b/i],
  ["given-away", /^(given|gave|gifted|donated|passed on|handed down)\b/i],
  ["parted-out", /^(parted|stripped|scavenged|cannibali[sz]ed|harvested|used for parts|for parts)\b/i],
  ["converted", /^(turned into|converted|became|rebuilt (as|into)|upgraded (to|into)|made into)\b/i],
  ["traded", /^(traded|swapped|exchanged)\b/i],
  ["lost", /^(lost|stolen|missing)\b/i],
  ["scrapped", /^(scrapped|thrown out|threw out|trashed|binned|recycled|junked|dead|broken beyond)\b/i],
];

/** Words that say a thing is still here, the same as leaving the cell blank. */
const STILL_OWNED = /^(still (own(ed)?|have|here)|own(ed)?|have|kept|keep|in use|active|current|mine)$/i;

export interface ReadDisposition {
  disposition: Disposition;
  /** A price written with it ("Sold for $100"), when there is one. */
  price: number | null;
  /** The words as written, always kept: they say to whom and why. */
  text: string;
}

/** What a written fate says: a disposition, `"owned"` for blank or "still
 *  have", or null for words that are neither (a note, a location, a status
 *  this vocabulary does not know). */
export function readDisposition(written: string | null | undefined): ReadDisposition | "owned" | null {
  const text = (written ?? "").trim();
  if (!text || STILL_OWNED.test(text)) return "owned";
  for (const [disposition, re] of READINGS) {
    if (!re.test(text)) continue;
    const m = /(?:[$€£¥₹]\s*)(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd|eur|gbp|bucks)\b/i.exec(text);
    const raw = m?.[1] ?? m?.[2];
    const price = raw ? Number(raw.replace(/,/g, "")) : null;
    return { disposition, price: price !== null && Number.isFinite(price) ? price : null, text };
  }
  return null;
}
