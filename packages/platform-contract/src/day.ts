// Whose day is it?
//
// "today" is a claim about a PERSON's calendar, and the UTC day is nobody's.
// At 21:00 in Los Angeles it is already tomorrow in UTC, so
// `new Date().toISOString().slice(0, 10)` says the wrong day for everyone west
// of Greenwich through their whole evening, which is exactly when somebody
// opens a grocery list: a line says "expires today" the night before, a lot
// restocked at 6pm is dated tomorrow and counts its shelf life from tomorrow,
// and a form pre-fills a day the person has not reached (#3351). The failure
// is silent and reads as the app being wrong about their things.
//
// There are three honest answers, and this is the one place that gives them:
//
//   dayIn(now, tz)        the person's own day, when their zone is known.
//   arrivedEverywhere(n)  the day that has arrived for EVERYBODY (UTC-12):
//                         for something decided once for many people, where
//                         there is no single clock to read. Never early.
//   daySaid(value)        the day the caller stated, when a request carries
//                         one (a browser knows its own zone).
//
// `theirDay` ranks them: what was said, then where they told us they are,
// then the day that has arrived everywhere. The UTC day is not among them,
// and `lint:one-day-rule` refuses it in a today-claim.

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day it is at `now` in `timeZone` (an IANA name). An unknown
 *  zone is not a reason to invent a day: it falls back to the day that has
 *  arrived everywhere, which is late for somebody rather than early for
 *  anybody. */
export function dayIn(now: Date, timeZone: string | null | undefined): Day {
  if (!timeZone) return arrivedEverywhere(now);
  try {
    // en-CA formats as YYYY-MM-DD, which is the shape the stored dates use.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  } catch {
    return arrivedEverywhere(now);
  }
}

/**
 * The day a promised date can be said to have ARRIVED, anywhere.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, and two arrival
 * sweepers compared stored `YYYY-MM-DD` dates against it. At 8pm US Eastern it
 * is already tomorrow in UTC, so a parcel due the 25th was announced as "due
 * today. Did it turn up?" at 8pm on the 24th - a whole evening before the day it
 * names (reported 2026-08-24).
 *
 * These announcements are decided once for a batch or an order and sent to every
 * member, so there is no single recipient whose clock to read. The rule that is
 * right without one: a date has arrived when it has arrived EVERYWHERE. UTC-12
 * is the last zone on earth to enter a date, so waiting for it cannot be early
 * for anybody.
 *
 * The cost is up to half a day of lateness for someone far east, which is the
 * correct direction to err: "did it turn up?" is a question you ask after the
 * postman has been, never before.
 */
export function arrivedEverywhere(now: Date): Day {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Etc/GMT+12" }).format(now);
  } catch {
    // No zone data: still lag rather than lead.
    return new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}

/** The day a caller stated, when it stated one that is a day. A client knows
 *  its own zone, so what it says beats anything the server can work out. */
export function daySaid(value: unknown): Day | null {
  return typeof value === "string" && DAY_RE.test(value) ? value : null;
}

/** The day it is for one person, from the best thing we know about them:
 *  what their client said, else the zone they told us they are in, else the
 *  day that has arrived everywhere. */
export function theirDay(opts: { said?: unknown; timeZone?: string | null; now?: Date }): Day {
  const now = opts.now ?? new Date();
  return daySaid(opts.said) ?? (opts.timeZone ? dayIn(now, opts.timeZone) : arrivedEverywhere(now));
}

/** The day it is HERE, for code running in the person's own browser: the
 *  local calendar day, never `toISOString` (which is UTC and is tomorrow all
 *  evening in the Americas). Also right on a server whose zone is the
 *  person's, which is why it takes no zone. */
export function dayHere(now: Date = new Date()): Day {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
