// When a receipt says something is on its way.
//
// An order email routinely prints an arrival estimate and the parse has been
// keeping it (`expected_arrival`) for as long as it has been reading receipts.
// Nothing showed it. The one place in the app that renders that field is a
// purchase Order, so a receipt in the scan inbox knew a laptop was arriving
// tomorrow and said nothing, while offering to let you type in a tracking
// number it did not have (2026-08-24).
//
// It is the only fact on that row about the FUTURE, which is what makes it
// worth the space: a date on a receipt tells you what happened, an arrival tells
// you what to expect at the door.

/** An arrival estimate, and how far off it is. */
export interface Arrival {
  /** The stored `YYYY-MM-DD`. */
  date: string;
  /** Whole days from today. Negative when the estimate has passed. */
  daysAway: number;
}

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Midnight LOCAL for a plain date. `new Date("2026-08-25")` is UTC midnight,
 *  which is the previous day anywhere west of Greenwich - the same trap the
 *  receipt date hit. */
function localMidnight(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y!, m! - 1, day!);
}

/**
 * The arrival a session is waiting on, hoisted from whichever line carries one.
 *
 * The EARLIEST, when the lines disagree: an order split across two shipments is
 * "arriving Tuesday" from the moment the first box is due, and a row that named
 * the later date would say nothing is coming while a parcel sits on the step.
 */
export function arrivalOf(
  items: ReadonlyArray<{ suggested_metadata?: unknown }>,
  today: Date = new Date(),
): Arrival | null {
  let earliest: string | null = null;
  for (const it of items) {
    const v = (it.suggested_metadata as { expected_arrival?: unknown } | null)?.expected_arrival;
    if (!isDate(v)) continue;
    if (!earliest || v < earliest) earliest = v;
  }
  if (!earliest) return null;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const then = localMidnight(earliest);
  return {
    date: earliest,
    daysAway: Math.round((then.getTime() - start.getTime()) / 86_400_000),
  };
}

/**
 * How to say it.
 *
 * Relative while that is the more useful sentence, absolute once it is not.
 * "Arriving tomorrow" is what makes someone leave the box by the door;
 * "arriving 2026-08-25" makes them do the subtraction themselves.
 *
 * A past estimate says "expected" rather than "arrived": the receipt's guess is
 * the only thing here, and claiming a delivery landed on the strength of an
 * estimate would be inventing a fact.
 */
export function arrivalLabel(a: Arrival, locale?: string): string {
  if (a.daysAway === 0) return "arriving today";
  if (a.daysAway === 1) return "arriving tomorrow";
  if (a.daysAway === -1) return "was due yesterday";
  if (a.daysAway < -1) return `was due ${formatDate(a.date, locale)}`;
  // Inside a week a weekday is how people actually think about a delivery.
  if (a.daysAway <= 6) {
    return `arriving ${localMidnight(a.date).toLocaleDateString(locale, { weekday: "long" })}`;
  }
  return `arriving ${formatDate(a.date, locale)}`;
}

function formatDate(d: string, locale?: string): string {
  return localMidnight(d).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
