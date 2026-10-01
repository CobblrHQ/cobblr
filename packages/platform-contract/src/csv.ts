// One way to write a CSV cell and a CSV file, for every export in the
// product. Three exporters each kept their own copy and they had drifted: one
// did not quote a carriage return, and none guarded against a cell a
// spreadsheet runs as a formula. A row whose name is `=HYPERLINK(...)` or
// `@SUM(...)` must open as the text it is, not as something the spreadsheet
// executes (CSV injection), so a text cell that starts with = + - @ or a tab
// or carriage return is written with a leading apostrophe, which every
// spreadsheet reads as "this is text" and does not display. Numbers are
// written as they are: -5 is a number, not a formula.

const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, RFC 4180: quoted when it holds a quote, a comma, a line break or
 *  edge spaces, with quotes doubled. Null and undefined are empty. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number" || typeof value === "bigint") text = String(value);
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") text = FORMULA_START.test(value) ? `'${value}` : value;
  else text = JSON.stringify(value);
  return csvCellAsWritten(text);
}

/** A cell read back from a file this module wrote, written again unchanged:
 *  quoted the way csvCell quotes, and never guarded a second time, because
 *  the writer already guarded its text (a bare -5 in that file is a number).
 *  For a pass that takes columns out of a finished export. */
export function csvCellAsWritten(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: a header row and data rows, CRLF line ends, and a byte order
 *  mark so a spreadsheet opens accented and non-Latin text as written. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>, opts: { bom?: boolean } = {}): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return (opts.bom === false ? "" : "﻿") + lines.join("\r\n") + "\r\n";
}

/** The response headers for a CSV download. `complete: false` (the list
 *  stopped at its cap) is said in a header the page reads, so a partial file
 *  is never taken for the whole collection. */
export function csvDownloadHeaders(filename: string, complete = true): Record<string, string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safe}"`,
    "X-Export-Complete": complete ? "true" : "false",
    "Access-Control-Expose-Headers": "Content-Disposition, X-Export-Complete",
    "Cache-Control": "no-store",
  };
}

/** A CSV text cell as it was before csvCell guarded it: the apostrophe in
 *  front of = + - @ comes off, so a file exported here and read back in names
 *  a record exactly as it was named. Any other text is left as written. */
export function unguardCsvText(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}
