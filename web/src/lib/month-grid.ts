// Shared month-grid math for the workspace calendar (/calendar) and the
// core-views `calendar` saved-view renderer. Kept pure + dependency-free so
// both surfaces render identical grids.

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Format the LOCAL date as YYYY-MM-DD. NOT toISOString() — that converts to
 *  UTC and would shift grid cells (built as local midnight) by a day in
 *  negative-offset timezones. */
export const isoLocal = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A 6-row × 7-col month grid (Sun-first), padded into adjacent months.
 *  `gridStart`/`gridEnd` are the first/last visible day — handy for bounding a
 *  data fetch to exactly what the grid shows. */
export function buildMonthGrid(
  year: number,
  month: number,
): { weeks: Date[][]; gridStart: Date; gridEnd: Date } {
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay()); // back up to Sunday
  const weeks: Date[][] = [];
  const cur = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  const gridEnd = new Date(cur);
  gridEnd.setDate(gridEnd.getDate() - 1);
  return { weeks, gridStart, gridEnd };
}

/** Shift a {y,m} cursor by N months. */
export function shiftMonth(c: { y: number; m: number }, by: number): { y: number; m: number } {
  const d = new Date(c.y, c.m + by, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}
