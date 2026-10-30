// Since when this process could hear its bridges, so the bridge outage notice
// never blames a bridge for the server's own outage.
//
// A bridge is "quiet" when its heartbeat has not landed in edge_bridges for
// ten minutes. That is also exactly what a server whose database is down looks
// like: on 2026-10-30 the hosted service's database filled its disk, heartbeat writes
// and requests failed in bursts for over an hour, and the owners were told a
// bridge that was answering the whole time had "stopped answering". Silence
// only counts from the last moment this process itself was failing: a database
// error on a request, a heartbeat that could not be written, a watch round that
// could not run, a stretch the process was stalled, and its own start.
//
// Process-local on purpose, like error-rate.ts: every api process shares the
// database, so a database outage is seen by every process that serves anything,
// and each process's own watch round is a database caller too.

let troubleAt = Date.now();

/** This process could not have heard a bridge at `at`. */
export function couldNotHear(at: number = Date.now()): void {
  if (at > troubleAt) troubleAt = at;
}

/** The moment from which a bridge's silence is the bridge's, not ours. */
export function heardWellSince(): Date {
  return new Date(troubleAt);
}

// SQLSTATE classes that are the database failing, not the request being wrong:
// 08 connection, 53 insufficient resources (disk full, out of memory, too many
// connections), 57 operator intervention (shutdown, crash recovery), 58 system
// error, XX internal error.
const DATABASE_FAULT = /^(08|53|57|58|XX)/;
const CONNECTION_FAULT = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|timeout exceeded when trying to connect|the database system is (starting up|shutting down|in recovery mode)/i;

/** Whether an error is the database failing (so the server could not record
 *  anything), as opposed to a query or a caller being wrong. */
export function isDatabaseFault(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (typeof e.code === "string" && e.code.length === 5 && DATABASE_FAULT.test(e.code)) return true;
  if (typeof e.code === "string" && CONNECTION_FAULT.test(e.code)) return true;
  return typeof e.message === "string" && CONNECTION_FAULT.test(e.message);
}

/** Note an error a request ended on, if it was the database failing. */
export function noteServerFault(err: unknown, at: number = Date.now()): void {
  if (isDatabaseFault(err)) couldNotHear(at);
}

/** Tests only. */
export function resetHearing(at: number): void {
  troubleAt = at;
}
