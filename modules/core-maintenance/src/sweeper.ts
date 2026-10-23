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

import type { AttentionSubject, NotificationAction, NotificationCardRow } from "@cobblr/platform-contract";
import { Kysely, sql } from "kysely";
import { loanOfFields } from "@cobblr/platform-contract/loan";
import { platform, countOf } from "@cobblr/platform-contract";
import type { CoreMaintenanceDB } from "./db.js";
import { reconcileSchedules } from "./schedules-store.js";
import { calendarDue, shouldNotify, cancelBy, type Reminder } from "./schedule.js";

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
  schedule_id: string | null;
  remind: Reminder | null;
  last_notified_at: Date | null;
  overdue_every: import("./schedule.js").OverdueCadence | null;
  nag_stopped_at: Date | null;
  nag_snoozed_until: Date | null;
  anchor: unknown;
  cancel_notice_days: number | null;
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
    // Schedules first (#3876): every schedule gets its open occurrence, dated
    // by its calendar or brought to now when its counter has passed the mark,
    // so the due pass below sees it like any other scheduled entry. The
    // reason is the schedule's own words ("overdue by 3 print hours").
    let reasons = new Map<string, string>();
    try {
      reasons = (await reconcileSchedules(raw as Kysely<CoreMaintenanceDB>, orgId)).reasons;
    } catch (err) {
      const msg = (err as Error).message;
      // A workspace whose schedules table is not made yet has nothing to
      // reconcile; anything else is a failure.
      if (!msg.includes("does not exist")) {
        platform().health.notePassFailure("core-maintenance.reconcile-schedules", orgId, err);
        console.error("[core-maintenance] schedules not reconciled:", msg);
      }
    }
    let due: DueRow[];
    try {
      const compiled = sql<DueRow>`
        select e.id, e.entity_module, e.entity_type, e.entity_id, e.name, e.scheduled_at, e.schedule_id, e.last_notified_at, s.remind, s.overdue_every, s.anchor, s.cancel_notice_days, e.nag_stopped_at, e.nag_snoozed_until
        from core_maintenance_entries e
        left join core_maintenance_schedules s on s.id = e.schedule_id
        where e.scheduled_at is not null
          and e.performed_at is null
      `.compile(tdb);
      const result = (await tdb.executeQuery(compiled)) as { rows: DueRow[] };
      const preferences = await (raw as Kysely<CoreMaintenanceDB>).selectFrom("core_maintenance_preferences").selectAll().executeTakeFirst();
      due = result.rows.filter((r) => shouldNotify(new Date(r.scheduled_at), r.remind, r.last_notified_at ? new Date(r.last_notified_at) : null, new Date(), {
        overdue_every: r.overdue_every ?? preferences?.overdue_every ?? "week",
        nag_stopped_at: r.nag_stopped_at ? new Date(r.nag_stopped_at) : null,
        nag_snoozed_until: r.nag_snoozed_until ? new Date(r.nag_snoozed_until) : null,
      }));
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
    const actions: NotificationAction[] = [];
    const cardRows: NotificationCardRow[] = [];
    const subjects: AttentionSubject[] = [];
    /** The single entry, when there is exactly one, so the notification can
     *  still deep-link to it. A list of twelve has nowhere to point. */
    let only: (typeof due)[number] | null = null;

    for (const row of due) {
      // A notification goes to everybody on the workspace, so there is no
      // one zone to read: the day that has arrived everywhere, the same count
      // the schedule's own reason uses.
      const { reason: tone, days: daysUntil } = calendarDue(new Date(row.scheduled_at), new Date(), null);
      const record = await platform().entities.lookup(org.id, `${row.entity_module}:${row.entity_type}`, row.entity_id);
      // Lent out: its reminders are paused, not spent. Left un-notified, the
      // entry speaks up on the first sweep after it is back.
      if (loanOfFields(record?.fields)) continue;
      const message = row.cancel_notice_days != null ? `Cancel ${record?.title ?? row.name} by ${cancelBy(new Date(row.scheduled_at), row.cancel_notice_days).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })} or it renews` : `${row.name}${record?.title ? ` on ${record.title}` : ""}: ${(row.schedule_id && reasons.get(row.schedule_id)) || tone}`;

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

      const rowActions: NotificationAction[] = [{
        id: `done-${row.id}`, label: row.anchor ? "Renewed" : "Mark done",
        action: "core-maintenance:complete", args: { entry_id: row.id }, style: "primary",
      }];
      if (daysUntil < 0) rowActions.push(
        { id: `week-${row.id}`, label: "Snooze 1 week", action: "core-maintenance:reminders", args: { entry_id: row.id, mode: "snooze", duration: "week" } },
        { id: `month-${row.id}`, label: "Snooze 1 month", action: "core-maintenance:reminders", args: { entry_id: row.id, mode: "snooze", duration: "month" } },
        { id: `stop-${row.id}`, label: "Stop reminding me", action: "core-maintenance:reminders", args: { entry_id: row.id, mode: "stop" } },
      );
      actions.push(...rowActions);
      cardRows.push({ text: message, actions: rowActions.map((a) => a.id) });
      lines.push(message);
      // One subject per obligation, not per record: two services due on one item are two
      // things to say, and the day's claim of one must not stand for the other.
      subjects.push({ kind: `${row.entity_module}:${row.entity_type}`, id: row.entity_id, question: `service-due:${row.schedule_id ?? row.id}`, line: message });
      only = lines.length === 1 ? row : null;

      // Mark notified so we don't re-fire next tick.
      try {
        const update = sql`
          update core_maintenance_entries
          set last_notified_at = ${new Date()}
          where id = ${row.id}
        `.compile(tdb);
        await tdb.executeQuery(update);
      } catch (err) {
        platform().health.notePassFailure("core-maintenance.mark-notified", orgId, err);
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
          : `${countOf(lines.length, "thing")} need maintenance:\n${lines.join("\n")}`;
      // WHERE IT TAKES YOU. One entry → the thing that needs servicing, which
      // is where you would go to deal with it; several → the maintenance page,
      // which lists exactly what is due. It used to carry no link at all, so
      // "your mower is due for service" was a sentence you could not act on.
      // PAGE-LINK: several entries at once; the maintenance list IS the set.
      let link = "/maintenance";
      if (only?.entity_type && only.entity_id) {
        link =
          (await platform()
            .entities.recordAddressForEntity(org.id, `${only.entity_module}:${only.entity_type}`, only.entity_id)
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
            subjects,
            message,
            link_url: link,
            module: "core-maintenance",
            entityType: only?.entity_type,
            entityId: only?.entity_id,
            // ANSWER IT WHERE YOU READ IT. A single due entry is a yes/no
            // question - did you do it? - and the action to say yes already
            // exists. Declaring it here is all a notification needs to become
            // pressable, in the bell and in a Discord DM alike.
            actions,
            card: { rows: cardRows },
            payload: only
              ? { entryId: only.id, count: 1, scheduledAt: only.scheduled_at }
              : { count: lines.length },
          });
        } catch (err) {
          platform().health.notePassFailure("core-maintenance.notify", orgId, err);
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
