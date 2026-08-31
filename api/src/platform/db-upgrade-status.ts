// The database image (docker/db-auto-upgrade.sh) refuses to strand an
// instance: when a major upgrade cannot proceed safely — pre-flight failure,
// pg_upgrade failure, or the operator set COBBLR_DB_MAJOR_UPGRADE=hold — it
// keeps SERVING the old Postgres major and records why in a `cobblr_db_status`
// row in the `postgres` maintenance database.
//
// This is the API half of that contract: surface the held-back state to the
// operator (a loud log line + an email to SUPERADMIN_EMAILS, on boot and then
// daily while it persists) and stay silent otherwise. On a healthy instance
// the table does not even exist; the check costs one short-lived connection
// per boot/day. The db entrypoint clears the row on the first successful boot
// at the target major, so the alert shuts itself off.
//
// PERMANENT RECONCILE — not a one-shot shim: every future major bump can hold.

import { Client } from "pg";
import { env } from "../env.js";
import { notifyOperators } from "./operator-alert.js";
import { runExclusive } from "./exclusive.js";

export interface DbUpgradeHold {
  reason: string;
  detail: string;
  oldMajor: number;
  targetMajor: number;
  since: Date;
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export async function readDbUpgradeHold(): Promise<DbUpgradeHold | null> {
  // The row lives in the `postgres` maintenance DB — the one database that
  // exists on every instance from first boot — so connect there with the same
  // credentials the meta pool uses.
  const url = new URL(env.DATABASE_URL);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  client.on("error", (err) => console.error("[db-upgrade-status] connection error:", (err as Error).message));
  try {
    await client.connect();
    // ASK whether the table is there before selecting from it. On a healthy
    // instance it does not exist, and a SELECT against a missing relation is
    // an ERROR the SERVER logs even though the catch below swallows it here.
    // That made `relation "cobblr_db_status" does not exist` the first line in
    // the database log of every new install, which teaches people that
    // Cobblr's database errors are normal noise. `to_regclass` answers null
    // instead of raising. The db entrypoint learned this same lesson on its
    // DELETE (docker/db-auto-upgrade.sh); this is the read half of it.
    const present = await client.query<{ ok: boolean }>(
      "select to_regclass('public.cobblr_db_status') is not null as ok",
    );
    if (!present.rows[0]?.ok) return null;
    const r = await client.query<{
      reason: string | null;
      detail: string | null;
      old_major: number | null;
      target_major: number | null;
      since: Date;
    }>(
      "select reason, detail, old_major, target_major, since from cobblr_db_status where key = 'major_upgrade' and held",
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      reason: row.reason ?? "unknown",
      detail: row.detail ?? "",
      oldMajor: row.old_major ?? 0,
      targetMajor: row.target_major ?? 0,
      since: row.since,
    };
  } catch {
    // An unreachable maintenance DB, or a table that vanished between the two
    // statements. Either way there is nothing to report from HERE, and a
    // genuinely down database is already screaming through every other
    // connection. The healthy no-table case no longer comes through here.
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkAndAlert(): Promise<void> {
  const hold = await readDbUpgradeHold();
  if (!hold) return;
  console.error(
    `[db-upgrade] HELD BACK (${hold.reason}): the database image could not upgrade ` +
      `Postgres ${hold.oldMajor} -> ${hold.targetMajor} and is serving the OLD major instead. ` +
      `${hold.detail} The upgrade retries on the next database container start once the ` +
      `cause is resolved. See docs/operations/PRODUCTION_DEPLOY.md (major Postgres upgrades).`,
  );
  await notifyOperators({
    subject: `[Cobblr] Database major upgrade is held back (Postgres ${hold.oldMajor} -> ${hold.targetMajor})`,
    text: [
      `This Cobblr instance's database image wants to upgrade PostgreSQL ${hold.oldMajor} -> ${hold.targetMajor},`,
      `but the upgrade could not proceed safely, so it is still serving PostgreSQL ${hold.oldMajor}`,
      `from the untouched existing cluster. Nothing is broken and no data was modified.`,
      ``,
      `Reason: ${hold.reason}`,
      `Detail: ${hold.detail}`,
      `Held since: ${hold.since.toISOString()}`,
      ``,
      `What to do: resolve the cause above, then restart the database container —`,
      `the upgrade runs automatically on boot and this alert clears itself.`,
      `To keep holding deliberately, set COBBLR_DB_MAJOR_UPGRADE=hold; this email`,
      `repeats daily while the hold is in place.`,
      ``,
      `Runbook: docs/operations/PRODUCTION_DEPLOY.md (major Postgres upgrades).`,
    ].join("\n"),
  });
}

/** Check once at boot, then daily while the process lives. Silent unless the
 *  database image reported a held-back major upgrade. */
export function startDbUpgradeHoldWatch(): void {
  if (timer) return; // already running — a second call must not orphan the first interval
  void checkAndAlert();
  // One process only: the alert goes to an operator channel, and two apis
  // share one database on the canary channel — without this the operator gets
  // the same "database held back" alert twice per interval.
  timer = setInterval(
    () => void runExclusive("platform.db-upgrade-alert", checkAndAlert).catch(() => {}),
    CHECK_INTERVAL_MS,
  );
  timer.unref?.();
}
