// core-shipments action handlers.
//
// `core-shipments:track` is the whole cross-module surface. A module that owns
// records carrying tracking numbers (purchases, core-scan's receipts) calls it through
// platform().actions.invoke and stores what comes back; it never imports this
// module and this module never reads its tables.
//
// The caller passes what it has stored and gets back what to store next. ALL
// the judgement stays here — whether it is even worth asking a carrier, how to
// rank the answer against an estimate the caller already had, and when to ask
// again — because those are shipments' business, and a caller that had to
// re-implement them would drift from this one the first time either changed.

import { platform } from "@cobblr/platform-contract";
import { detectCarrier, trackingLookup } from "../carriers.js";
import { driverForRoute } from "../drivers/index.js";
import { isPollDue, nextPollAt } from "../cadence.js";
import { etaSourceOfState, mergeEta, type EtaSource } from "../eta-confidence.js";
import { CarrierError, type ShipmentState } from "../status.js";
import { instantFromInput } from "@cobblr/platform-contract/day";

let registered = false;

interface TrackArgs {
  number?: string;
  /** What the caller currently shows as the arrival date, and where it came
   *  from. Passed in so the ranking happens here rather than at the caller. */
  currentEta?: string | null;
  currentEtaSource?: EtaSource | null;
  /** The caller's stored poll state. */
  lastState?: ShipmentState | null;
  lastCheckedAt?: string | null;
  /** Ask the carrier even if the cadence says it is not due yet. The panel
   *  does this when a person is looking at the order right now. */
  force?: boolean;
  /** The USER confirmed they have it. Only this stops the watching for good:
   *  a carrier's "delivered" means it reached a doorstep, and premature scans
   *  are common enough that giving up on one loses the parcel. */
  confirmed?: boolean;
  /** When the carrier said it landed, so an unconfirmed delivery is watched
   *  for a bounded window rather than forever. */
  deliveredAt?: string | null;
  /** Days to keep watching after the delivered scan (default: the recipient's
   *  14). A sender asks for 2. */
  watchDaysAfterDelivery?: number;
}

export function registerShipmentsActionHandlers(): void {
  if (registered) return;
  registered = true;

  // Which carrier a number belongs to and where a person looks it up: the
  // pure half of track, with no carrier call. A record about to tell somebody
  // "it has shipped" asks this for the name and the link to put in the words.
  platform().actions.registerHandler("core-shipments.identify", async (ctx) => {
    const number = String((ctx.args as { number?: unknown } | null)?.number ?? "").trim();
    if (!number) return { ok: true, skipped: "no tracking number" };
    const carrier = detectCarrier(number);
    return {
      ok: true,
      carrier: carrier ? { code: carrier.code, name: carrier.name } : null,
      lookup: trackingLookup(number, carrier),
    };
  });

  platform().actions.registerHandler("core-shipments.track", async (ctx) => {
    const args = (ctx.args as TrackArgs | null) ?? {};
    const number = (args.number ?? "").trim();
    if (!number) return { ok: true, skipped: "no tracking number" };

    const now = new Date();
    const carrier = detectCarrier(number);
    const current = {
      date: args.currentEta ?? null,
      source: (args.currentEtaSource ?? (args.currentEta ? "receipt" : "none")) as EtaSource,
    };

    // Nothing recognises the number: the caller keeps whatever estimate it had,
    // and there is nothing to schedule.
    if (!carrier) {
      return { ok: true, followed: false, reason: "unrecognised", eta: current, nextPollAt: null };
    }

    const lastChecked = instantFromInput(args.lastCheckedAt);
    const lastState = args.lastState ?? null;
    const watchDays = Number(args.watchDaysAfterDelivery);
    const poll = {
      confirmed: args.confirmed === true,
      deliveredAt: args.deliveredAt ?? null,
      ...(Number.isFinite(watchDays) && watchDays >= 0 ? { watchAfterDeliveryMs: watchDays * 24 * 3_600_000 } : {}),
    };

    // Whose parcel this is decides who can follow it: the instance may have no
    // tracking credentials at all while its owner has connected their own.
    const route = { orgId: ctx.orgId, ownerUserId: ctx.userId ?? null };
    const { driver, connected } = await driverForRoute(carrier.code, route);
    if (!driver || !connected) {
      return {
        ok: true,
        followed: false,
        reason: driver ? "not_connected" : "no_driver",
        eta: current,
        nextPollAt: null,
      };
    }

    // Confirmed is final, and outranks `force`. Once the user says they have
    // it there is nothing left to learn, so even a person opening the record
    // must not spend a call on it.
    if (poll.confirmed) {
      return { ok: true, followed: false, reason: "confirmed", eta: current, nextPollAt: null };
    }

    // Cheap on the happy path: a parcel checked this morning is not checked
    // again this afternoon.
    if (!args.force && !isPollDue(lastState, current.date, lastChecked, now, poll)) {
      return {
        ok: true,
        followed: false,
        reason: "not_due",
        eta: current,
        nextPollAt: nextPollAt(lastState, current.date, lastChecked ?? now, poll)?.toISOString() ?? null,
      };
    }

    let status;
    try {
      // A person asking about their own parcel routes to THEIR bridge; the
      // sweep has no user, so it falls back to the workspace's.
      status = await driver.track(carrier.number, carrier.code, route);
    } catch (err) {
      const retryable = err instanceof CarrierError ? err.retryable : true;
      const full = err instanceof CarrierError && err.quotaExhausted;
      const busy = err instanceof CarrierError && err.busy;
      const waitMs = err instanceof CarrierError ? err.retryAfterMs : null;
      // A carrier that did not answer has told us nothing. The caller keeps its
      // estimate and its previous state; nothing here is allowed to look like
      // progress. A permanent failure stops the schedule so we do not hammer it.
      return {
        ok: false,
        followed: false,
        reason: full ? "quota_exhausted" : busy ? "busy" : "carrier_error",
        retryable,
        message: err instanceof Error ? err.message : "the carrier did not answer",
        eta: current,
        // Busy: when it said to come back, else the next window.
        nextPollAt: busy && waitMs !== null
          ? new Date(now.getTime() + waitMs).toISOString()
          : retryable ? (nextPollAt(lastState, current.date, now, poll)?.toISOString() ?? null) : null,
        ...(busy ? { retryAfterMs: waitMs } : {}),
      };
    }

    // Rank the carrier's date against what the caller already had. A silent
    // tracking number cannot erase a receipt's estimate.
    const source = etaSourceOfState(status.state, !!status.estimatedDelivery);
    const eta = mergeEta(current, source ? { date: status.estimatedDelivery, source } : null);

    return {
      ok: true,
      followed: true,
      status,
      eta,
      // Never arrived_at. A carrier saying "delivered" means it is on a
      // doorstep; only a person can say they took it in and put it away.
      // Bound the watch from THIS answer's delivery time, not the caller's
      // stale one, so a fresh delivery restarts the dispute window.
      nextPollAt:
        nextPollAt(status.state, eta.date, now, {
          confirmed: poll.confirmed,
          deliveredAt: status.deliveredAt ?? poll.deliveredAt,
        })?.toISOString() ?? null,
    };
  });
}
