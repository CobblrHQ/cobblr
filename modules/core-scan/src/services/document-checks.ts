// The checks a read of a document must pass before anything believes it.
//
// A scanned dealer bill of sale read by the OCR engine came back as "C1yTe
// WATCU Ey oL 4" for a 2019 Civic Hatchback EX, the year as 2014 and the VIN
// unusable, and every one of those was believed: the card was named after the
// garbage, the existing car was not found, and the picture search came back
// with wristwatches (#4571). Every tier makes mistakes; the measured AI reads
// of the same page did too (a misread first VIN character, a fee read as
// 111.05 for 11.05, a deposit off by a hundred). What caught each of them was
// arithmetic the document carries itself:
//
//   - the VIN's check digit (position 9), which a wrong VIN fails ten times
//     in eleven, and which also says how to put an OCR look-alike right;
//   - the model year, which the VIN also states (position 10);
//   - the money: the priced lines add up to the taxable amount and to the
//     total, and the deposit is the total less the balance on delivery;
//   - the title, which has to look like words.
//
// Pure: a read and what the form printed in, a verdict out. The reader decides
// what to do with a failure (ask the document model, then say "please check").

import { checkDigitValid, isShapeValidVin, repairOcrVin, vinModelYear } from "./vin-decode.js";
import type { ParsedReceipt } from "./receipt-shared.js";
import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";

/** An amount as a person reads it in a sentence. */
const said = (amount: number) => formatMoney(centsFromAmount(amount));

/** The money a sale form prints besides its lines, for the arithmetic. */
export interface DocumentFigures {
  /** The taxable amount (the lines before tax). */
  taxable: number | null;
  total: number | null;
  /** Money put down. */
  deposit: number | null;
  /** What is owed on delivery. */
  balance: number | null;
}

export const NO_FIGURES: DocumentFigures = { taxable: null, total: null, deposit: null, balance: null };

/** One check that did not pass, and the fields it puts in doubt. */
export interface FailedCheck {
  check: "vin" | "year" | "lines" | "deposit" | "title" | "seller";
  /** Field names (the vehicle's decode names: vin, year, make, model; or the
   *  sale's: price, total, deposit) a person should look at. */
  fields: string[];
  why: string;
}

export interface DocumentVerdict {
  ok: boolean;
  failed: FailedCheck[];
  /** The VIN the check digit proves as read. */
  vin: string | null;
  /** A VIN one look-alike away from the read that passes the check digit:
   *  not proved, because a swap passes by chance one time in eleven. The
   *  caller confirms it (the vehicle database decodes it, and to the make the
   *  form prints) with `confirmVinCandidate`, or it stays unreadable. */
  vin_candidate: string | null;
  /** The model year the proved VIN states (position 10), offline. */
  vin_year: number | null;
}

const CENT = 0.011;
const near = (a: number, b: number) => Math.abs(a - b) < CENT;

/**
 * Does a name an OCR engine read off a document look like words? The garbage
 * this exists for mixes cases inside a token ("C1yTe", "oL") and puts a digit
 * between letters where the engine swaps look-alikes. A product's own spelling
 * (CIVIC HATCH EX L4, 32QT, iPhone) is never read off a dealer form by this
 * path, which is the only place it is asked; a model number keeps its shape
 * (letters and digits in runs, one case).
 */
export function looksLikeWords(name: string | null | undefined): boolean {
  const tokens = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let bad = 0;
  let tiny = 0;
  for (const t of tokens) {
    const w = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!w) continue;
    if (w.length <= 2 && !/^\d+$/.test(w) && !/^[A-Z]{2}$/.test(w)) tiny++;
    // A lowercase letter followed by a capital: "oL", "C1yTe".
    const caseFlip = /[a-z][A-Z]/.test(w);
    // A look-alike digit between lowercase letters: "C1y", "b0x".
    const digitInWord = /[a-z][0158][a-z]|[A-Z][0158][a-z]/.test(w);
    // Three or more letters, some lowercase, and no vowel.
    const noVowel = /[a-z]/.test(w) && /^[A-Za-z]{3,}$/.test(w) && !/[aeiouyAEIOUY]/.test(w);
    if (caseFlip || digitInWord || noVowel) bad++;
  }
  const n = tokens.length;
  if (bad >= 1 && bad / n >= 0.25) return false;
  if (n >= 3 && tiny / n > 0.5) return false;
  return true;
}

