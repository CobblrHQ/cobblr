// A thing lent out: who has it, why, since when and until when (#6335).
//
// A loan is an OVERLAY on the record, never an edit of its fields: the
// owner's Dremel went to Sam Lee for a repair, and recording that by
// clearing its location, overwriting its state and writing into its notes
// lost the place it returns to and the state it was in. The record keeps its
// home and its state; the loan sits beside them under one key in its
// metadata, on every kind, so one line, one action and one filter read them
// all. History keeps each loan (record_lent, record_returned).

import { dayLabel } from "@cobblr/platform-contract/day";

export const LOAN_KEY = "loan";

export interface RecordLoan {
  /** Who has it, as the person said it ("Sam Lee"). */
  holder: string;
  /** The People record that names them, when there is one. */
  holder_id: string | null;
  /** Why: "repair", "borrowed", or the person's own words. */
  reason: string | null;
  /** The day it went, YYYY-MM-DD. */
  since: string;
  /** The day it is due back, YYYY-MM-DD, when there is one. */
  due_back: string | null;
  note: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The record's open loan, read from its metadata; null while it is home. */
export function readRecordLoan(metadata: unknown): RecordLoan | null {
  if (!metadata || typeof metadata !== "object") return null;
  const l = (metadata as Record<string, unknown>)[LOAN_KEY];
  if (!l || typeof l !== "object") return null;
  const r = l as Record<string, unknown>;
  const holder = text(r.holder);
  const since = day(r.since);
  if (!holder || !since) return null;
  return { holder, holder_id: text(r.holder_id), reason: text(r.reason), since, due_back: day(r.due_back), note: text(r.note) };
}

/** The loan on a looked-up record's fields: its metadata, or the fields
 *  themselves where a kind flattens its metadata into them. */
export function loanOfFields(fields: unknown): RecordLoan | null {
  if (!fields || typeof fields !== "object") return null;
  return readRecordLoan((fields as { metadata?: unknown }).metadata) ?? readRecordLoan(fields);
}

const said = (d: string) => dayLabel(d);

/** The record's line about it: "With Sam Lee · repair · since Oct 13,
 *  2026 (due Oct 27, 2026)". */
export function sayLoan(l: RecordLoan): string {
  const parts = [`With ${l.holder}`];
  if (l.reason) parts.push(l.reason);
  parts.push(`since ${said(l.since)}${l.due_back ? ` (due ${said(l.due_back)})` : ""}`);
  return parts.join(" · ");
}

/** Past its due day, by the person's own day (YYYY-MM-DD). */
export function loanOverdue(l: RecordLoan, today: string): boolean {
  return !!l.due_back && today.slice(0, 10) > l.due_back;
}

/** What a control a loan turns off says about why. */
export function lentWhy(l: RecordLoan): string {
  return `Lent to ${l.holder}.`;
}

/** What a loan turns off on the thing while it is out: moving it, labelling
 *  it, and the Back where it was that only makes sense once it is home. The
 *  kernel refuses each with lentWhy, and the record page shows it greyed with
 *  the same words. A printer lent out is also skipped by the print farm
 *  (digifab), which picks printers rather than running an action on one. */
export const OFF_WHILE_LENT: ReadonlySet<string> = new Set([
  "core-placement:place",
  "core-placement:return-home",
  "core-placement:remove",
  "inventory:transfer-stock",
  "inventory:move-all-stock",
  "labels:print",
]);

/** The same loan restriction for record actions, native fields and direct HTTP. */
export function loanActionRefusal(actionId: string, fields: unknown): string | null {
  if (!OFF_WHILE_LENT.has(actionId)) return null;
  const loan = loanOfFields(fields);
  return loan ? lentWhy(loan) : null;
}
