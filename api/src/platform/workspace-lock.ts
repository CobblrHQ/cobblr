// One of a kind of work at a time, per workspace.
//
// Some writes check what exists and then make it across many tables (a bundle
// install: its fields, wires, views, catalogs, apps). Two at once both see
// nothing and the second fails on a unique key half way, a 500 for something
// that, by then, is installed. A transaction-scoped advisory lock keyed on the
// work and the workspace makes the second wait for the first and then see it,
// so it takes the reinstall path like any later press would (#4922 sweep).
//
// The lock is held by its own transaction for as long as `fn` runs, while `fn`
// works on other connections. It is not re-entrant across connections: never
// call `fn` again under the same key from inside itself.
import { sql } from "kysely";
import { meta } from "../db/meta.js";

export async function withWorkspaceLock<T>(orgId: string, work: string, fn: () => Promise<T>): Promise<T> {
  return meta.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${work}:${orgId}`}, 0))`.execute(trx);
    return fn();
  });
}
