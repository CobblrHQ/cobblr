// core-shipments action handlers.
//
// `core-shipments:track` is the whole cross-module surface. A module that owns
// records carrying tracking numbers (purchases, today) calls it through
// platform().actions.invoke and stores what comes back; it never imports this
// module and this module never reads its tables.
//
// The caller passes what it has stored and gets back what to store next. ALL
// the judgement stays here — whether it is even worth asking a carrier, how to
// rank the answer against an estimate the caller already had, and when to ask
// again — because those are shipments' business, and a caller that had to
// re-implement them would drift from this one the first time either changed.

import { platform } from "@cobblr/platform-contract";
import { detectCarrier } from "../carriers.js";
import { driverForRoute } from "../drivers/index.js";
import { isPollDue, nextPollAt } from "../cadence.js";
import { etaSourceOfState, mergeEta, type EtaSource } from "../eta-confidence.js";
import { CarrierError, type ShipmentState } from "../status.js";

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
}

export function registerShipmentsActionHandlers(): void {
  if (registered) return;
  registered = true;

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

    const lastChecked = args.lastCheckedAt ? new Date(args.lastCheckedAt) : null;
    const lastState = args.lastState ?? null;
    const poll = { confirmed: args.confirmed === true, deliveredAt: args.deliveredAt ?? null };

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
      // A carrier that did not answer has told us nothing. The caller keeps its
      // estimate and its previous state; nothing here is allowed to look like
      // progress. A permanent failure stops the schedule so we do not hammer it.
      return {
        ok: false,
        followed: false,
        reason: "carrier_error",
        retryable,
        message: err instanceof Error ? err.message : "the carrier did not answer",
        eta: current,
        nextPollAt: retryable ? (nextPollAt(lastState, current.date, now, poll)?.toISOString() ?? null) : null,
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
