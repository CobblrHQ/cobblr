// Which rows the sandbox reaper is allowed to touch.
//
// Split from try-sandbox.ts, and taking its `db`, for one reason: this is the
// query that DROPS DATABASES, so the test has to bind to the real thing rather
// than a copy of it. Importing try-sandbox.ts pulls in the env schema and the
// meta pool; a builder that takes its db compiles against a dummy driver, so
// the actual SQL can be asserted with no database and no environment.
import type { Kysely } from "kysely";

/** Just enough of the schema to build the query; the caller passes the real
 *  meta db, which is a superset. */
export interface ReapableOrgs {
  orgs: { id: string; slug: string; sandbox: boolean; trial_expires_at: Date | null };
}

/** Sandboxes past their hour, oldest first, bounded.
 *
 *  Three conditions, each load-bearing:
 *    `sandbox = true`        — set by GET /try alone, cleared when someone keeps
 *                              their workspace. The line between disposable and
 *                              somebody's work.
 *    `trial_expires_at < now`— prod, staging and self-host leave this NULL
 *                              everywhere, and NULL fails the comparison, so
 *                              their rows cannot match even if the flag leaked.
 *    `limit`                 — a backlog after a restart drains over several
 *                              ticks instead of dropping a hundred databases at
 *                              once on a four-core box.
 *
 *  Nothing else. In particular never a slug or name match: the day someone
 *  "improves" this by looking for workspaces that seem like sandboxes is the
 *  day it deletes one called Sandbox. */
export function expiredSandboxesQuery(db: unknown, limit: number, now: Date) {
  return (db as Kysely<ReapableOrgs>)
    .selectFrom("orgs")
    .select(["id", "slug"])
    .where("sandbox", "=", true)
    .where("trial_expires_at", "<", now)
    .orderBy("trial_expires_at", "asc")
    .limit(limit);
}
