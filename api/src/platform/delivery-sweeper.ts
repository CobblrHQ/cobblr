// The one sweeper that flushes every windowed channel for every person.
//
// Design: docs/design-decisions/notification-delivery-windows.md — "one
// sweeper, in the platform. Not a cron per module, which is digest-per-module
// wearing a different hat."
//
// It ticks often and does almost nothing: the scan is "which buckets have
// anything in them", which is an index hit, and a box where nobody has set a
// window does no work at all.

import { Kysely } from "kysely";
import { meta } from "../db/meta.js";
import { runExclusive } from "./exclusive.js";
import { REGISTRY } from "./notifications.js";
import {
  composeDigest,
  planDeliveryGroups,
  type DeliveryWindow,
  type DeferredItem,
  type TriggeredBy,
} from "./delivery-windows.js";

/** Every 5 minutes. A window is a time of day, so this is precise enough, and
 *  the idempotency guard (one flush per local day) makes the exact cadence
 *  uninteresting. */
const TICK_MS = 5 * 60 * 1000;

/** A deferred notification older than this is dropped from the push queue rather
 *  than retried forever against a dead channel. Seven days is well past any
 *  digest window; the notification itself remains in the bell/history. */
const MAX_DEFER_AGE_MS = 7 * 24 * 60 * 60 * 1000;


let handle: ReturnType<typeof setInterval> | null = null;
/** In-process reentry guard: a slow tick (many recipients, 8s DM timeouts) can
 *  outrun the 5-minute interval, and two overlapping ticks in ONE process would
 *  race on the same buckets before either deletes them. */
let running = false;

