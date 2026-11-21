// How many links a workspace already holds that are not web addresses (#9709).
// The schemas take only http and https now (webLink), but rows saved before
// that may hold javascript: or data:. They are never rewritten or deleted (a
// person's own data, and the page shows them as text through safeHref); a
// module's count pass reports them on /healthz until they are gone.
import { sql, type Kysely } from "kysely";

/** Rows of `table` made before `since` whose `column` holds a link that is
 *  not a web address (anything not starting http:// or https://, as WEB_LINK
 *  reads it; an empty value is no link). */
export async function nonWebLinkCount(db: Kysely<never>, table: string, column: string, since: Date): Promise<number> {
  const at = sql.ref(column);
  const rows = await sql<{ n: string }>`
    select count(*)::text as n from ${sql.table(table)}
     where ${at} is not null and ${at} <> '' and ${at} !~* '^https?://' and created_at < ${since}`.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}
