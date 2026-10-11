// Several of the same thing, received on different days, each good until its own
// date.
//
// Four prepared meals in the fridge are not "qty 4, expires on X". Two came
// Sunday and two came Wednesday, and the Sunday pair goes off first. A single
// qty with a single date cannot say that: increment it and the new container
// inherits the old deadline, or overwrites it and hides the old one from
// expiring. Either way somebody finds a spoiled container.
//
// THE DESIGN THAT KEEPS EVERYTHING ELSE WORKING: the visible `expires_on` stays
// the EARLIEST batch's date, and visible `qty` stays the sum. So the expiry
// sweeper, the "use it or lose it" view, the vending status dot and every wire
// carry on reading exactly what they read before, and none of them learn about
// batches. The detail is additive underneath, and it is what the drill-down
// renders:
//
//     2 received 18 Aug, use by today
//     2 received 21 Aug, use by 28 Aug
//
// The user is told to eat the oldest one. The others are fine, and saying so is
// the difference between a useful warning and one that cries wolf about
// everything in the fridge.

import { goodUntil } from "@cobblr/platform-contract/fresh-lot";

export interface Batch {
  /** ISO date (YYYY-MM-DD) this lot arrived. */
  received_on: string;
  /** ISO date it stops being good. */
  expires_on: string;
  /** How many of this lot are left. */
  qty: number;
  /** The lot number printed on the box, when there is one. Two deliveries on
   *  one day with one date but different lot numbers stay two lots: a recall
   *  names a lot, not a date. */
  lot?: string;
}

/** Oldest-expiring first. Ordering is not cosmetic: consumption takes from the
 *  front, and `expires_on` reads the front. */
export function sortBatches(batches: Batch[]): Batch[] {
  // A lot with no date sorts LAST, not first. An empty string compares below
  // every real date, so the naive comparison put undated stock at the front and
  // made it the thing the user gets warned about - with no date to show.
  const rank = (x: Batch) => (x.expires_on ? 0 : 1);
  return [...batches].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.expires_on === b.expires_on
      ? a.received_on.localeCompare(b.received_on)
      : a.expires_on.localeCompare(b.expires_on);
  });
}

/** Sum of what is actually there. The visible qty. */
export function batchQty(batches: Batch[]): number {
  return batches.reduce((n, b) => n + Math.max(0, b.qty), 0);
}

/** The date the visible `expires_on` should carry: the soonest one still held.
 *  Null when nothing is left, so a cleared item stops claiming a deadline. */
export function earliestExpiry(batches: Batch[]): string | null {
  // Only dated lots have a deadline to report. Stock that arrived by a route
  // that recorded no date has no claim on the warning.
  const live = batches.filter((b) => b.qty > 0 && b.expires_on);
  if (live.length === 0) return null;
  return sortBatches(live)[0]!.expires_on;
}

/**
 * Another one (or several) arrived today.
 *
 * Two taps on the same day become one batch of two rather than two batches of
 * one - that is how they arrived, it is how the drill-down should read, and it
 * keeps the list short for anything bought weekly for a year.
 */
export function addBatch(
  batches: Batch[],
  add: { received_on: string; expires_on: string; qty?: number; lot?: string },
): Batch[] {
  const qty = Math.max(1, Math.trunc(add.qty ?? 1));
  const lot = add.lot?.trim() || undefined;
  const same = batches.find(
    (b) => b.received_on === add.received_on && b.expires_on === add.expires_on && (b.lot || undefined) === lot,
  );
  if (same) {
    return sortBatches(batches.map((b) => (b === same ? { ...b, qty: b.qty + qty } : b)));
  }
  return sortBatches([...batches, { received_on: add.received_on, expires_on: add.expires_on, qty, ...(lot ? { lot } : {}) }]);
}

/**
 * Eat one. Always from the oldest lot, because that is the one the warning
 * named - taking from anywhere else would leave the warning standing after the
 * user did what it asked.
 *
 * Returns the batches AND which date was consumed, so a caller can say "that
 * was the one expiring today" rather than guessing.
 */
export function consumeOldest(
  batches: Batch[],
  count = 1,
): { batches: Batch[]; consumed: Array<{ expires_on: string; qty: number }> } {
  let left = Math.max(1, Math.trunc(count));
  const out = sortBatches(batches).map((b) => ({ ...b }));
  const consumed: Array<{ expires_on: string; qty: number }> = [];
  for (const b of out) {
    if (left <= 0) break;
    if (b.qty <= 0) continue;
    const take = Math.min(b.qty, left);
    b.qty -= take;
    left -= take;
    consumed.push({ expires_on: b.expires_on, qty: take });
  }
  // A spent lot is dropped rather than kept at zero: an empty row in the
  // drill-down is a thing the reader has to work out is not there.
  return { batches: out.filter((b) => b.qty > 0), consumed };
}