export function startDeliverySweeper(): void {
  if (handle) clearInterval(handle);
  handle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 50_000); // after boot settles
  console.log(`[notify] delivery sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  if (running) return; // never overlap a still-running tick in this process
  running = true;
  try {
    // Cross-process guard: only one api process flushes at a time. Two share
    // one cobblr_meta during a rolling deploy and on the canary channel;
    // without this both read the same undeleted buckets and each delivers them
    // — a duplicate digest, the exact noise this feature exists to avoid
    // (audit B4c). The buckets are deleted inside the tick, so the loser's next
    // tick finds nothing rather than repeating the work.
    await runExclusive("notify.delivery-sweep", async () => {
      await deliveryTick();
    });
  } catch (err) {
    console.error("[notify] delivery sweep failed:", (err as Error).message);
  } finally {
    running = false;
  }
}

interface SweepDB {
  notification_delivery_windows: {
    user_id: string;
    channel: string;
    mode: "immediate" | "daily";
    deliver_at_minute: number;
    timezone: string;
    last_delivered_at: Date | null;
    schedule_mode: "inherit" | "immediate" | "daily";
    schedule_deliver_at_minute: number;
    schedule_last_delivered_at: Date | null;
  };
  notification_deferred: {
    id: string;
    user_id: string;
    channel: string;
    notification_id: string;
    org_id: string | null;
    event_type: string;
    message: string;
    link_url: string | null;
    priority: string;
    triggered_by: TriggeredBy;
    queued_at: Date;
  };
}

export async function deliveryTick(
  now = new Date(),
  /** Limit the sweep to one person. Used by the per-user flush trigger, which
   *  exists because a window is a time of day: without a way to run the sweep
   *  on demand, the delivering half of this feature is effectively untestable
   *  and "the sweeper started" in a log says nothing about whether a tick
   *  actually sends anything. core-cadence learned the same thing and grew a
   *  POST /sweep for it. */
  onlyUserId?: string,
): Promise<{ flushed: number; messages: number }> {
  const db = meta as unknown as Kysely<SweepDB>;

  // Age out a stuck backlog. A bucket whose channel is permanently undeliverable
  // (Discord disconnected, or the bot URL unset on a self-host box) is left
  // intact on every failed flush and grows without bound (audit M-WINDOW). Drop
  // the deferred PUSH copy once it is older than the max age — the notification
  // itself stays in history (the bell), only the batched re-send is discarded.
  // Full-sweep only: the per-user diagnostic flush must not garbage-collect.
  if (!onlyUserId) {
    const cutoff = new Date(now.getTime() - MAX_DEFER_AGE_MS);
    const gc = await db
      .deleteFrom("notification_deferred")
      .where("queued_at", "<", cutoff)
      .executeTakeFirst();
    const dropped = Number(gc?.numDeletedRows ?? 0n);
    if (dropped > 0) console.log(`[notify] aged out ${dropped} stale deferred notification(s)`);
  }

  // Only buckets with mail. A person with a window and an empty bucket is not
  // owed a "nothing happened today" message — that is noise wearing the shape
  // of a feature.
  // A bucket is per (person, channel, CLASS): chat and the morning brief share
  // a channel and must not share a message.
  let pendingQ = db
    .selectFrom("notification_deferred")
    .select(["user_id", "channel", "triggered_by"])
    .distinct();
  if (onlyUserId) pendingQ = pendingQ.where("user_id", "=", onlyUserId);
  const pending = await pendingQ.execute();
  if (pending.length === 0) return { flushed: 0, messages: 0 };

  // Collect which CLASSES are queued per (person, channel), so the two cadences
  // are planned together rather than as independent buckets. Planning them apart
  // is what let an inherit-mode flush of one class stamp the shared column and
  // suppress the other for the day (audit B4b) — planDeliveryGroups merges the
  // classes that share a column so they flush once, together.
  const perTarget = new Map<
    string,
    { user_id: string; channel: string; classes: TriggeredBy[] }
  >();
  for (const p of pending) {
    const key = `${p.user_id}\x00${p.channel}`;
    const e = perTarget.get(key) ?? { user_id: p.user_id, channel: p.channel, classes: [] };
    e.classes.push(p.triggered_by);
    perTarget.set(key, e);
  }

  let flushed = 0;
  let messages = 0;

  for (const { user_id, channel, classes } of perTarget.values()) {
    let win:
      | (Pick<
          SweepDB["notification_delivery_windows"],
          | "mode"
          | "deliver_at_minute"
          | "timezone"
          | "last_delivered_at"
          | "schedule_mode"
          | "schedule_deliver_at_minute"
          | "schedule_last_delivered_at"
        >)
      | undefined;
    try {
      win = await db
        .selectFrom("notification_delivery_windows")
        .select([
          "mode",
          "deliver_at_minute",
          "timezone",
          "last_delivered_at",
          "schedule_mode",
          "schedule_deliver_at_minute",
          "schedule_last_delivered_at",
        ])
        .where("user_id", "=", user_id)
        .where("channel", "=", channel)
        .executeTakeFirst();
    } catch (err) {
      // Reading this person's window failed — skip them, never anyone else.
      console.error(`[notify] window read ${channel} for ${user_id} failed:`, (err as Error).message);
      continue;
    }

    // A null window means the row was removed while mail was queued: everything
    // is due now. Turning a window off must not strand a backlog.
    const groups = planDeliveryGroups((win as DeliveryWindow | undefined) ?? null, classes, now);

    for (const group of groups) {
      if (!group.due) continue;
      // Each group is isolated: one class's send failure never blocks the other.
      try {
        const rows = await db
          .selectFrom("notification_deferred")
          .select(["id", "org_id", "event_type", "message", "link_url", "priority", "notification_id"])
          .where("user_id", "=", user_id)
          .where("channel", "=", channel)
          .where("triggered_by", "in", group.triggeredBys)
          .orderBy("queued_at", "asc")
          .execute();
        if (rows.length === 0) continue;

        const adapter = REGISTRY[channel as keyof typeof REGISTRY];
        if (!adapter) {
          // No adapter (channel removed, or stubbed): drop the bucket rather than
          // letting it grow without bound. The notifications themselves are still
          // in history — only the push copy is discarded.
          await db
            .deleteFrom("notification_deferred")
            .where("user_id", "=", user_id)
            .where("channel", "=", channel)
            .where("triggered_by", "in", group.triggeredBys)
            .execute();
          continue;
        }

        const items: DeferredItem[] = rows.map((r) => ({
          event_type: r.event_type,
          message: r.message,
          link_url: r.link_url,
        }));
        const first = rows[0]!;
        const ok = await adapter.deliver({
          notificationId: first.notification_id,
          orgId: first.org_id ?? "",
          userId: user_id,
          eventType: rows.length === 1 ? first.event_type : "notifications.digest",
          message: composeDigest(items),
          // A digest of many cannot deep-link to one, so only a single-item
          // flush keeps its link.
          link_url: rows.length === 1 ? first.link_url : null,
          priority: "normal",
          subscriptionConfig: null,
          payload: { digest_count: rows.length },
          actions: null,
        });

        // Clear only on success. A failed send leaves the bucket intact, so the
        // next tick retries rather than silently eating the day's mail.
        if (!ok) continue;

        await db
          .deleteFrom("notification_deferred")
          .where("id", "in", rows.map((r) => r.id))
          .execute();
        if (win) {
          // Stamp the ONE column this group is governed by (the planner already
          // resolved inherit vs a split schedule cadence into a single column),
          // so a later flush of a different cadence is not suppressed.
          await db
            .updateTable("notification_delivery_windows")
            .set({ [group.stampColumn]: now })
            .where("user_id", "=", user_id)
            .where("channel", "=", channel)
            .execute();
        }
        flushed++;
        messages += rows.length;
      } catch (err) {
        // One group's failure never blocks another group or anyone else's mail.
        console.error(`[notify] flush ${channel} for ${user_id} failed:`, (err as Error).message);
      }
    }
  }

  if (flushed > 0) console.log(`[notify] delivery sweep: ${flushed} digest(s), ${messages} notification(s)`);
  return { flushed, messages };
}
