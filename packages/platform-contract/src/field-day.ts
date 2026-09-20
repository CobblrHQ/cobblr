// What day a date field's value names. One reading, for every reader.
//
// A date field's value arrives through many doors (a form, a scan's
// catalogue answer, an importer, an assistant) and is read by as many: the
// kernel's calendar query, the expiry sweeper, the dashboard's due feed, the
// vending wall, the record page. Each read it its own way. A tea box filed by
// a barcode scan carried Best before "2028-02", the month as the box prints
// it. Postgres cannot cast that to a date, so the sweeper's one query over the
// whole parts table threw, the kernel read the throw as "no rows", and every
// expiry reminder in the workspace stopped for twelve days while the fridge
// held twenty-five perfectly dated groceries (#3279). The dashboard's regex
// called the same value "none" and dropped it; Date.parse called it the first
// of the month. Three readers, three answers, none of them saying so.
//
// So this is the one place a date field's value becomes a day:
//   · a full ISO day, or anything that starts with one (an ISO timestamp), is
//     that day;
//   · a month alone, YYYY-MM, is the LAST day of that month: a best-before
//     month on packaging means good through the end of it;
//   · anything else is unreadable: null here, never a throw, and a reader
//     that gets null says the value could not be read rather than dropping
//     the record on the floor.
// The kernel's SQL does not cast at all; it hands the text to this rule.

const FULL_DAY = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The day (YYYY-MM-DD) a date field's value names, or null when it names
 *  none. Pure. */
export function fieldDay(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const full = FULL_DAY.exec(s);
  if (full) {
    const [, y, m, d] = full;
    const year = Number(y), month = Number(m), day = Number(d);
    return validDay(year, month, day) ? `${y}-${m}-${d}` : null;
  }
  const monthOnly = MONTH_ONLY.exec(s);
  if (monthOnly) {
    const [, y, m] = monthOnly;
    const year = Number(y), month = Number(m);
    if (month < 1 || month > 12) return null;
    return `${y}-${m}-${pad(daysInMonth(year, month))}`;
  }
  return null;
}

/** True when the value is there but names no day: the case a reader must
 *  SAY rather than skip. Empty is not unreadable; it is simply unset. */
export function fieldDayUnreadable(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return fieldDay(value) === null;
}
