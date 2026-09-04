// Two rows for one thing, made one.
//
// "Roma Tomatoes" and "Tomatoes Roma", scanned days apart, same two words.
// Filing learned not to create the second one; this is for the pairs already
// sitting in somebody's table, which no amount of prevention removes.
//
// A merge is the most destructive thing this module does, so the rules are here
// as a pure function: what the survivor ENDS UP with is decided without a
// database in the room, and every rule below is a test.
//
// THE RULES, and each one is a decision:
//
//   quantities ADD. Two rows of one apple each are two apples. This is the
//     whole reason a merge is not "delete the other one".
//
//   a blank on the survivor is FILLED from the duplicate; a value is never
//     overwritten. The survivor is the record somebody chose to keep, and a
//     merge that silently replaced its notes with the other one's would be a
//     data loss disguised as a tidy-up. Same rule as attach's merge-fields.
//
//   dates take the EARLIER. A best-before is a fact about the food, and the
//     stock now sitting in one row goes off when its oldest member does.
//     Taking the survivor's later date would quietly extend the life of
//     something already past it, which is the one error here that spoils food.
//
//   nothing structural moves. Ids, timestamps and the merge's own bookkeeping
//     stay with the record that owns them.

import { nameOverlap } from "./entity-match.js";

/** Significant words in a title, the same shape the matcher uses. */
export const titleTokens = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean);

/**
 * Are these two titles the same thing under two names?
 *
 * `nameOverlap` is the scan matcher's rule and it is right for what IT does:
 * offer a merge on one card, with both names in front of you, where a weak
 * match costs a glance. A review list that ends in a destructive merge is not
 * that, so this asks for TWO shared significant words on top of it.
 *
 * The single-word case is why. `nameOverlap` passes a one-token name on one
 * shared word, so "Milk" would pair with "Milk Chocolate" and "Tea" with
 * "Tea Towels" - both plainly different things, offered side by side with a
 * button that deletes one of them. Two words is what "Roma Tomatoes" and
 * "Tomatoes Roma" have and what those pairs do not.
 */
export function looksLikeSameThing(aTitle: string, bTitle: string): { same: boolean; shared: string[] } {
  const want = titleTokens(aTitle);
  if (want.length === 0) return { same: false, shared: [] };
  const ov = nameOverlap(want, bTitle);
  const have = new Set(titleTokens(bTitle));
  const shared = want.filter((t) => have.has(t));
  return { same: ov.pass && shared.length >= 2, shared };
}

/** Fields nobody merges: identity and audit belong to the row that owns them. */
const NEVER = new Set([
  "id",
  "org_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
]);

const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

/** A date field, by value rather than by name - the vocabulary for which field
 *  means "expiry" lives with the kind, and this only needs to know that two
 *  parseable dates can be compared. */
const asDate = (v: unknown): number | null => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export interface MergePlan {
  /** What to write onto the survivor. Empty when the duplicate adds nothing. */
  patch: Record<string, unknown>;
  /** Field names filled from the duplicate, for the report. */
  filled: string[];
  /** The survivor's quantity before and after, when the kind counts. */
  priorQty: number | null;
  newQty: number | null;
}

/**
 * What the survivor should end up with.
 *
 * `qtyField` is the kind's own quantity field, or null for a kind that does not
 * count (a book, a machine). Nothing here knows which field that is; the caller
 * reads it from the scannable registry.
 */
export function mergePlan(
  keep: Record<string, unknown>,
  drop: Record<string, unknown>,
  qtyField: string | null,
): MergePlan {
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];
  let priorQty: number | null = null;
  let newQty: number | null = null;

  if (qtyField) {
    const a = Number(keep[qtyField] ?? 0);
    const b = Number(drop[qtyField] ?? 0);
    priorQty = Number.isFinite(a) ? a : 0;
    newQty = priorQty + (Number.isFinite(b) ? b : 0);
    if (newQty !== priorQty) patch[qtyField] = newQty;
  }

  const keepMeta = (keep.metadata as Record<string, unknown> | undefined) ?? {};
  const dropMeta = (drop.metadata as Record<string, unknown> | undefined) ?? {};
  const mergedMeta = { ...keepMeta };
  let metaChanged = false;

  const consider = (
    key: string,
    mine: unknown,
    theirs: unknown,
    set: (v: unknown) => void,
    label: string,
  ): void => {
    if (NEVER.has(key) || key === qtyField || key === "metadata") return;
    if (isBlank(theirs)) return;
    if (isBlank(mine)) {
      set(theirs);
      filled.push(label);
      return;
    }
    // Both have a value. The only one worth reconciling is a date, where
    // earlier is the honest answer about stock that is now one row.
    const a = asDate(mine);
    const b = asDate(theirs);
    if (a !== null && b !== null && b < a) {
      set(theirs);
      filled.push(label);
    }
  };

  for (const [k, v] of Object.entries(drop)) {
    consider(k, keep[k], v, (val) => {
      patch[k] = val;
    }, k);
  }
  for (const [k, v] of Object.entries(dropMeta)) {
    consider(k, keepMeta[k], v, (val) => {
      mergedMeta[k] = val;
      metaChanged = true;
    }, k);
  }
  if (metaChanged) patch.metadata = mergedMeta;

  return { patch, filled, priorQty, newQty };
}
