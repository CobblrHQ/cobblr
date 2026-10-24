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
import { pushSettingsFor } from "./push-delivery.js";
import { inQuietHours } from "./push-policy.js";
import { REGISTRY } from "./notifications.js";
import {
  composeDigest,
  destinationBatches,
  digestLink,
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

/** A claim older than this is a flush that died partway (#7075): the next
 *  flush takes its rows over, so a notice is retried rather than lost. Far
 *  longer than one flush's sends (an 8 s timeout each). */
const CLAIM_STALE_MS = 10 * 60 * 1000;


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
    // SKIP-IF-BUSY OK: a timer tick; the holder flushes the buckets, the next tick finds what is left
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
    claimed_at: Date | null;
  };
  orgs: { id: string; name: string; slug: string };
  notification_subscriptions: { user_id: string; org_id: string; channel: string; event_type: string; enabled: boolean; config: unknown };
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

    // Pushes held for quiet hours (#5267) wait for them to end, whatever the
    // window says; then they go as one push.
    if (channel === "browser_push") {
      try {
        if (inQuietHours(await pushSettingsFor(user_id), now)) continue;
      } catch (err) {
        console.error(`[notify] push settings read for ${user_id} failed:`, (err as Error).message);
        continue;
      }
    }

    for (const group of groups) {
      if (!group.due) continue;
      // Each group is isolated: one class's send failure never blocks the other.
      let claimed: string[] = [];
      try {
        // Claim what this flush sends, in one statement (#7075). Every entry
        // point (the timer, a person's "send now") comes through here, so two
        // that overlap split the rows instead of both sending them.
        const rows = (
          await db
            .updateTable("notification_deferred")
            .set({ claimed_at: now })
            .where("user_id", "=", user_id)
            .where("channel", "=", channel)
            .where("triggered_by", "in", group.triggeredBys)
            .where((eb) => eb.or([eb("claimed_at", "is", null), eb("claimed_at", "<", new Date(now.getTime() - CLAIM_STALE_MS))]))
            .returning(["id", "org_id", "event_type", "message", "link_url", "priority", "notification_id", "queued_at"])
            .execute()
        ).sort((a, b) => a.queued_at.getTime() - b.queued_at.getTime());
        claimed = rows.map((r) => r.id);
        if (rows.length === 0) continue;

        const adapter = REGISTRY[channel as keyof typeof REGISTRY];
        if (!adapter) {
          // No adapter (channel removed, or stubbed): drop the bucket rather than
          // letting it grow without bound. The notifications themselves are still
          // in history — only the push copy is discarded.
          await db.deleteFrom("notification_deferred").where("id", "in", claimed).execute();
          continue;
        }

        // One message per person for email; one per workspace for a channel
        // whose card can open only one place (Channel.digestScope, #6907).
        // Each goes to the subscription it was held for, as it is now (#7074):
        // a webhook, Slack or Discord binding is nothing without its config.
        const scope = adapter.digestScope ?? "person";
        const orgIds = [...new Set(rows.map((r) => r.org_id).filter((id): id is string => !!id))];
        const subs = orgIds.length
          ? await db
              .selectFrom("notification_subscriptions")
              .select(["org_id", "event_type", "enabled", "config"])
              .where("user_id", "=", user_id)
              .where("channel", "=", channel)
              .where("org_id", "in", orgIds)
              .where("event_type", "in", [...new Set(rows.map((r) => r.event_type)), "*"])
              .execute()
          : [];
        const { batches, dropped } = destinationBatches(rows, subs, scope);
        // Turned off since they were held: the person said stop.
        if (dropped.length) await db.deleteFrom("notification_deferred").where("id", "in", dropped.map((r) => r.id)).execute();
        const orgs = new Map(
          (orgIds.length ? await db.selectFrom("orgs").select(["id", "name", "slug"]).where("id", "in", orgIds).execute() : []).map((o) => [o.id, o]),
        );
        let allSent = true;
        for (const { rows: batch, config } of batches) {
          const items: DeferredItem[] = batch.map((r) => ({
            event_type: r.event_type,
            message: r.message,
            link_url: r.link_url,
          }));
          const first = batch[0]!;
          const org = scope === "workspace" && first.org_id ? orgs.get(first.org_id) : undefined;
          const ok = await adapter.deliver({
            notificationId: first.notification_id,
            orgId: first.org_id ?? "",
            userId: user_id,
            eventType: batch.length === 1 ? first.event_type : "notifications.digest",
            message: composeDigest(items, { workspace: org?.name, workspaces: new Set(batch.map((r) => r.org_id)).size }),
            // One item keeps its own link; many from one workspace open that
            // workspace's notifications when its slug is supplied, else the account inbox.
            link_url: digestLink(batch, org?.slug ?? null),
            priority: "normal",
            subscriptionConfig: config,
            payload: { digest_count: batch.length },
            actions: null,
          });
          // Clear only on success. A failed send leaves its rows, so the next
          // tick retries rather than silently eating the day's mail.
          if (!ok) {
            allSent = false;
            await db.updateTable("notification_deferred").set({ claimed_at: null }).where("id", "in", batch.map((r) => r.id)).execute();
            continue;
          }
          await db
            .deleteFrom("notification_deferred")
            .where("id", "in", batch.map((r) => r.id))
            .execute();
          flushed++;
          messages += batch.length;
        }
        // A batch that did not go stays queued and the window unstamped, so the
        // next tick sends it rather than waiting a day.
        if (!allSent) continue;

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
      } catch (err) {
        // One group's failure never blocks another group or anyone else's mail.
        console.error(`[notify] flush ${channel} for ${user_id} failed:`, (err as Error).message);
        // What it claimed and did not send goes back for the next tick; a
        // release that fails too is taken over once the claim is stale.
        if (claimed.length) await db.updateTable("notification_deferred").set({ claimed_at: null }).where("id", "in", claimed).execute().catch(() => undefined);
      }
    }
  }

  if (flushed > 0) console.log(`[notify] delivery sweep: ${flushed} digest(s), ${messages} notification(s)`);
  return { flushed, messages };
}