/**
 * Take `count` out of these lots to move somewhere else, keeping what each
 * piece IS: its expiry, when it arrived, its lot number. The soonest-expiring
 * goes first, the same rule as eating one, so restocking a vehicle from the
 * closet sends out what would otherwise go off in the closet. A caller may
 * name a lot instead (by lot number or by expiry date); then only that lot is
 * taken from, and asking for more than it holds is refused, never quietly made
 * up from another lot.
 *
 * Stock with no lots (nothing dated) moves as a plain count: `moved` is empty
 * and the receiving end files it the way it files any undated arrival.
 */
export function takeLots(
  batches: Batch[],
  count: number,
  pick?: { lot?: string; expires_on?: string },
): { batches: Batch[]; moved: Batch[] } | { refused: "no_such_lot" | "lot_too_small"; have: number } {
  let left = Math.max(0, count);
  const out = sortBatches(batches).map((b) => ({ ...b }));
  const matches = (b: Batch) =>
    (pick?.lot ? b.lot === pick.lot.trim() : true) && (pick?.expires_on ? b.expires_on === pick.expires_on : true);
  if (pick && (pick.lot || pick.expires_on)) {
    const chosen = out.filter(matches);
    const have = chosen.reduce((n, b) => n + Math.max(0, b.qty), 0);
    if (!chosen.length) return { refused: "no_such_lot", have: 0 };
    if (have < left) return { refused: "lot_too_small", have };
  }
  const moved: Batch[] = [];
  for (const b of out) {
    if (left <= 0) break;
    if (b.qty <= 0) continue;
    if (pick && (pick.lot || pick.expires_on) && !matches(b)) continue;
    const take = Math.min(b.qty, left);
    b.qty -= take;
    left -= take;
    moved.push({ received_on: b.received_on, expires_on: b.expires_on, qty: take, ...(b.lot ? { lot: b.lot } : {}) });
  }
  return { batches: out.filter((b) => b.qty > 0), moved };
}

/** Receive lots that came from somewhere else, each keeping its own dates and
 *  lot number; the same lot arriving twice is one lot. */
export function putLots(batches: Batch[], moved: Batch[]): Batch[] {
  let out = batches;
  for (const m of moved) {
    if (m.qty <= 0) continue;
    out = addBatch(out, { received_on: m.received_on, expires_on: m.expires_on, qty: m.qty, ...(m.lot ? { lot: m.lot } : {}) });
  }
  return out;
}

/**
 * What an item with no batch history looks like as batches.
 *
 * Everything already in a workspace has a plain qty and maybe an expires_on and
 * has never heard of this. Rather than migrating them, read them as the one
 * batch they effectively are. So the feature works on existing data from the
 * first tap, and nothing needs backfilling.
 */
export function batchesFrom(
  metadata: Record<string, unknown> | null | undefined,
  qty: number,
  expiresOn: string | null | undefined,
): Batch[] {
  const raw = (metadata ?? {})["batches"];
  if (Array.isArray(raw)) {
    const parsed = raw
      .filter((b): b is Batch => !!b && typeof b === "object")
      .map((b) => {
        const lot = typeof (b as Batch).lot === "string" && (b as Batch).lot!.trim() ? (b as Batch).lot!.trim() : undefined;
        return {
          received_on: String((b as Batch).received_on ?? ""),
          expires_on: String((b as Batch).expires_on ?? ""),
          qty: Number((b as Batch).qty ?? 0),
          ...(lot ? { lot } : {}),
        };
      })
      // A lot number is a fact even without a date: a spool's batch has no
      // use-by, and dropping it lost every batch a box printed (#5764).
      .filter((b) => (b.expires_on || b.lot) && b.qty > 0);
    if (parsed.length > 0) return sortBatches(parsed);
  }
  // No batches recorded. An item with stock and a date is one lot; an item with
  // no date has nothing to track, and inventing one would put a fake deadline on
  // a jar of salt.
  if (qty > 0 && expiresOn) {
    // received_on is EMPTY, not a copy of the expiry. We do not know when this
    // arrived and inventing a date would make the drill-down state a fact
    // nobody recorded - "2 received 24 Aug" when 24 Aug is its use-by.
    return [{ received_on: "", expires_on: expiresOn, qty }];
  }
  return [];
}

/** The date `+` should stamp: today plus however long this keeps. Null when the
 *  item does not declare a shelf life, so nothing is invented. */
