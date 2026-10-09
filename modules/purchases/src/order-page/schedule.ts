// When an order's own page is read again (#5461). Pure: the sweep hands in
// what the last read found and a random number, and gets back when to read
// next, or never.
//
// Every 6 h while some line has no tracking number yet, then daily until
// everything is delivered, then never. A read the store refused (429, 403)
// backs off, doubling to a week. A link that no longer signs in, or that only
// shows the guest view without tracking, is never read again: the shipping
// emails carry the order from there.

import type { ReadOutcome } from "./shopify.js";

export type PageState = "waiting" | "following" | "done" | "expired" | "redacted" | "unsupported";

const HOUR = 60 * 60 * 1000;
const WAITING_MS = 6 * HOUR;
const FOLLOWING_MS = 24 * HOUR;
const BACKOFF_MAX_MS = 7 * 24 * HOUR;
/** A link older than this is left alone: an order still not delivered after
 *  two months is not one a store page will settle. */
export const GIVE_UP_AFTER_MS = 60 * 24 * HOUR;
/** Reads of one store's pages, across every workspace on this instance, in an hour. */
export const STORE_HOURLY_CAP = 20;

/** ±20%, so a hundred orders filed in one minute do not all read in one minute. */
export function jittered(ms: number, random: number): number {
  return Math.round(ms * (0.8 + 0.4 * Math.min(1, Math.max(0, random))));
}

export interface AfterRead {
  state: PageState;
  /** null: never read again. */
  nextReadAt: Date | null;
  /** Reads refused in a row, for the backoff. */
  refusals: number;
}

/** What follows a read. `allTracked`: every open line of the order now has a
 *  tracking number; `allDelivered`: every line is delivered. */
export function afterRead(
  outcome: ReadOutcome,
  facts: { allTracked: boolean; allDelivered: boolean; refusals: number; capturedAt: Date },
  now: Date,
  random: number,
): AfterRead {
  const at = (ms: number) => new Date(now.getTime() + jittered(ms, random));
  if (now.getTime() - facts.capturedAt.getTime() > GIVE_UP_AFTER_MS) return { state: "done", nextReadAt: null, refusals: facts.refusals };
  switch (outcome) {
    case "expired":
    case "redacted":
    case "unsupported":
      return { state: outcome, nextReadAt: null, refusals: facts.refusals };
    case "throttled": {
      const refusals = facts.refusals + 1;
      return { state: facts.allTracked ? "following" : "waiting", nextReadAt: at(Math.min(BACKOFF_MAX_MS, WAITING_MS * 2 ** refusals)), refusals };
    }
    case "failed":
      return { state: facts.allTracked ? "following" : "waiting", nextReadAt: at(WAITING_MS), refusals: facts.refusals };
    case "read":
      if (facts.allDelivered) return { state: "done", nextReadAt: null, refusals: 0 };
      if (facts.allTracked) return { state: "following", nextReadAt: at(FOLLOWING_MS), refusals: 0 };
      return { state: "waiting", nextReadAt: at(WAITING_MS), refusals: 0 };
  }
}

/** The first read of a link just captured: not at once (the order was only
 *  confirmed; nothing has shipped), a few hours on. */
export function firstReadAt(now: Date, random: number): Date {
  return new Date(now.getTime() + jittered(WAITING_MS, random));
}

/** Reads per store host per hour, for this process. */
export class StoreBudget {
  private readonly used = new Map<string, { hour: number; n: number }>();
  constructor(private readonly cap = STORE_HOURLY_CAP) {}

  /** Take one read of `host` now, or false when its hour is spent. */
  take(host: string, now: Date): boolean {
    const hour = Math.floor(now.getTime() / HOUR);
    const cur = this.used.get(host);
    const n = cur && cur.hour === hour ? cur.n : 0;
    if (n >= this.cap) return false;
    this.used.set(host, { hour, n: n + 1 });
    return true;
  }
}
