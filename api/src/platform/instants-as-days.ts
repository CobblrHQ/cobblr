// A moment stored in a date field, read as the person's day (#8789).
//
// Sales stamps paid_at, fulfilled_at and shipped_at with the moment they
// happened and declares them date fields. An order marked Paid at 11:05 pm on
// the 27th in New York was stamped 03:05 on the 28th in UTC, and three places
// said it three ways: the page read the person's day (the 27th), History and
// the export read the UTC date (the 28th). At a month's end the order fell in
// the next month in two of them. A day fact is read in the person's own day
// wherever it is said; this is the one conversion, for the doors that read
// the stored moment (the history sentence, the export).

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The person's day for a stored moment, or null when the value is not a moment (a plain day stands as written). */
export async function instantAsDay(value: unknown, dayOf: (at: Date) => Promise<string>): Promise<string | null> {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dayOf(value);
  if (typeof value === "string" && INSTANT.test(value)) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : dayOf(at);
  }
  return null;
}

/** An export's or a history's rows with the date fields' moments turned to the person's days. */
export async function rowsInTheirDays<T extends { fields: Record<string, unknown> }>(rows: readonly T[], dateFields: readonly string[], dayOf: (at: Date) => Promise<string>): Promise<T[]> {
  if (!dateFields.length) return [...rows];
  return Promise.all(
    rows.map(async (row) => {
      let fields: Record<string, unknown> | null = null;
      for (const name of dateFields) {
        const day = await instantAsDay(row.fields[name], dayOf);
        if (day) (fields ??= { ...row.fields })[name] = day;
      }
      return fields ? { ...row, fields } : row;
    }),
  );
}
