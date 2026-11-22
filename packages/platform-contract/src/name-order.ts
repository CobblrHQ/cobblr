// A list ordered by name sorts the way people count and read (#9713).
//
// Postgres compared names a byte at a time, so "Hex bolt M10" sat above "Hex
// bolt M2" and "Écrou M5" below "Flange nut M5", on every list the server
// orders and pages: the page cannot re-sort 100 rows of thousands. Ordered
// through the cobblr_natural collation instead (ICU, numeric ordering: M2,
// M8, M10; É with E; case ignored), which each module that sorts by name
// creates in its workspace's database by migration, falling back to the old
// byte order on a cluster built without ICU so the queries always run.
//
// The keyset cursor compares through the same collation (nameAfter), or a
// page skips rows or repeats them. The code:name-order capabilities row
// refuses a bare orderBy("name") in a module.
import { sql, type RawBuilder } from "kysely";

/** The collation every name sort goes through, created per workspace
 *  database by each module that sorts by name (its migration says how). */
export const NAME_COLLATION = "cobblr_natural";

/** The columns a person reads as a name: sorted through the collation. */
const NAME_COLUMNS = new Set(["name", "title", "short_name", "display_name"]);

const bare = (column: string) => column.slice(column.lastIndexOf(".") + 1);

/** A name column, as a sort key that orders the way people count. */
export function byName(column: string): RawBuilder<string> {
  return sql<string>`${sql.ref(column)} collate ${sql.id(NAME_COLLATION)}`;
}

/** The sort key for a column a list may be sorted by: a name or title
 *  column through the collation, any other column as it is (a number or a
 *  date has its own order, and a text collation on one is an error). */
export function orderKey(column: string): string | RawBuilder<string> {
  return NAME_COLUMNS.has(bare(column)) ? byName(column) : column;
}

/** The keyset cursor's "after this row" for a list ordered by (name, id):
 *  compared through the same collation as the ORDER BY, so no page skips a
 *  row or repeats one. */
export function nameAfter(nameColumn: string, idColumn: string, name: string, id: string): RawBuilder<boolean> {
  return sql<boolean>`(${byName(nameColumn)}, ${sql.ref(idColumn)}) > (${name}::text collate ${sql.id(NAME_COLLATION)}, ${id})`;
}
