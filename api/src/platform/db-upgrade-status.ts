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
import { sendAuthEmail } from "./hosted-seams.js";

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
  try {
    await client.connect();
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
    // Missing table (the normal, healthy case) or an unreachable maintenance
    // DB — either way there is nothing to report from HERE; a genuinely down
    // database is already screaming through every other connection.
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
  const admins = (env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const to of admins) {
    await sendAuthEmail({
      to,
      kind: "notification",
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
}

/** Check once at boot, then daily while the process lives. Silent unless the
 *  database image reported a held-back major upgrade. */
export function startDbUpgradeHoldWatch(): void {
  if (timer) return; // already running — a second call must not orphan the first interval
  void checkAndAlert();
  timer = setInterval(() => void checkAndAlert(), CHECK_INTERVAL_MS);
  timer.unref?.();
}
