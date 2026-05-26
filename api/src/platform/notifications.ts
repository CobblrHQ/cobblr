// Notification dispatcher. Modules call dispatch(); this writes the
// notification row, looks up the user's enabled channels for the
// event type, fans out, and updates delivered_via on success.
//
// Channel registry is process-static — channels can't be added at
// runtime (and don't need to be in Phase 0).

import { meta } from "../db/meta.js";
import { inAppChannel } from "./channels/in-app.js";
import { browserPushChannel } from "./channels/browser-push.js";
import { discordChannel } from "./channels/discord.js";
import { slackChannel } from "./channels/slack.js";
import { webhookChannel } from "./channels/webhook.js";
import { emailChannel } from "./channels/email.js";
import { smsChannel } from "./channels/sms.js";
import type { Channel } from "./channels/types.js";
import type { NotificationChannel, NotificationPriority } from "../db/schema.js";

const REGISTRY: Record<NotificationChannel, Channel | undefined> = {
  in_app: inAppChannel,
  browser_push: browserPushChannel,
  email: emailChannel,
  discord: discordChannel,
  webhook: webhookChannel,
  slack: slackChannel,
  sms: smsChannel,
};

/** Ordering for the min_priority threshold. low < normal < high < urgent. */
const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/** True if `notif >= threshold` on the priority ladder. */
function meetsThreshold(
  notifPriority: NotificationPriority,
  threshold: NotificationPriority,
): boolean {
  return PRIORITY_ORDER[notifPriority] >= PRIORITY_ORDER[threshold];
}

export interface DispatchParams {
  orgId: string;
  userId: string;
  eventType: string;
  message: string;
  link_url?: string;
  module?: string;
  entityType?: string;
  entityId?: string;
  /** Routing knob. Subscriptions with min_priority above this won't
   *  fire. Default 'normal' so a module that emits without thinking
   *  about urgency lands in the standard "I care if I'm at the
   *  computer" tier. */
  priority?: NotificationPriority;
  payload?: unknown;
}

export interface DispatchResult {
  notificationId: string;
  deliveredVia: NotificationChannel[];
}