// VOCAB-ENUMERATION OK: a sale form's box captions, which are labels and never a value
const CAPTIONS = /\b(?:MODEL|BODY|COLOU?R|YEAR|MAKE|VIN|ODOMETER|MILEAGE|STOCK|NEW\/USED|SALESPERSON)\b/gi;

/** A name read off a form that is the form's own caption row read as the
 *  value ("MODEL Boor COLOR"): words, but not a name. */
/** A value that opens with a form's own printed caption, in the capitals a
 *  form prints it in: read across a box's edge. */
export function startsWithCaption(value: string): boolean {
  return /^(?:YEAR|MAKE|MODEL|VIN|BODY|COLOU?R|STOCK|ODOMETER|MILEAGE|TRIM)\b/.test(value.trim());
}

export function isCaptionRow(name: string): boolean {
  return (name.match(CAPTIONS) ?? []).length >= 2;
}

/** Does a seller's name read off a page look like one? A business name is
 *  printed, in capitals on a dealer's form; a scrap of the page's noise
 *  ("se aggecrg.") is lower case and short. */
export function looksLikeSellerName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  if (!n || !looksLikeWords(n)) return false;
  return /\b[A-Z][A-Za-z&'.-]{2,}/.test(n);
}

/** A read VIN as the arithmetic settles it. */
export function readVinOf(raw: string | null | undefined, year?: number | null): { vin: string; changed: number } | null {
  if (!raw) return null;
  if (isShapeValidVin(raw) && checkDigitValid(raw)) return { vin: raw.toUpperCase(), changed: 0 };
  const fixed = repairOcrVin(raw, { year: year ?? null });
  return fixed ? { vin: fixed.vin, changed: fixed.changed } : null;
}

/** Is some run of the lines, from the first, worth exactly `want`? The lines
 *  before tax come first on a sale form; the ones after are the tax and the
 *  fees charged on top. */
function prefixSums(amounts: number[], want: number): boolean {
  let s = 0;
  for (const a of amounts) {
    s += a;
    if (near(s, want)) return true;
  }
  return false;
}

/**
 * Check a bill of sale read off a page. `rawVin` is the VIN as the page read
 * (before any repair), `figures` the money the form printed beside its lines.
 */
