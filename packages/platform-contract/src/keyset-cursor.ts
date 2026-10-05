// The page cursor of a newest-first list keyed on a timestamp and an id:
// `<time, to the millisecond>|<id>`. One encoder, so every list agrees on it.
//
// THE MILLISECOND IS THE WHOLE RULE. Postgres keeps a timestamptz to the
// microsecond; a JavaScript Date, and so the cursor, keeps the millisecond. A
// query that orders on the raw column and compares it with the cursor skips
// every row that falls inside the last row's millisecond but below its
// microsecond: `created_at = cursor` is false for both, and `created_at <
// cursor` is false for the rows just after it. A workspace's activity walked
// page by page came up one entry short of its own total (54 of 55), on the
// days two entries were written in one millisecond.
//
// So the query that reads a cursor orders and compares on the millisecond,
// with the id breaking a tie, exactly the precision the cursor carries:
//
//   .orderBy(sql`date_trunc('milliseconds', created_at)`, "desc").orderBy("id", "desc")
//   .where(sql`(date_trunc('milliseconds', created_at), id) < (${c.at}, ${c.id})`)
//
// lint:keyset-cursor-on-the-millisecond refuses a cursor built by hand from
// toISOString(), and a file that encodes one without that ordering.

/** The cursor for the last row of a page. */
export function encodeKeysetCursor(at: Date | string, id: string | number): string {
  return `${new Date(at).toISOString()}|${id}`;
}

/**
 * A cursor read back, or null when it is not one. `id` is null for the older
 * time-only cursors some lists handed out, which then page on time alone.
 */
export function decodeKeysetCursor(cursor: string | null | undefined): { at: Date; id: string | null } | null {
  if (!cursor) return null;
  const bar = cursor.indexOf("|");
  const at = new Date(bar < 0 ? cursor : cursor.slice(0, bar));
  if (Number.isNaN(at.getTime())) return null;
  const id = bar < 0 ? "" : cursor.slice(bar + 1);
  return { at, id: id || null };
}

// A FORWARD cursor ("what changed since") is the other shape, and the
// millisecond is wrong for it. A page cursor walks rows that are already
// there, with the id breaking a tie; a since-cursor is handed back to ask for
// rows that arrive LATER, and a later row stamped inside the same millisecond
// is exactly the one a truncated compare would skip. Kept at the database's
// own precision instead, built and compared in SQL and never parsed into a
// Date: the scan feed's cursor did go through a Date, sat just below a row
// stamped by now(), and handed the same scan back on every poll (#4916).
//
//   select ${sql.raw(sinceCursorSql("greatest(created_at, updated_at)"))} as cursor_at
//   where greatest(created_at, updated_at) > ${after}::timestamptz
//
// The cursor is opaque to a client: an ISO string it hands back unchanged.

/** The SQL (a raw expression, built only from code) that renders a
 *  timestamptz expression as a since-cursor, to the microsecond, in UTC. */
export function sinceCursorSql(expression: string): string {
  return `to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Where a since-cursor starts: before everything. */
export const SINCE_CURSOR_START = "1970-01-01T00:00:00.000000Z";

/** The newest of a page's since-cursors (fixed-width, so they compare as
 *  text), or null for an empty page. */
export function latestSinceCursor(cursors: ReadonlyArray<string | null | undefined>): string | null {
  let high: string | null = null;
  for (const c of cursors) if (c && (!high || c > high)) high = c;
  return high;
}
