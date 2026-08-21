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
import { REGISTRY } from "./notifications.js";
import {
  composeDigest,
  isWindowDue,
  type DeliveryWindow,
  type DeferredItem,
} from "./delivery-windows.js";

/** Every 5 minutes. A window is a time of day, so this is precise enough, and
 *  the idempotency guard (one flush per local day) makes the exact cadence
 *  uninteresting. */
const TICK_MS = 5 * 60 * 1000;

let handle: ReturnType<typeof setInterval> | null = null;

export function startDeliverySweeper(): void {
  if (handle) clearInterval(handle);
  handle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 50_000); // after boot settles
  console.log(`[notify] delivery sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await deliveryTick();
  } catch (err) {
    console.error("[notify] delivery sweep failed:", (err as Error).message);
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

  // Only buckets with mail. A person with a window and an empty bucket is not
  // owed a "nothing happened today" message — that is noise wearing the shape
  // of a feature.
  let pendingQ = db.selectFrom("notification_deferred").select(["user_id", "channel"]).distinct();
  if (onlyUserId) pendingQ = pendingQ.where("user_id", "=", onlyUserId);
  const pending = await pendingQ.execute();
  if (pending.length === 0) return { flushed: 0, messages: 0 };

  let flushed = 0;
  let messages = 0;

  for (const { user_id, channel } of pending) {
    try {
      const win = await db
        .selectFrom("notification_delivery_windows")
        .select(["mode", "deliver_at_minute", "timezone", "last_delivered_at"])
        .where("user_id", "=", user_id)
        .where("channel", "=", channel)
        .executeTakeFirst();

      // The window was removed while mail was queued: send it rather than
      // holding it forever. Turning a window off must not strand a backlog.
      const due = win ? isWindowDue(win as DeliveryWindow, now) : true;
      if (!due) continue;

      const rows = await db
        .selectFrom("notification_deferred")
        .select(["id", "org_id", "event_type", "message", "link_url", "priority", "notification_id"])
        .where("user_id", "=", user_id)
        .where("channel", "=", channel)
        .orderBy("queued_at", "asc")
        .execute();
      if (rows.length === 0) continue;

      const adapter = REGISTRY[channel as keyof typeof REGISTRY];
      if (!adapter) {
        // No adapter (channel removed, or stubbed): drop the bucket rather than
        // letting it grow without bound. The notifications themselves are still
        // in history — only the push copy is discarded.
        await db.deleteFrom("notification_deferred").where("user_id", "=", user_id).where("channel", "=", channel).execute();
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
        await db
          .updateTable("notification_delivery_windows")
          .set({ last_delivered_at: now })
          .where("user_id", "=", user_id)
          .where("channel", "=", channel)
          .execute();
      }
      flushed++;
      messages += rows.length;
    } catch (err) {
      // One person's failure never blocks anyone else's mail.
      console.error(`[notify] flush ${channel} for ${user_id} failed:`, (err as Error).message);
    }
  }

  if (flushed > 0) console.log(`[notify] delivery sweep: ${flushed} digest(s), ${messages} notification(s)`);
  return { flushed, messages };
}