export function expiryFor(receivedOn: string, shelfLifeDays: number | null | undefined): string | null {
  return goodUntil(receivedOn, shelfLifeDays);
}

/** One line per lot, oldest first - what the drill-down shows. */
export function describeBatches(batches: Batch[], today: string): string[] {
  return sortBatches(batches.filter((b) => b.qty > 0)).map((b) => {
    const days = Math.round(
      (new Date(`${b.expires_on}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
        86_400_000,
    );
    const when =
      days < 0 ? `${-days}d past its date` : days === 0 ? "use by today" : `use by ${b.expires_on}`;
    const lot = b.lot ? `lot ${b.lot}, ` : "";
    return b.received_on
      ? `${b.qty} ${lot}received ${b.received_on}, ${when}`
      : `${b.qty} ${lot}already here, ${when}`;
  });
}

/**
 * The visible numbers this set of lots implies.
 *
 * THE INVARIANT LIVES HERE, in one function, because it was previously stated
 * only in a comment and maintained by nothing. Every existing qty write path
 * (use-one, adjust-stock, the restock wire, a scan add-qty) knows nothing about
 * batches, so the moment an item had them any of those would desync the visible
 * numbers from the lots underneath - the same "second write path skips the
 * shared step" shape that has already cost a ledger split across two entity
 * kinds and computed fields missing from a list route.
 *
 * Anything that writes batches calls this and writes what it returns. Anything
 * that writes qty WITHOUT going through batches is a desync, which
 * `batchesConsistent` detects.
 */
export function visibleFrom(batches: Batch[]): { qty: number; expires_on: string | null } {
  return { qty: batchQty(batches), expires_on: earliestExpiry(batches) };
}

/**
 * Have the visible numbers drifted from the lots?
 *
 * Returns null when consistent (or when there are no batches to be consistent
 * with), and a description of the drift when not. Used to decide whether the
 * lots can still be trusted: a qty changed behind their back means the batch
 * detail is stale, and stale lot dates are worse than none because they carry
 * the authority of looking precise.
 */
export function batchDrift(
  batches: Batch[],
  visibleQty: number,
): { expected: number; actual: number } | null {
  if (batches.length === 0) return null;
  const expected = batchQty(batches);
  return expected === visibleQty ? null : { expected, actual: visibleQty };
}

/**
 * Reconcile lots against a qty that changed elsewhere.
 *
 * A path that does not know about batches is allowed to exist - that is most of
 * inventory - so the lots have to be able to absorb its writes rather than
 * fight them. Fewer than expected: consume from the oldest, because whatever
 * happened, the oldest is what should have gone. More than expected: the extra
 * has no known arrival or shelf life, so it becomes a lot with no date rather
 * than inheriting someone else's deadline.
 */
export function reconcileToQty(batches: Batch[], visibleQty: number): Batch[] {
  const drift = batchDrift(batches, visibleQty);
  if (!drift) return batches;
  if (visibleQty <= 0) return [];
  if (drift.actual < drift.expected) {
    return consumeOldest(batches, drift.expected - drift.actual).batches;
  }
  const extra = drift.actual - drift.expected;
  // Deliberately dateless. Inventing an expiry for stock that appeared by an
  // unknown route would put a confident deadline on something nobody recorded.
  return sortBatches([...batches, { received_on: "", expires_on: "", qty: extra }]);
}

/** The lots a record serves: what was recorded, and, once any of it carries
 *  a lot number, the rest of the count as one lot with none ("batch
 *  unknown"), so the lots always add up to what is there. Stock that never
 *  had a lot number serves what it always did. */
export function servedLots(metadata: Record<string, unknown> | null | undefined, qty: number, expiresOn: string | null | undefined): Batch[] {
  const lots = batchesFrom(metadata, qty, expiresOn);
  return lots.some((b) => b.lot) ? reconcileToQty(lots, qty) : lots;
}

/** Arriving stock with the lot numbers its boxes printed: one lot per number,
 *  received today, at most the delta between them. */
export interface ArrivingLot {
  lot: string;
  qty: number;
}

/** What a caller sent as lots, kept only where it makes sense: a number and a
 *  whole count above zero, never more between them than arrived. */
export function arrivingLotsOf(raw: unknown, delta: number): ArrivingLot[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrivingLot[] = [];
  let left = Math.trunc(delta);
  for (const r of raw) {
    const lot = typeof (r as ArrivingLot)?.lot === "string" ? (r as ArrivingLot).lot.trim() : "";
    const qty = Math.trunc(Number((r as ArrivingLot)?.qty));
    if (!lot || !(qty > 0) || qty > left) continue;
    out.push({ lot, qty });
    left -= qty;
  }
  return out;
}