export async function dispatch(p: DispatchParams): Promise<DispatchResult> {
  const priority: NotificationPriority = p.priority ?? "normal";

  // 1. Insert the notification row first so it exists in the DB even
  //    if every channel fails. delivered_via starts empty.
  const inserted = await meta
    .insertInto("notifications")
    .values({
      org_id: p.orgId,
      user_id: p.userId,
      event_type: p.eventType,
      module_name: p.module ?? null,
      entity_type: p.entityType ?? null,
      entity_id: p.entityId ?? null,
      message: p.message,
      link_url: p.link_url ?? null,
      priority,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // 2. Resolve which subscriptions to fire. We pull both exact-match
  //    (event_type = eventType) and wildcard ('*') rows. Then:
  //      a. drop disabled rows
  //      b. drop rows whose min_priority is above this notification's
  //         priority (the urgency threshold)
  //      c. dedup so a (channel, eventType-exact) and (channel,
  //         wildcard) pair only fires the channel once — exact wins.
  //    No subscriptions at all → default to in_app only (legacy
  //    behaviour preserved). An explicit `enabled=false` row
  //    suppresses a channel that would otherwise default-on.
  const subs = await meta
    .selectFrom("notification_subscriptions")
    .select(["channel", "enabled", "min_priority", "event_type", "config"])
    .where("user_id", "=", p.userId)
    .where("org_id", "=", p.orgId)
    .where((eb) =>
      eb.or([
        eb("event_type", "=", p.eventType),
        eb("event_type", "=", "*"),
      ]),
    )
    .execute();

  // Exact-match rows take precedence over wildcard for the same
  // (user, org, channel). Build a per-channel "the row that wins"
  // map: prefer event_type === p.eventType over event_type === '*'.
  const winningByChannel = new Map<
    NotificationChannel,
    typeof subs[number]
  >();
  for (const s of subs) {
    const existing = winningByChannel.get(s.channel);
    if (!existing) {
      winningByChannel.set(s.channel, s);
      continue;
    }
    // Exact beats wildcard.
    if (existing.event_type === "*" && s.event_type !== "*") {
      winningByChannel.set(s.channel, s);
    }
  }

  const effective: Array<{
    channel: NotificationChannel;
    config: unknown;
  }> = [];
  for (const s of winningByChannel.values()) {
    if (!s.enabled) continue;
    if (!meetsThreshold(priority, s.min_priority)) continue;
    effective.push({ channel: s.channel, config: s.config });
  }

  // Legacy default: no subscriptions matched at all → in_app only.
  // (Existing callers haven't started supplying priority either, so
  // this preserves their before-vs-after behaviour exactly.)
  if (effective.length === 0 && subs.length === 0) {
    effective.push({ channel: "in_app", config: null });
  }

  // 3. Fan out in parallel. A failing channel doesn't take the others
  //    down with it. Channels not in the registry (or stubbed out)
  //    won't appear in delivered_via.
  const results = await Promise.all(
    effective.map(async ({ channel: name, config }) => {
      const channel = REGISTRY[name];
      if (!channel) return { name, ok: false };
      try {
        const ok = await channel.deliver({
          notificationId: inserted.id,
          orgId: p.orgId,
          userId: p.userId,
          eventType: p.eventType,
          message: p.message,
          link_url: p.link_url ?? null,
          priority,
          subscriptionConfig: config,
          payload: p.payload,
        });
        return { name, ok };
      } catch (err) {
        console.error(`[notify] channel ${name} threw:`, err);
        return { name, ok: false };
      }
    }),
  );

  const deliveredVia = results.filter((r) => r.ok).map((r) => r.name);
  if (deliveredVia.length > 0) {
    await meta
      .updateTable("notifications")
      .set({ delivered_via: deliveredVia })
      .where("id", "=", inserted.id)
      .execute();
  }
  return { notificationId: inserted.id, deliveredVia };
}

/** Fire a test invocation through exactly ONE subscription's
 *  channel, bypassing the dispatcher's full subscription scan + the
 *  notifications-table insert. Used by the per-row "test" button on
 *  /me/notification-channels so a user can validate their Discord
 *  webhook without spamming every other binding they've set up. */
export async function testOneBinding(
  bindingId: string,
  userId: string,
  priority: NotificationPriority,
): Promise<{ deliveredVia: NotificationChannel[]; ownerCheck: "ok" | "denied" | "not_found" }> {
  const row = await meta
    .selectFrom("notification_subscriptions")
    .select(["id", "user_id", "org_id", "channel", "config", "enabled"])
    .where("id", "=", bindingId)
    .executeTakeFirst();
  if (!row) return { deliveredVia: [], ownerCheck: "not_found" };
  if (row.user_id !== userId) return { deliveredVia: [], ownerCheck: "denied" };
  const driver = REGISTRY[row.channel];
  if (!driver) return { deliveredVia: [], ownerCheck: "ok" };
  let ok = false;
  try {
    ok = await driver.deliver({
      notificationId: "test-" + bindingId,
      orgId: row.org_id,
      userId,
      eventType: "test.notification",
      message: `Per-binding test at ${new Date().toISOString()} (priority=${priority}).`,
      link_url: "/me/notification-channels",
      priority,
      subscriptionConfig: row.config,
    });
  } catch (err) {
    console.error(`[notify:test-one] channel ${row.channel} threw:`, err);
  }
  return {
    deliveredVia: ok ? [row.channel] : [],
    ownerCheck: "ok",
  };
}

export interface NotificationListItem {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  read_at: Date | null;
  created_at: Date;
}

export async function listForUser(
  userId: string,
  orgId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let q = meta
    .selectFrom("notifications")
    .select([
      "id",
      "event_type",
      "module_name",
      "message",
      "link_url",
      "read_at",
      "created_at",
    ])
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .orderBy("created_at", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("read_at", "is", null);
  return q.execute();
}

export async function markRead(notificationId: string, userId: string): Promise<void> {
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("id", "=", notificationId)
    .where("user_id", "=", userId)
    .execute();
}

export async function markAllRead(userId: string, orgId: string): Promise<number> {
  const updated = await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .where("read_at", "is", null)
    .returning("id")
    .execute();
  return updated.length;
}

export async function unreadCount(userId: string, orgId: string): Promise<number> {
  const row = await meta
    .selectFrom("notifications")
    .select(({ fn }) => fn.countAll<string>().as("c"))
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .where("read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

// ─────── Cross-workspace variants for /me/notifications ─────────────
// The header bell wants "everything for this user, no matter which
// workspace they're currently viewing". These variants join through
// org_memberships so we only return notifications for orgs the user
// still belongs to (handles the "you were removed from a workspace"
// case implicitly).

export interface CrossOrgNotificationListItem extends NotificationListItem {
  org_id: string;
  org_name: string;
  org_slug: string;
}

export async function listForUserAcrossOrgs(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<CrossOrgNotificationListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let q = meta
    .selectFrom("notifications as n")
    .innerJoin("org_memberships as m", (j) =>
      j.onRef("m.org_id", "=", "n.org_id").on("m.user_id", "=", userId),
    )
    .innerJoin("orgs as o", "o.id", "n.org_id")
    .select([
      "n.id as id",
      "n.event_type as event_type",
      "n.module_name as module_name",
      "n.message as message",
      "n.link_url as link_url",
      "n.read_at as read_at",
      "n.created_at as created_at",
      "n.org_id as org_id",
      "o.name as org_name",
      "o.slug as org_slug",
    ])
    .where("n.user_id", "=", userId)
    .orderBy("n.created_at", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("n.read_at", "is", null);
  return q.execute();
}

export async function unreadCountAcrossOrgs(userId: string): Promise<number> {
  const row = await meta
    .selectFrom("notifications as n")
    .innerJoin("org_memberships as m", (j) =>
      j.onRef("m.org_id", "=", "n.org_id").on("m.user_id", "=", userId),
    )
    .select(({ fn }) => fn.countAll<string>().as("c"))
    .where("n.user_id", "=", userId)
    .where("n.read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

export async function markAllReadAcrossOrgs(userId: string): Promise<number> {
  const updated = await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .returning("id")
    .execute();
  return updated.length;
}
