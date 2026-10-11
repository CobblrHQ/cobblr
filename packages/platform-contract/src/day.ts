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

import { fieldDay } from "@cobblr/platform-contract/field-day";

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

/**
 * How many calendar days from `today` until `target`: 0 on the day, 1 the day
 * before, -1 the day after. THE countdown: every surface that says "in 5 days",
 * "5d", "expires today" or "3d ago" about a date gets its number here.
 *
 * Day against day, never an instant against a date. A clock difference is a
 * fraction of a day, and each surface turned it into a number its own way: the
 * dashboard's attention list rounded (Sep 29 read "in 4d" at 15:48 in New York,
 * 4.17 days before UTC midnight), its Up next counted calendar days ("in 5
 * days"), and the grocery wall rounded against local midnight. One page, two
 * answers for the same banana (#3641). Both inputs are days, so this is exact
 * and has no hour at which it changes its mind.
 *
 * `today` is the caller's frame: the browser's `dayHere()`, a person's
 * `theirDay()`, or `arrivedEverywhere()` for a batch with no single reader.
 */
export function daysUntil(target: Day, today: Day): number {
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** `daysUntil` for a stored date field, read by the one day rule (a month-only
 *  best-before is the last day of its month). Null when the value names no
 *  day: a countdown to a guess is worse than none. */
export function daysUntilField(value: unknown, today: Day): number | null {
  const day = fieldDay(value);
  return day === null ? null : daysUntil(day, today);
}

/**
 * The countdown in words, from `daysUntil`. Two lengths, one number:
 *   short  "today" · "tomorrow" · "in 5d" · "yesterday" · "3d ago"   (a list row)
 *   long   "today" · "tomorrow" · "in 5 days" · "in 3 weeks" · "2 months ago"
 * A surface picks a length; it never picks its own arithmetic.
 */
/** A span of days as a person says it: "9 days", "3 weeks", "4 months",
 *  "6 years". A count is never said in a smaller unit than reads naturally:
 *  "due in 26657 days" told nobody anything. */
export function spanWords(days: number): string {
  const n = Math.abs(Math.round(days));
  if (n < 14) return `${n} day${n === 1 ? "" : "s"}`;
  if (n < 60) return `${Math.round(n / 7)} weeks`;
  if (n < 548) return `${Math.round(n / 30)} months`;
  return `${Math.round(n / 365.25)} years`;
}

export function countdownWords(target: Day, today: Day, style: "short" | "long" = "short"): string {
  const diff = daysUntil(target, today);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const n = Math.abs(diff);
  if (style === "short") return diff < 0 ? `${n}d ago` : `in ${n}d`;
  return diff < 0 ? `${spanWords(n)} ago` : `in ${spanWords(n)}`;
}

// A DAY IS NOT AN INSTANT (#5759).
//
// A date-only value names a calendar day, which has no hour and no zone.
// `new Date("2026-10-16")` gives it both: midnight in UTC, the evening of the
// 15th anywhere west of Greenwich. A service visit booked for the 16th read
// "due 10/15" in New York, and every surface that met the same trap had
// patched it its own way (`T12:00:00`, `timeZone: "UTC"`, a local-midnight
// helper) or not at all. So a day is read with `fieldDay`, shown with
// `dayLabel`, counted with `daysUntil`, and only becomes an instant through
// `instantOnDay`, which has to be told whose day it is. `lint:date-only-is-a-day`
// refuses the other doors.

const DAY_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day's year, month and day, or null when it is not a day that exists. */
function partsOf(day: Day): [number, number, number] | null {
  const m = DAY_PARTS.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

/**
 * A day as a person reads it, the same day in every zone: "Oct 16, 2026",
 * or whatever `opts` asks for. The value is read by `fieldDay`, so a stored
 * date, a timestamp a column sent, or a best-before month all work; a value
 * that names no day comes back as written rather than as a made-up date.
 * Formatted in UTC on purpose: the day was built in UTC, so no zone can move it.
 */
export function dayLabel(value: unknown, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }, locale?: string | string[]): string {
  const day = fieldDay(value);
  const parts = day ? partsOf(day) : null;
  if (!parts) return value == null ? "" : String(value);
  const [y, m, d] = parts;
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The minutes `timeZone` is ahead of UTC at `at`. */
function offsetMinutes(at: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((local - Math.floor(at / 1000) * 1000) / 60_000);
}

/** Which moment of the day: its middle, its first instant, or its last. */
export type DayMoment = "noon" | "start" | "end";

/**
 * The instant to store when a column holds an instant but a person gave a
 * day (a visit "on the 16th", a task due the 16th). With no zone that is
 * NOON UTC, the platform's one encoding of a day in an instant column: it
 * needs nobody's zone to write, `dayStoredAt` reads it back as exactly that
 * day anywhere, and even a reader that shows it in local time sees the same
 * day from UTC-11 to UTC+11.
 *
 * `at: "start" | "end"` with a zone is that day's first or last instant
 * where the person is, for a window ("public until the 16th" lasts through
 * their 16th). Without a zone the answer is never wrong in the costly
 * direction: `start` when the day begins at UTC+14, `end` when it ends at
 * UTC-12, so a window opens no later and closes no sooner than anybody's day.
 */
export function instantOnDay(day: Day, timeZone?: string | null, at: DayMoment = "noon"): Date | null {
  const parts = partsOf(day);
  if (!parts) return null;
  const [y, m, d] = parts;
  const wall = at === "noon" ? Date.UTC(y, m - 1, d, 12) : at === "start" ? Date.UTC(y, m - 1, d) : Date.UTC(y, m - 1, d + 1) - 1;
  if (!timeZone || at === "noon") {
    if (at === "noon") return new Date(wall);
    return new Date(at === "start" ? wall - 14 * 3_600_000 : wall + 12 * 3_600_000);
  }
  try {
    // Twice: the first guess may sit across a DST change from the answer.
    let guess = wall - offsetMinutes(wall, timeZone) * 60_000;
    guess = wall - offsetMinutes(guess, timeZone) * 60_000;
    return new Date(guess);
  } catch {
    return instantOnDay(day, null, at);
  }
}

/**
 * An instant a request sent, which a date input sends as a bare day. A full
 * timestamp is that instant; a bare day is `instantOnDay` in the sender's
 * zone; anything else is null, never an Invalid Date stored as a value.
 */
export function instantFromInput(value: unknown, timeZone?: string | null, at: DayMoment = "noon"): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return instantOnDay(s, timeZone, at);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The day `n` days after `day` (before, for a negative `n`): calendar
 *  arithmetic on the day itself, so no hour or zone can move the answer. */
export function addDays(day: Day, n: number): Day {
  const parts = partsOf(day);
  if (!parts) return day;
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** True when an instant is how a day is stored: noon UTC to the millisecond. */
export function isStoredDay(at: Date): boolean {
  const t = at.getTime();
  return Number.isFinite(t) && ((t % 86_400_000) + 86_400_000) % 86_400_000 === 12 * 3_600_000;
}

/**
 * The day an instant column's value names. A bare day is itself. A stored day (noon UTC, written by
 * `instantOnDay`) is its own day in every zone; any other instant is the day
 * it falls on where the reader is (`dayIn`). This is how a column that holds
 * both, a visit someone booked for the 16th beside one a schedule worked out
 * from when the last service was done, is read without moving either.
 */
export function dayStoredAt(value: Date | string, timeZone: string | null | undefined): Day | null {
  if (typeof value === "string" && DAY_PARTS.test(value.trim())) return partsOf(value.trim()) ? value.trim() : null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return isStoredDay(at) ? at.toISOString().slice(0, 10) : dayIn(at, timeZone);
}

/** `dayStoredAt` for code running in the person's own browser: an instant
 *  that is not a stored day falls on the local calendar day. */
export function dayStoredHere(value: Date | string): Day | null {
  if (typeof value === "string" && DAY_PARTS.test(value.trim())) return partsOf(value.trim()) ? value.trim() : null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return isStoredDay(at) ? at.toISOString().slice(0, 10) : dayHere(at);
}
