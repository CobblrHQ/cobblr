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

import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";

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

/** Where a record keeps how it left, in its own metadata: the same key on
 *  every kind, so one banner, one action and one search read them all. The
 *  module's own flag (a part's archive, an asset's put-away, a machine's
 *  state) is what takes it out of the lists; this says the rest. */
export const DISPOSITION_KEY = "disposition";

export interface RecordDisposition {
  how: Disposition;
  /** The day it left, YYYY-MM-DD. */
  on: string | null;
  /** What it went for, in the workspace's currency. */
  price: number | null;
  /** Who has it now. */
  to: string | null;
  note: string | null;
  /** When it became the person's (its acquired-on field when it had one),
   *  YYYY-MM-DD, so the record can say how long it was kept. */
  held_since: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A disposition said any way a person or a model says it: the vocabulary's
 *  own key ("given-away"), its label ("given away"), or words that read as one
 *  ("gave it to my brother", "binned"). Null when it is none of them. */
export function dispositionOf(said: unknown): Disposition | null {
  if (typeof said !== "string") return null;
  const s = said.trim().toLowerCase();
  if (!s) return null;
  const key = s.replace(/\s+/g, "-");
  if ((DISPOSITIONS as readonly string[]).includes(key)) return key as Disposition;
  if (s === "disposed" || s === "disposed of" || s === "thrown away") return "scrapped";
  const read = readDisposition(said);
  return read && read !== "owned" ? read.disposition : null;
}

/** How a record left, read from its metadata; null while it is still yours. */
export function readRecordDisposition(metadata: unknown): RecordDisposition | null {
  if (!metadata || typeof metadata !== "object") return null;
  const d = (metadata as Record<string, unknown>)[DISPOSITION_KEY];
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  const how = dispositionOf(r.how);
  if (!how) return null;
  const price = typeof r.price === "number" && Number.isFinite(r.price) ? r.price : null;
  return { how, on: day(r.on), price, to: text(r.to), note: text(r.note), held_since: day(r.held_since) };
}

/** "3 years 2 months", "5 months", "12 days": how long between two days,
 *  in the two largest units that say it. Null when the order is wrong. */
export function heldFor(from: string, to: string): string | null {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return null;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  if (months >= 12) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m ? `${n(y, "year")} ${n(m, "month")}` : n(y, "year");
  }
  if (months >= 1) return n(months, "month");
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return n(days, "day");
}

const VERB: Record<Disposition, string> = {
  sold: "Sold",
  "given-away": "Given away",
  "parted-out": "Parted out",
  converted: "Converted",
  traded: "Traded",
  lost: "Lost",
  scrapped: "Disposed of",
};

/** The record's line about it: "Sold 2026-09-12 for $180 to Vince · kept 3
 *  years 2 months". `money` formats a price in the workspace's currency. */
export function sayDisposition(d: RecordDisposition, money: (n: number) => string = (n) => formatMoney(centsFromAmount(n))): string {
  const parts = [VERB[d.how]];
  if (d.on) parts.push(d.on);
  if (d.price !== null && (d.how === "sold" || d.how === "traded")) parts.push(`for ${money(d.price)}`);
  if (d.to) parts.push(`to ${d.to}`);
  let line = parts.join(" ");
  const kept = d.held_since && d.on ? heldFor(d.held_since, d.on) : null;
  if (kept) line += ` · kept ${kept}`;
  return line;
}
