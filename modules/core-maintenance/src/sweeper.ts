// "Due-soon" sweeper — once an hour, every tenant DB gets a quick
// pass for maintenance entries with `scheduled_at` within
// DUE_SOON_DAYS that we haven't notified about for the current
// scheduled_at value. For each match we:
//
//   1. Emit core-maintenance.entry.due-soon (so users can wire
//      additional behaviour — slack post, email, anything).
//   2. Dispatch an in-app notification to every workspace member
//      so the bell badge picks it up automatically. No wire
//      required for the default UX.
//   3. Stamp last_notified_at = scheduled_at so we don't re-notify
//      until the user reschedules.
//
// One sweep per hour is deliberately gentle — these notifications
// drive "service the dryer this week", not "page someone now". For
// time-of-day precision later, swap the interval for a daily-at-8am
// schedule.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // 1 hour
const DUE_SOON_DAYS = 7;

export function startMaintenanceSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  // First sweep on boot — after a small delay so the platform has
  // finished wiring up modules + the queue.
  setTimeout(safeTick, 30_000);
  console.log(
    `[core-maintenance] due-soon sweeper started — every ${TICK_MS / 60_000} min, threshold ${DUE_SOON_DAYS}d`,
  );
}

export function stopMaintenanceSweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[core-maintenance] sweeper stopped");
  }
}

async function safeTick(): Promise<void> {
  try {
    await tick();
  } catch (err) {
    console.error(
      "[core-maintenance] sweeper tick failed:",
      (err as Error).stack ?? (err as Error).message,
    );
  }
}

interface OrgRow {
  id: string;
}

interface DueRow {
  id: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  scheduled_at: Date;
}

/** Single sweep — exported so tests can fire it deterministically.
 *  Per-org isolation: each tenant's notify state is independent. */
export async function tick(opts: { orgId?: string } = {}): Promise<{
  scanned: number;
  notified: number;
}> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  // Only sweep orgs that have core-maintenance enabled — orgs that
  // never installed the module don't have `core_maintenance_entries`
  // and would throw "relation does not exist" on every tick. Presence
  // of an org_modules row is the enabled signal (no enabled flag —
  // disable deletes the row).
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules", "org_modules.org_id", "orgs.id")
    .select(["orgs.id"])
    .where("org_modules.module_name", "=", "core-maintenance");
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);
  let orgs: OrgRow[];
  try {
    orgs = (await orgsQ.execute()) as OrgRow[];
  } catch (err) {
    // Connection pool exhaustion during heavy migrations on dev
    // envs with many tenant DBs. Bail this tick; the next one will
    // try again once pressure clears.
    console.warn(
      "[core-maintenance] sweeper skipped — meta read failed:",
      (err as Error).message,
    );
    return { scanned: 0, notified: 0 };
  }

  let scanned = 0;
  let notified = 0;

  for (const org of orgs) {
    try {
      // withDb releases the org's pool as soon as this closure returns. A
      // bare getDb + releaseIdleDb pair could never release its own pool
      // (the sweep's access sat inside the release grace window), so this
      // sweep held one pool per tenant and exhausted Postgres on boxes
      // with many tenants.
      await platform().tenants.withDb(org.id, async (raw) => {
    const tdb = raw as Kysely<unknown>;
    let due: DueRow[];
    try {
      const compiled = sql<DueRow>`
        select id, entity_module, entity_type, entity_id, name, scheduled_at
        from core_maintenance_entries
        where scheduled_at is not null
          and performed_at is null
          and (last_notified_at is null or last_notified_at < scheduled_at)
          and scheduled_at <= (now() + ${DUE_SOON_DAYS} * interval '1 day')
      `.compile(tdb);
      const result = (await tdb.executeQuery(compiled)) as { rows: DueRow[] };
      due = result.rows;
    } catch (err) {
      // Migration may not have applied yet on this tenant (the
      // 0002_last_notified column is new). Silently skip — next
      // tick will catch up once the migrator finishes.
      const msg = (err as Error).message;
      if (
        msg.includes("does not exist") ||
        msg.includes("last_notified_at")
      ) {
        return;
      }
      throw err;
    }

    scanned += due.length;
    if (due.length === 0) return;

    const memberIds = await platform().notifications.orgMemberIds(org.id);

    for (const row of due) {
      const daysUntil = Math.ceil(
        (new Date(row.scheduled_at).getTime() - Date.now()) / 86_400_000,
      );
      const tone =
        daysUntil < 0
          ? `overdue by ${-daysUntil}d`
          : daysUntil === 0
            ? "due today"
            : `due in ${daysUntil}d`;
      const message = `${row.name} — ${tone}`;

      // Event for user-authored wires.
      void platform().events.emit("core-maintenance.entry.due-soon", {
        orgId: org.id,
        entryId: row.id,
        entityModule: row.entity_module,
        entityType: row.entity_type,
        entityId: row.entity_id,
        scheduledAt: row.scheduled_at,
        daysUntil,
      });

      // In-app notification to every workspace member.
      for (const userId of memberIds) {
        try {
          await platform().notifications.dispatch({
            orgId: org.id,
            userId,
            eventType: "maintenance.due-soon",
            // Due on a date, knowable in advance: the morning brief, not a ping.
            triggeredBy: "schedule",
            message,
            module: "core-maintenance",
            entityType: row.entity_type,
            entityId: row.entity_id,
            payload: {
              entryId: row.id,
              daysUntil,
              scheduledAt: row.scheduled_at,
            },
          });
        } catch (err) {
          console.error(
            "[core-maintenance] notify dispatch failed:",
            (err as Error).message,
          );
        }
      }

      // Mark notified so we don't re-fire next tick.
      try {
        const update = sql`
          update core_maintenance_entries
          set last_notified_at = ${new Date(row.scheduled_at)}
          where id = ${row.id}
        `.compile(tdb);
        await tdb.executeQuery(update);
      } catch (err) {
        console.error(
          "[core-maintenance] mark-notified failed:",
          (err as Error).message,
        );
      }
      notified += 1;
    }
      });
    } catch (err) {
      // Per-org isolation: a gone/unprovisioned tenant or one bad org must
      // not abort the sweep for everyone else (CLAUDE.md §8.1).
      console.warn(
        `[core-maintenance] sweep skipped org ${org.id}:`,
        (err as Error).message,
      );
    }
  }

  if (notified > 0) {
    console.log(
      `[core-maintenance] sweeper: scanned ${scanned}, notified ${notified} entries`,
    );
  }
  return { scanned, notified };
}
