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

const TICK_MS = 60 * 60 * 1000; // 1 hour
export const MAINTENANCE_PASS = "core-maintenance.sweep";
const DUE_SOON_DAYS = 7;

export function startMaintenanceSweeper(): void {
  // The walk is the kernel's (platform().sweeps, #3036): this registers the
  // per-workspace visit and its cadence and owns no timer, so the pass shares
  // one walk and one connection budget with every other pass.
  platform().sweeps.register({
    name: MAINTENANCE_PASS,
    everyMs: TICK_MS,
    module: "core-maintenance",
    visit: ({ orgId, db }) => visitWorkspace(orgId, db),
  });
  console.log(
    `[core-maintenance] due-soon sweeper registered — every ${TICK_MS / 60_000} min, threshold ${DUE_SOON_DAYS}d`,
  );
}

/** Nothing to stop: the kernel's walk owns the timer. Kept for the module's shutdown hook. */
export function stopMaintenanceSweeper(): void {}

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
  const run = await platform().sweeps.run(MAINTENANCE_PASS, { orgIds: opts.orgId ? [opts.orgId] : undefined });
  let scanned = 0;
  let notified = 0;
  for (const { result } of run.results) {
    const r = result as Partial<{ scanned: number; notified: number }> | void;
    scanned += r?.scanned ?? 0;
    notified += r?.notified ?? 0;
  }
  if (notified > 0) {
    console.log(
      `[core-maintenance] sweeper: scanned ${scanned}, notified ${notified} entries`,
    );
  }
  return { scanned, notified };
}

/** One workspace, the pool already open: the pass's visit. `org` and `raw`
 *  keep their names so the body reads as it did when it was the loop's. */
async function visitWorkspace(orgId: string, raw: unknown): Promise<{ scanned: number; notified: number } | void> {
  const org = { id: orgId };
  let scanned = 0;
  let notified = 0;
  {
    {
      {
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

    // One message for the whole sweep, not one per entry. A workspace with a
    // dozen machines has a dozen things due on the same morning, and twelve
    // separate notifications saying the same kind of thing is a stream nobody
    // reads to the end. The per-entry EVENT above stays per-entry - a wire
    // wants each one - but a person gets the list.
    const lines: string[] = [];
    /** The single entry, when there is exactly one, so the notification can
     *  still deep-link to it. A list of twelve has nowhere to point. */
    let only: (typeof due)[number] | null = null;

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

      lines.push(message);
      only = lines.length === 1 ? row : null;

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

    if (lines.length > 0) {
      const message =
        lines.length === 1
          ? lines[0]!
          : `${lines.length} things need maintenance:\n${lines.join("\n")}`;
      // WHERE IT TAKES YOU. One entry → the thing that needs servicing, which
      // is where you would go to deal with it; several → the maintenance page,
      // which lists exactly what is due. It used to carry no link at all, so
      // "your mower is due for service" was a sentence you could not act on.
      // PAGE-LINK: several entries at once; the maintenance list IS the set.
      let link = "/maintenance";
      if (only?.entity_type && only.entity_id) {
        link =
          (await platform()
            .entities.detailPathForEntity(org.id, only.entity_type, only.entity_id)
            .catch(() => undefined)) ?? "/maintenance";
      }
      for (const userId of memberIds) {
        try {
          await platform().notifications.dispatch({
            orgId: org.id,
            userId,
            eventType: "maintenance.due-soon",
            // Due on a date, knowable in advance: the morning brief, not a ping.
            triggeredBy: "schedule",
            message,
            link_url: link,
            module: "core-maintenance",
            entityType: only?.entity_type,
            entityId: only?.entity_id,
            // ANSWER IT WHERE YOU READ IT. A single due entry is a yes/no
            // question - did you do it? - and the action to say yes already
            // exists. Declaring it here is all a notification needs to become
            // pressable, in the bell and in a Discord DM alike.
            ...(only
              ? {
                  actions: [
                    {
                      id: "done",
                      label: "Mark done",
                      action: "core-maintenance:complete",
                      args: { entry_id: only.id },
                      style: "primary" as const,
                    },
                  ],
                }
              : {}),
            payload: only
              ? { entryId: only.id, count: 1, scheduledAt: only.scheduled_at }
              : { count: lines.length },
          });
        } catch (err) {
          console.error(
            "[core-maintenance] notify dispatch failed:",
            (err as Error).message,
          );
        }
      }
    }
      }
    }
  }
  return { scanned, notified };
}
