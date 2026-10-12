// How many of a thing a scan is. One rule, read by every door.
//
// The count starts at one. A scan is of something in hand, and the inbox row
// is born at 1 (the column's default). Zero is a state a record reaches by
// being USED, through the actions that record why ("Used up", "Use one"), and
// its history says so; a record filed at zero has no such history and reads
// as a mistake. The quantity stepper knew this (min 1) and the filing door did
// not (nonnegative), and an explicit 0 won at confirm because `0 ?? fallback`
// is 0, so a record could be created at 0 through confirm while the editor a
// person used afterwards refused the same value (#3088). Two copies of one
// bound in one file is how they came to disagree; this is the one copy.
//
// The same rule was also a clamp in five places (a receipt line, the combine
// sum, an attach's bump, the autofile plan, an import row), each written from
// memory. They read from here now.
//
// A count a model read off a photo is a different assertion and has its own,
// narrower rule on purpose: seen-count.ts.
//
// ONE EXCEPTION (owner, 2026-10-12, #5959): a copy or move between a person's
// OWN workspaces is not an arrival. It is the same record, and its count is a
// fact the record already has, with its history in the source: it files as
// it is, 0 included, and is never held. Everything that arrives from outside
// (a scan, a delivery, a receipt, an import, a share from someone else) keeps
// the rule above, and an outside arrival that said 0 is held for its count.
// arrivalCount is that decision; isOwnCopy is how a row says which it is.
import { z } from "zod";
import { isOwnCopy } from "@cobblr/platform-contract/share-offer";

export { isOwnCopy };

export const FILED_QUANTITY_MIN = 1;
export const FILED_QUANTITY_MAX = 100_000;

/** The rule as a schema, for a value a caller SENT: refused when it does not
 *  fit, so the caller learns. */
export const FiledQuantity = z.number().int().min(FILED_QUANTITY_MIN).max(FILED_QUANTITY_MAX);

/** The rule as a clamp, for a value the server already HOLDS (a row's count,
 *  a receipt line, a plan): nothing to refuse, so the nearest count that obeys
 *  it. Missing, blank or unreadable is one. */
export function filedQuantityOf(value: unknown): number {
  if (value === null || value === undefined || value === "") return FILED_QUANTITY_MIN;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < FILED_QUANTITY_MIN) return FILED_QUANTITY_MIN;
  return Math.min(n, FILED_QUANTITY_MAX);
}


/** The count a row is born with, and whether it is held for one: an own copy
 *  keeps its count as it is, 0 included (the exception above); anything from
 *  outside obeys the rule, and one that said 0 is held. */
export function arrivalCount(quantity: number | null | undefined, opts: { own: boolean }): { quantity: number; held: boolean } {
  const n = typeof quantity === "number" && Number.isFinite(quantity) ? Math.round(quantity) : null;
  if (opts.own) return { quantity: n == null ? FILED_QUANTITY_MIN : Math.min(Math.max(n, 0), FILED_QUANTITY_MAX), held: false };
  return { quantity: filedQuantityOf(n ?? FILED_QUANTITY_MIN), held: n === 0 };
}

/** The count an own copy files at: the row's own, 0 included. */
export function copiedCountOf(quantity: number | null | undefined): number {
  return arrivalCount(quantity, { own: true }).quantity;
}