export function checkBillOfSale(receipt: ParsedReceipt, rawVin: string | null, figures: DocumentFigures, now: Date = new Date()): DocumentVerdict {
  const failed: FailedCheck[] = [];
  const unit = receipt.items[0];
  const facts = (unit as { facts?: Record<string, unknown> } | undefined)?.facts ?? {};
  const decoded = (unit as { decoded?: { fields?: Record<string, unknown> } } | undefined)?.decoded?.fields ?? {};
  const formYear = typeof facts["year-made"] === "number" ? (facts["year-made"] as number) : typeof decoded.year === "number" ? (decoded.year as number) : null;

  // The VIN proves itself or is unreadable; never used as read.
  const read = readVinOf(rawVin, formYear);
  const proved = read && read.changed === 0 ? read : null;
  const candidate = read && read.changed > 0 ? read.vin : null;
  const vinYear = proved ? vinModelYear(proved.vin, now) : null;
  const isVehicle = !!rawVin || !!decoded.make || !!decoded.model || formYear !== null;
  if (rawVin && !proved) {
    failed.push({
      check: "vin",
      fields: ["vin"],
      why: candidate ? `The VIN did not pass its check digit as read; ${candidate} would, and is not yet confirmed.` : "The VIN did not pass its check digit.",
    });
  }
  else if (!rawVin && isVehicle && (decoded.make || decoded.model)) failed.push({ check: "vin", fields: ["vin"], why: "No VIN could be read." });

  // The year: the VIN's when there is one; otherwise it must be a sane year.
  const maxYear = now.getUTCFullYear() + 1;
  if (!vinYear && formYear !== null && (formYear < 1950 || formYear > maxYear)) {
    failed.push({ check: "year", fields: ["year"], why: `The year ${formYear} is not a model year.` });
  }

  // The money. Lines in the order printed: the unit first.
  const amounts = receipt.items.map((l) => l.line_total ?? 0).filter((a) => a !== 0);
  const total = figures.total ?? receipt.total;
  const sum = amounts.reduce((s, a) => s + a, 0);
  if (amounts.length > 1 && total !== null) {
    const totalOk = near(sum, total);
    const taxableOk = figures.taxable === null || prefixSums(amounts, figures.taxable);
    if (!totalOk || !taxableOk) {
      failed.push({
        check: "lines",
        fields: ["price", "total"],
        why: !totalOk
          ? `The lines add up to ${said(sum)}, and the form says ${said(total)}.`
          : `No run of the lines adds up to the taxable amount, ${said(figures.taxable!)}.`,
      });
    }
  }
  if (figures.deposit !== null && figures.balance !== null && total !== null && !near(total - figures.balance, figures.deposit)) {
    failed.push({
      check: "deposit",
      fields: ["deposit"],
      why: `The deposit should be the total less the balance on delivery, ${said(total - figures.balance)}, and it reads ${said(figures.deposit)}.`,
    });
  }

  // The title: only an OCR'd one is asked, and a proved VIN names the
  // vehicle itself, so a garbled name it replaces is no failure.
  if (!proved && unit && (!looksLikeWords(unit.description) || isCaptionRow(unit.description) || startsWithCaption(unit.description))) {
    failed.push({ check: "title", fields: ["name"], why: "The name read off the page is not words." });
  }
  // A make or model that opens with another box's printed caption ("MODEL
  // CTVIC HATCH" read as the make) was read across the boxes, not out of one
  // (#4633). A proved VIN names the vehicle, so its make is not asked.
  if (!proved && unit) {
    const leaked = [["make", unit.manufacturer], ["model", unit.model]].filter(([, v]) => typeof v === "string" && (startsWithCaption(v) || !looksLikeWords(v)));
    if (leaked.length) failed.push({ check: "title", fields: leaked.map(([k]) => k as string), why: "The make or model read off the page ran into the form's captions." });
  }
  const seller = receipt.vendor ?? receipt.seller;
  if (seller && !looksLikeSellerName(seller)) {
    failed.push({ check: "seller", fields: ["seller"], why: "The seller's name read off the page is not words." });
  }

  return { ok: failed.length === 0, failed, vin: proved?.vin ?? null, vin_candidate: candidate, vin_year: vinYear };
}

/**
 * A swapped VIN candidate made good: the vehicle database decoded it clean,
 * and to the make the form prints (when it prints one). The verdict then
 * holds the VIN and its year, and the VIN failure (and a title failure the
 * VIN's name replaces) are withdrawn.
 */
export function confirmVinCandidate(
  verdict: DocumentVerdict,
  decode: { clean: boolean; make: string | null },
  formMake: string | null,
  now: Date = new Date(),
): DocumentVerdict {
  const vin = verdict.vin_candidate;
  if (!vin || !decode.clean) return verdict;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  if (formMake && decode.make && !norm(decode.make).startsWith(norm(formMake).slice(0, 4)) && !norm(formMake).startsWith(norm(decode.make).slice(0, 4))) return verdict;
  const failed = verdict.failed.filter((f) => f.check !== "vin" && f.check !== "title");
  return { ok: failed.length === 0, failed, vin, vin_candidate: null, vin_year: vinModelYear(vin, now) };
}

/** The fields a person should look at, once, in the order they were found. */
export function fieldsToCheck(verdict: DocumentVerdict): string[] {
  return [...new Set(verdict.failed.flatMap((f) => f.fields))];
}
