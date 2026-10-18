// A lot keeps for as long as the place it is in lets it: the same unopened
// food has a warm number, a fridge number and a freezer number
// (kitchen-participation.md section 2). Moving it restates the lots' dates from
// the number for where it now is.
//
// Pure. The rule that keeps it safe: a lot is moved between clocks only when
// its date PROVES which clock it is on, that is, when it equals the day it
// arrived plus one of the item's own numbers. A date a person typed, one the
// opened clock set, or a lot with no arrival day is not on any clock we can
// name, and is left exactly as it is.

import type { StorageRequirement } from "@cobblr/platform-contract/storage-requirement";
import { goodUntil } from "@cobblr/platform-contract/fresh-lot";
import type { Batch } from "./batches.js";

export type Clock = "warm" | "refrigerated" | "frozen";

export interface ClockNumbers {
  warm: number | null;
  refrigerated: number | null;
  frozen: number | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function days(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** The three numbers an item states, from its metadata. */
export function clockNumbers(md: Record<string, unknown> | null | undefined): ClockNumbers {
  const m = md ?? {};
  return { warm: days(m.shelf_life_days), refrigerated: days(m.shelf_life_refrigerated_days), frozen: days(m.shelf_life_frozen_days) };
}

/** The clock a place puts food on: the fridge, the freezer, or the warm one
 *  anywhere else. A freezer with no number of its own keeps the fridge's. */
export function clockFor(place: StorageRequirement | null): Clock {
  return place === "frozen" ? "frozen" : place === "refrigerated" ? "refrigerated" : "warm";
}

function numberOn(clock: Clock, n: ClockNumbers): number | null {
  return clock === "frozen" ? n.frozen ?? n.refrigerated : n[clock];
}

export interface Restated {
  batches: Batch[];
  /** Whether any lot's date moved. */
  changed: boolean;
}

/** The lots, restated for the clock of the place the item is now in. */
export function restateLots(batches: readonly Batch[], numbers: ClockNumbers, now: Clock): Restated {
  const target = numberOn(now, numbers);
  if (target === null) return { batches: [...batches], changed: false };
  let changed = false;
  const out = batches.map((b) => {
    if (!DAY.test(b.received_on) || !DAY.test(b.expires_on)) return b;
    const onClock = (["warm", "refrigerated", "frozen"] as const).some((c) => {
      const n = numberOn(c, numbers);
      return n !== null && goodUntil(b.received_on, n) === b.expires_on;
    });
    if (!onClock) return b;
    const to = goodUntil(b.received_on, target);
    if (!to || to === b.expires_on) return b;
    changed = true;
    return { ...b, expires_on: to };
  });
  return { batches: out, changed };
}
