// A change and its History line, committed together (#9035).
//
// A module route writes its record in the workspace's database and then logs
// the line to the server's: two writes, and a process dying between them lost
// the line for good while the change stood. Here the route writes inside one
// transaction on the workspace's database, and its line goes into that same
// transaction (core_activity_log_pending), so the two commit or fail as one.
// Right after the commit the line is sent to the server's database and its
// workspace copy removed, so History still shows it at once. A send that
// fails, or a process that dies before it, leaves the line where the History
// round finds it (activity-trace.ts: the workspace is marked first).
//
// A route reaches this as platform().activity.transaction; a bare
// platform().activity.log in a module's source fails lint:capabilities.
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterLogged, lineOf, log, type LogParams } from "./activity.js";
import { diesHereForTests, insertLine, lineWaiting, markForTrace, metaRefusedForTests, type ActivityLine } from "./activity-trace.js";

interface OutboxDB {
  core_activity_log_pending: { id: string; line: string };
}

/** Workspaces whose outbox table is there; one not yet migrated is asked
 *  again after a while. */
const ready = new Map<string, number | true>();
const RECHECK_MS = 5 * 60_000;

async function outboxReady(orgId: string, db: Kysely<unknown>): Promise<boolean> {
  const known = ready.get(orgId);
  if (known === true) return true;
  if (typeof known === "number" && Date.now() - known < RECHECK_MS) return false;
  const { rows } = await sql<{ there: boolean }>`select to_regclass('core_activity_log_pending') is not null as there`.execute(db);
  const there = !!rows[0]?.there;
  ready.set(orgId, there ? true : Date.now());
  return there;
}

export async function changeWithHistory<DB, T>(
  orgId: string,
  db: Kysely<DB>,
  work: (trx: Transaction<DB>, log: (p: LogParams) => Promise<void>) => Promise<T>,
): Promise<T> {
  // Its line is sent once this transaction commits, which an outer one would
  // not have done yet: a line for a change that may still roll back.
  if (db.isTransaction) throw new Error("activity.transaction takes the workspace's database, not a transaction: the change and its line commit in the one it opens");
  if (!(await outboxReady(orgId, db as unknown as Kysely<unknown>))) {
    // A workspace whose core-activity-log migration has not run yet: the
    // change, then its lines, as before.
    const later: LogParams[] = [];
    const result = await db.transaction().execute((trx) => work(trx, async (p) => void later.push(p)));
    for (const p of later) await log(p);
    return result;
  }
  await markForTrace(orgId);
  const kept: Array<{ id: string; p: LogParams }> = [];
  const result = await db.transaction().execute((trx) =>
    work(trx, async (p) => {
      // The record's own write is not committed yet, so the kept line says
      // what the caller says changed and reads nothing (lineOf's ownDiffOnly:
      // no second connection while this transaction holds one); the line
      // sent after the commit below reads the record as it now is, and the
      // titles of what it refers to.
      const { line } = await lineOf(p, { ownDiffOnly: true });
      const id = randomUUID();
      // Kept with the time it was made, so a line a round sends later lands
      // where it happened.
      const stored: ActivityLine = { ...line, trace_id: id, occurred_at: new Date().toISOString() };
      await (trx as unknown as Kysely<OutboxDB>).insertInto("core_activity_log_pending").values({ id, line: JSON.stringify(stored) }).execute();
      kept.push({ id, p });
    }),
  );
  for (const k of kept) {
    if (diesHereForTests(orgId, { action: k.p.action, entityId: k.p.ref.entityId })) throw new Error("the api died after the change committed, before its History line was sent (test)");
    const { line, write } = await lineOf(k.p);
    try {
      if (metaRefusedForTests(orgId)) throw new Error("the server's database refused the History line (test)");
      await insertLine({ ...line, trace_id: k.id });
    } catch (err) {
      console.error(`[activity] a History line for ${orgId} stays in the workspace until the server's database answers:`, err);
      lineWaiting(orgId);
      // The kept line is this write's line: the History write recording it
      // must not log a second one.
      if (write) write.logged = true;
      continue;
    }
    await (db as unknown as Kysely<OutboxDB>).deleteFrom("core_activity_log_pending").where("id", "=", k.id).execute();
    afterLogged(k.p, write);
  }
  return result;
}
