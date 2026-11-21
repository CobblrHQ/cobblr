// How many pictures a workspace already holds that the picture rule refuses
// (#4115). The writers and the schemas take only a file in the workspace or an
// https address now (image-reference), but a row saved before that may hold
// javascript:, data:, plain http or another site's address. Such a row is never
// rewritten or deleted (a person's own data), and the page never draws it
// (drawablePicture, in useImageSrc); a module's count pass reports it on
// /healthz until it is gone.
import { sql, type Kysely } from "kysely";

/** Rows of `table` made before `since` whose `column` holds a picture the rule
 *  refuses: another site's address with no scheme, a control character, or a
 *  scheme other than https. An empty value is no picture. */
export async function nonPictureCount(db: Kysely<never>, table: string, column: string, since: Date): Promise<number> {
  const at = sql.ref(column);
  const rows = await sql<{ n: string }>`
    select count(*)::text as n from ${sql.table(table)}
     where ${at} is not null and ${at} <> '' and created_at < ${since}
       and (btrim(${at}) ~ '^[\\/][\\/]'
            or ${at} ~ '[[:cntrl:]]'
            or (btrim(${at}) ~* '^[a-z][a-z0-9+.-]*:' and btrim(${at}) !~* '^https://[^/\\s]'))`.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}
