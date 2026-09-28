// Searching the scan inbox: which waiting rows a typed word finds, and which
// of them are headed for one table.
//
// A thing scanned but not yet filed was invisible to search: the palette
// asked every table and the inbox is not one, so "voron" found the files
// named after it and not the Voron waiting to be filed (#3823). The inbox read
// takes `q` (and a `destination` beside it); these two rules decide the
// answer, pure so a test holds them without a database.
import { withPersonName } from "./user-name.js";

export interface SearchableRow {
  suggested_name: string | null;
  suggested_metadata?: unknown;
  barcode_text?: string | null;
  suggested_manufacturer?: string | null;
}

/** The row answers to `q` when the name the card shows (the person's own
 *  name first; a name they turned down is no name), its code, or its maker
 *  contains it, any case. */
export function rowMatchesText(row: SearchableRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const named = withPersonName({ suggested_name: row.suggested_name, suggested_metadata: row.suggested_metadata });
  return [named.suggested_name, row.barcode_text, row.suggested_manufacturer].some(
    (v) => typeof v === "string" && v.toLowerCase().includes(needle),
  );
}

/** The row is headed for `table` (an instance's name, or a module's for its
 *  default table) by its ONE resolved destination, the one the card shows
 *  and filing uses. A row with no destination is headed nowhere. */
export function headedFor(served: object, table: string): boolean {
  const d = (served as { resolved_destination?: { module: string; instance: string | null } | null }).resolved_destination;
  if (!d) return false;
  return (d.instance ?? d.module) === table;
}
