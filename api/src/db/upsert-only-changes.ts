// An upsert that writes a row only when it would change it (#7345).
//
// `ON CONFLICT … DO UPDATE SET …` rewrites the row even when every value is
// the one it already holds: a new tuple, WAL, a dead row to vacuum, a row lock.
// The boot's registry sync did that to every kind, action, command and module
// on every boot (about 400 rows on a one-workspace install), while the repo
// rule for a boot reconcile is "cheap when settled". Put this in the update's
// WHERE and a settled row is left alone; a changed one is written as before.
//
// Compare only the columns the update sets: a whole-row compare would always
// differ on a column the insert leaves to its default (created_at). Every
// column compared must have an equality operator (jsonb does, json does not).
import { sql, type Expression, type SqlBool } from "kysely";

export function anyColumnChanges(table: string, columns: readonly string[]): Expression<SqlBool> {
  if (columns.length === 0) throw new Error(`anyColumnChanges(${table}): no columns to compare`);
  const current = sql.join(columns.map((c) => sql.ref(`${table}.${c}`)));
  const incoming = sql.join(columns.map((c) => sql.ref(`excluded.${c}`)));
  return sql<SqlBool>`(${current}) is distinct from (${incoming})`;
}
