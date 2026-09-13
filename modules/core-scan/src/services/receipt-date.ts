// Which way round a numeric receipt date reads, decided by the platform.
//
// A till prints "09/05/26" and means one of two days. The model asked to
// read the receipt guessed day-first and the session stored 2026-05-09,
// four months before the shopping happened, where the pack expected
// September 5 (#2917). A numeric date is ambiguous and the model's habit
// is not evidence. Three tiers, in order, and the one that decided is
// recorded on the session so a wrong reading is a fact a person can see:
//
//   1. the receipt's own evidence: a currency that implies a convention
//      (€ or £, or comma decimals in the prices, read day-first; a $ says
//      nothing, since Australia, New Zealand, Mexico, Singapore and half of
//      Canada print $ and read day-first, and a tier that outranks the
//      workspace's own history must not guess);
//   2. the workspace's convention: what its earlier receipts established
//      when their dates were unambiguous or decided by evidence (no locale
//      setting exists; the workspace's receipts ARE its locale);
//   3. nearest past: a receipt is recent, so of the two readings the one
//      nearest to today and not in the future wins (8 days ago beats 4
//      months ago); a tie keeps month-first, the convention this parser
//      has always assumed.
//
// An unambiguous printed date (ISO, a month by name, or a number over 12
// on one side) needs none of this and says so. The raw printed string is
// what the tiers work from, and every tier has the receipt's text: a PDF's,
// a plain file's, the OCR engine's for an image (also under the vision
// read). Only a vision read on a machine with no engine has nothing but the
// model's guess, and that is recorded as the model's.

import { isoDate } from "./receipt-shared.js";

export type DateConvention = "mdy" | "dmy";
export type DateDecidedBy = "unambiguous" | "receipt" | "workspace" | "nearest-past" | "model";

export interface ReceiptDateReading {
  /** ISO YYYY-MM-DD, or null when nothing readable was found. */
  date: string | null;
  /** How the numeric date was read; null when it was not numeric-ambiguous
   *  (an ISO or month-named date), or when only the model's guess stood. */
  convention: DateConvention | null;
  decided_by: DateDecidedBy | null;
  /** The date as printed, when the text or the model gave it. */
  printed: string | null;
}

/** What the receipt's own text says about its convention, or null.
 *
 *  Only evidence that settles it counts. A dollar sign does not: it is
 *  printed on both sides of the convention (the US month-first; Australia,
 *  New Zealand, Mexico, Singapore and half of Canada day-first), and this
 *  tier outranks the workspace's own history, so a guess here would beat
 *  two unambiguous day-first receipts a workspace had already read
 *  (review of #2940). */
export function dateConventionEvidence(text: string | null | undefined): { convention: DateConvention; why: string } | null {
  if (!text) return null;
  if (/[€£]/.test(text)) return { convention: "dmy", why: "a euro or pound amount" };
  // Prices with a comma for the decimal point ("1,25", "12,99") and none
  // with a period: the till is European.
  const commaDecimals = (text.match(/\b\d{1,4},\d{2}\b/g) ?? []).length;
  const periodDecimals = (text.match(/\b\d{1,4}\.\d{2}\b/g) ?? []).length;
  if (commaDecimals >= 2 && periodDecimals === 0) return { convention: "dmy", why: "comma decimals in the prices" };
  return null;
}

/** The first date-shaped string printed in the text: ISO, a month by
 *  name, or the numeric forms a till prints. OCR turns a leading 0 into @,
 *  O or Q often enough ("@9/02/26" for 09/02/26) that the leading field
 *  admits those and reads them as 0. */
export function printedDateIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m =
    text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ??
    text.match(/\b(\d{1,2}[\s.]+[A-Za-z]{3,}\.?,?[\s.]+\d{4})\b/) ??
    text.match(/\b([A-Za-z]{3,}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/) ??
    text.match(/(?:^|[^\w])([\d@OQo]?\d[\/.-]\d{1,2}[\/.-]\d{2,4})\b/);
  return m ? m[1]!.replace(/^[@OQo]/, "0") : null;
}

const NUMERIC = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/;

function daysBetween(iso: string, today: Date): number {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y!, m! - 1, d!);
  const n = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return (t - n) / 86_400_000;
}

/**
 * Read a receipt's date. `printed` is the string as it appears on the
 * receipt (from the model or from the text); `text` is the receipt's own
 * text for evidence; `iso` is the model's guess, used only when nothing
 * printed can be found; `workspace` is the convention the workspace's
 * earlier receipts established.
 */
export function readReceiptDate(input: {
  printed?: string | null;
  text?: string | null;
  iso?: string | null;
  workspace?: DateConvention | null;
  today?: Date;
}): ReceiptDateReading {
  const printed = (input.printed ?? "").trim() || printedDateIn(input.text);
  const today = input.today ?? new Date();
  if (!printed) {
    const date = isoDate(input.iso);
    return { date, convention: null, decided_by: date ? "model" : null, printed: null };
  }
  const num = printed.match(NUMERIC);
  if (!num) {
    // ISO or a month by name: nothing to decide.
    return { date: isoDate(printed), convention: null, decided_by: "unambiguous", printed };
  }
  const a = +num[1]!;
  const b = +num[2]!;
  const y = num[3]!.length === 2 ? 2000 + +num[3]! : +num[3]!;
  const mdy = isoDate(`${y}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`);
  const dmy = isoDate(`${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`);
  const pick = (c: DateConvention, decided_by: DateDecidedBy): ReceiptDateReading => ({ date: c === "mdy" ? mdy : dmy, convention: c, decided_by, printed });
  // One side over 12: only one reading is a date at all.
  if (mdy && !dmy) return pick("mdy", "unambiguous");
  if (dmy && !mdy) return pick("dmy", "unambiguous");
  if (!mdy && !dmy) return { date: null, convention: null, decided_by: null, printed };
  // Both readings are days. The same day either way (05/05) needs no verdict.
  if (mdy === dmy) return pick("mdy", "unambiguous");
  const ev = dateConventionEvidence(input.text);
  if (ev) return pick(ev.convention, "receipt");
  if (input.workspace) return pick(input.workspace, "workspace");
  // Nearest past. A reading after today is not a purchase date; a day of
  // tolerance covers a till clock and a time zone.
  const dM = daysBetween(mdy!, today);
  const dD = daysBetween(dmy!, today);
  const okM = dM <= 1;
  const okD = dD <= 1;
  if (okM && !okD) return pick("mdy", "nearest-past");
  if (okD && !okM) return pick("dmy", "nearest-past");
  if (okM && okD) return pick(Math.abs(dD) < Math.abs(dM) ? "dmy" : "mdy", "nearest-past");
  // Both in the future (a clock set wrong, a stale year): the nearer one.
  return pick(dD < dM ? "dmy" : "mdy", "nearest-past");
}

/** The convention a workspace's earlier receipts established: the majority
 *  among those decided by the receipt itself. Null with nothing to go on. */
export function workspaceConventionFrom(rows: Array<{ date_convention: string | null; date_decided_by: string | null }>): DateConvention | null {
  let mdy = 0;
  let dmy = 0;
  for (const r of rows) {
    if (r.date_decided_by !== "unambiguous" && r.date_decided_by !== "receipt") continue;
    if (r.date_convention === "mdy") mdy++;
    else if (r.date_convention === "dmy") dmy++;
  }
  if (mdy === dmy) return null;
  return mdy > dmy ? "mdy" : "dmy";
}
