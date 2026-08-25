// When to ask a carrier again.
//
// The bridge is dumb on purpose: number in, status out, no schedule of its own.
// If every bridge scheduled its own polling they would all differ and Cobblr
// could not reason about how fresh an answer is. So the cadence lives here, and
// a consequence follows: core cannot assume the endpoint caches. Real EasyPost
// keeps trackers fresh server-side and a read is nearly free; a local bridge
// does live work on every call. The cadence has to suit the expensive case.
//
// A flat interval is wrong in both directions. Every 8 hours wastes two calls a
// day on a parcel sitting in a warehouse for a week, and is still too slow on
// the evening it is out for delivery. So the rate follows how likely the state
// is to change, anchored to the three times a day a parcel actually moves:
//
//   ~05:00  overnight line-haul has happened
//   ~09:00  the out-for-delivery scan
//   ~19:00  the delivered scan

import type { ShipmentState } from "./status.js";

/** Local hours a parcel is worth asking about. Everything below picks from
 *  these rather than adding an offset to "now", so polls land on the rhythm
 *  rather than drifting by however long the last one took. */
export const POLL_HOURS = { overnight: 5, morning: 9, evening: 19 } as const;

/** How long after a delivery scan a parcel is still worth watching, when the
 *  user has not confirmed they have it. Long enough to cover a premature scan
 *  and a person being away for a week; short enough that an order nobody ever
 *  answers about does not poll for the rest of time. */
const DISPUTE_WINDOW_MS = 14 * 24 * 3_600_000;

/** What the caller knows that the carrier cannot say. */
export interface PollContext {
  /** The USER confirmed they have it. The only thing that truly finishes a
   *  parcel, and the only thing that stops the polling for good. */
  confirmed?: boolean;
  /** When the carrier said it landed, for bounding the watch above. */
  deliveredAt?: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The next time today or tomorrow at one of the given local hours. */
function nextAt(now: Date, hours: number[]): Date {
  const sorted = [...hours].sort((a, b) => a - b);
  for (const h of sorted) {
    const candidate = new Date(now);
    candidate.setHours(h, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const tomorrow = new Date(now.getTime() + DAY_MS);
  tomorrow.setHours(sorted[0]!, 0, 0, 0);
  return tomorrow;
}

/** True when `eta` is today or already past, in local terms. */
function etaIsHereOrPast(eta: string | null, now: Date): boolean {
  if (!eta) return false;
  const d = new Date(`${eta.slice(0, 10)}T23:59:59`);
  return !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime() + DAY_MS - 1;
}

/** A flat interval, in minutes, overriding the schedule below.
 *
 *  The schedule assumes an endpoint where asking is expensive, because core
 *  cannot know what is behind the URL. When you DO know — a service whose reads
 *  are free, or a bridge on your own machine — a flat interval is simpler and
 *  more responsive than windows, and this is the knob for it.
 *
 *  0 means "always due", which is what an end-to-end test needs: a scheduler is
 *  otherwise undriveable without waiting for a real window to come round. */
function flatIntervalMinutes(): number | null {
  // `||` not `??`: compose passes an unset var as "" (CLAUDE.md section 14.6).
  const raw = (process.env.COBBLR_TRACKING_POLL_INTERVAL || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  // A non-numeric value falls back to the schedule rather than to NaN, which
  // would compare false against everything and silently never poll at all.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** When to next ask about a parcel, or null when we should never ask again.
 *
 *  Null is a real answer and the important one: a delivered or cancelled parcel
 *  is finished, and continuing to poll it costs somebody money forever.
 *
 *  Pure, so the schedule can be asserted without a clock or a network. */
export function nextPollAt(
  state: ShipmentState | null,
  eta: string | null,
  now: Date,
  opts: PollContext = {},
): Date | null {
  // FINISHED means the user said so, not the carrier.
  //
  // Stopping on the carrier's "delivered" was wrong in a way the rest of this
  // design already knew: a delivered scan means the parcel reached a doorstep.
  // Carriers scan prematurely, the user says "no, I never got it", and the next
  // morning it is out for delivery again — and Cobblr had already stopped
  // looking, so it never learned. Watching matters MOST right after somebody
  // says something is wrong.
  if (opts.confirmed) return null;

  // Delivered and unconfirmed: keep an eye on it, slowly, in case it resumes.
  // Bounded, because an order nobody ever confirms would otherwise be polled
  // forever, and nothing ever complains about that.
  if (state === "delivered") {
    const since = opts.deliveredAt ? Date.parse(opts.deliveredAt) : NaN;
    const elapsed = Number.isFinite(since) ? now.getTime() - since : 0;
    if (elapsed > DISPUTE_WINDOW_MS) return null;
    return nextAt(now, [POLL_HOURS.overnight]);
  }

  const flat = flatIntervalMinutes();
  if (flat !== null) return new Date(now.getTime() + flat * 60_000);

  // Out for delivery is the one state where hours matter: it will either be
  // delivered this evening or it will not, and both are worth knowing tonight.
  //
  // BOTH windows, not just the evening. With [evening] alone, a poll at 19:05
  // schedules the next look for TOMORROW 19:00 — and the delivered scan lands
  // in exactly that gap (a real one hit at 19:49, and would have sat unseen
  // for 24 hours). The overnight window catches tonight's delivery by 05:00,
  // which is also when a failed attempt's re-schedule shows up.
  if (state === "out_for_delivery") {
    return nextAt(now, [POLL_HOURS.overnight, POLL_HOURS.evening]);
  }

  // An exception is waiting on a person, not on the carrier. Daily is plenty;
  // the useful signal was the state change itself, which we already have.
  if (state === "exception") return nextAt(now, [POLL_HOURS.overnight]);

  // Arrival day (or overdue): all three windows, because this is when out-for-
  // delivery and delivered both land.
  if (etaIsHereOrPast(eta, now)) {
    return nextAt(now, [POLL_HOURS.overnight, POLL_HOURS.morning, POLL_HOURS.evening]);
  }

  // Everything else — in transit with days to go, pre-transit, or a number the
  // carrier has never heard of. Once a day, after the overnight movement.
  return nextAt(now, [POLL_HOURS.overnight]);
}

/** Whether a parcel is due to be asked about now.
 *
 *  Never polled (`lastCheckedAt` null) is always due: a tracking number that
 *  was just typed in should resolve while the user is still looking at it. */
export function isPollDue(
  state: ShipmentState | null,
  eta: string | null,
  lastCheckedAt: Date | null,
  now: Date,
  opts: PollContext = {},
): boolean {
  if (opts.confirmed) return false;
  if (!lastCheckedAt) return true;
  const due = nextPollAt(state, eta, lastCheckedAt, opts);
  return due !== null && due.getTime() <= now.getTime();
}
