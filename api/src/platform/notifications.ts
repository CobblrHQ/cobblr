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
import { discordDmChannel } from "./channels/discord-dm.js";
import { slackChannel } from "./channels/slack.js";
import { webhookChannel } from "./channels/webhook.js";
import { emailChannel } from "./channels/email.js";
import { smsChannel } from "./channels/sms.js";
import type { Channel } from "./channels/types.js";
import type { NotificationAction } from "../db/schema.js";
import type { NotificationChannel, NotificationPriority } from "../db/schema.js";
import { hasAuthEmailSender, sendAuthEmail } from "./hosted-seams.js";
import { sendDiscordDm } from "./discord-bot-trigger.js";
import { discordConnectionState } from "./discord-connection.js";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import { absoluteAppUrl } from "./public-url.js";
import { defaultEnabled, tierOf, type PrefChannel } from "./notification-catalog.js";
import { fallbackChannels } from "./dispatch-fallback.js";
import {
  shouldDefer,
  windowsFor,
  windowFor,
  enqueueDeferred,
  type TriggeredBy,
} from "./delivery-windows.js";

// Exported so the delivery sweeper flushes through the SAME adapters a live
// send uses. A second registry would drift the moment a channel is added.
export const REGISTRY: Record<NotificationChannel, Channel | undefined> = {
  in_app: inAppChannel,
  browser_push: browserPushChannel,
  email: emailChannel,
  discord: discordChannel,
  discord_dm: discordDmChannel,
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
  /** What CAUSED this: somebody doing something (`activity`, the default), or a
   *  date arriving (`schedule`).
   *
   *  A second dial beside priority, and a different question. Priority is "how
   *  much does this interrupt"; this is "was it news, or was it the calendar".
   *  People want those delivered on different cadences on the SAME channel —
   *  chat as it happens, everything due today as one morning list — and no
   *  priority bar can express that, because both are `normal`.
   *
   *  Set `schedule` when the notification exists because a date or threshold was
   *  reached and was knowable in advance: expiring today, service due, running
   *  low. Leave it alone for anything that just happened. */
  triggeredBy?: TriggeredBy;
  payload?: unknown;
  /** What the reader can do about it, offered right in the message. Channels
   *  render them however they can; one that cannot ignores them, so `message`
   *  must still stand alone. */
  actions?: NotificationAction[];
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
      // Stored, not merely rendered: a press comes back carrying an ID, and
      // the action it maps to is read from HERE.
      //
      // `JSON.stringify(...) as never` is the house convention for a jsonb
      // ARRAY (lint:jsonb-array-writes): node-pg renders a JS array as a
      // Postgres array literal, which jsonb rejects at runtime while
      // typechecking perfectly.
      actions: (p.actions?.length ? JSON.stringify(p.actions) : null) as never,
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
  //    No subscriptions at all → fall back to ACCOUNT prefs, per the policy
  //    in dispatch-fallback.ts (in_app always; discord_dm when the person
  //    wants it and the event clears DM_FLOOR; email never). An explicit
  //    `enabled=false` row suppresses a channel that would otherwise
  //    default-on.
  //
  //    This line used to read "default to in_app only (legacy behaviour
  //    preserved)", and stayed there after dispatch-fallback.ts replaced that
  //    rule 40 lines below. Someone reading top-down concluded from it that a
  //    module notification could never reach Discord, and said so out loud
  //    (2026-08-24). A stale comment above live code is worse than no comment:
  //    it is believed.
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

  // Nothing said about this workspace at all → fall back to what the person
  // has said ACCOUNT-wide. Used to be a hardcoded in_app, which meant somebody
  // could verify Discord and still get nothing for anything a module sent.
  //
  // in_app is unchanged and unconditional. Discord rides along when they want
  // it. Email never does — see dispatch-fallback.ts for why that one would
  // hurt.
  // The windows are read HERE rather than in step 2b, because "has this person
  // batched that channel" is now part of deciding whether the channel is
  // reachable at all: email is mailed one message a day or not at all.
  const windows = await windowsFor(meta as never, p.userId);
  const triggeredBy: TriggeredBy = p.triggeredBy ?? "activity";
  const batched = new Set(
    [...windows.entries()]
      .filter(([, w]) => windowFor(w, triggeredBy).mode === "daily")
      .map(([channel]) => channel),
  );

  if (effective.length === 0 && subs.length === 0) {
    const prefs = await resolveAccountPrefs(p.userId, p.eventType);
    for (const channel of fallbackChannels(prefs, priority, batched)) {
      effective.push({ channel, config: null });
    }
  }

  // 2b. Split the channels into "now" and "with the rest".
  //
  //     A delivery window is per (person, channel) and is about VOLUME; the
  //     min_priority above is per (person, event, channel) and is about
  //     relevance. Keeping them separate is what stops a person having to
  //     choose between hearing about something and being interrupted by it.
  //
  //     The notification row is already written (step 1), unconditionally, so
  //     the bell and the history never change shape because of a window. Only
  //     the push channels defer.
  const deferredChannels: string[] = [];
  const liveChannels: typeof effective = [];
  for (const e of effective) {
    if (shouldDefer(windows.get(e.channel), priority, e.channel, triggeredBy))
      deferredChannels.push(e.channel);
    else liveChannels.push(e);
  }
  for (const channel of deferredChannels) {
    try {
      await enqueueDeferred(meta as never, {
        user_id: p.userId,
        channel,
        notification_id: inserted.id,
        org_id: p.orgId,
        event_type: p.eventType,
        message: p.message,
        link_url: p.link_url ?? null,
        priority,
        triggered_by: triggeredBy,
      });
    } catch (err) {
      // A bucket that cannot be written must not swallow the notification: fall
      // back to sending it now. Late and noisy beats lost.
      console.error(`[notify] deferring to ${channel} failed, sending now:`, err);
      liveChannels.push({ channel: channel as NotificationChannel, config: null });
    }
  }

  // 3. Fan out in parallel. A failing channel doesn't take the others
  //    down with it. Channels not in the registry (or stubbed out)
  //    won't appear in delivered_via.
  const results = await Promise.all(
    liveChannels.map(async ({ channel: name, config }) => {
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
          actions: p.actions ?? null,
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

// ─────────── Account-level notifications (Communication Preferences) ─────────
// Platform notifications (feedback replies, announcements, Claude messages) are
// account-level, not workspace-scoped, so their channel choice lives in
// notification_account_prefs — NOT the per-(user,org) notification_subscriptions
// the per-workspace dispatch() above uses. notifyAccount() is deliberately
// self-contained (its own channel fan-out) so it can't regress the dispatch path.

/** Resolve a user's effective in_app/discord_dm/email enablement for one
 *  notification type, applying defaults for any channel with no explicit row. */
export async function resolveAccountPrefs(
  userId: string,
  notificationType: string,
): Promise<Record<PrefChannel, boolean>> {
  const rows = await meta
    .selectFrom("notification_account_prefs")
    .select(["channel", "enabled"])
    .where("user_id", "=", userId)
    .where("notification_type", "=", notificationType)
    .execute();
  const byChannel = new Map(rows.map((r) => [r.channel, r.enabled]));
  // Only asked when a default is actually needed, which is the first time a
  // user is notified about a type and never again once they have a row.
  let discordVerified: boolean | undefined;
  const verified = async (): Promise<boolean> => {
    if (discordVerified === undefined) {
      const conn = await meta
        .selectFrom("discord_connections")
        .select(["discord_user_id", "verified", "verified_app_id"])
        .where("user_id", "=", userId)
        .executeTakeFirst();
      // The same question the dispatcher asks, so a default cannot say "on"
      // for a channel delivery will refuse.
      discordVerified = discordConnectionState(conn) === "verified";
    }
    return discordVerified;
  };

  const out = {} as Record<PrefChannel, boolean>;
  for (const ch of ["in_app", "discord_dm", "email"] as PrefChannel[]) {
    const v = byChannel.get(ch);
    out[ch] =
      v === undefined
        ? defaultEnabled(ch, {
            discordVerified: ch === "discord_dm" ? await verified() : false,
            tier: tierOf(notificationType),
          })
        : v;
  }
  return out;
}

export interface NotifyAccountParams {
  userId: string;
  /** Org the in_app row is filed under (the user's filed-from / first workspace).
   *  Channel ENABLEMENT comes from account prefs, not this org's subscriptions. */
  representativeOrgId: string;
  /** A Tier-2 notification type key (see notification-catalog). */
  notificationType: string;
  message: string;
  /** Optional override for the Discord DM text only — when the DM wants a more
   *  formal/longer phrasing (e.g. a greeting) than the in-app bell. Falls back to
   *  `message` when unset. */
  discordMessage?: string;
  link_url?: string;
  module?: string;
  /** Optional richer email than the generic "<message> <link>" fallback.
   *  `replyTo` (optional) carries a tokenized reply-by-email address; `html`
   *  (optional) is a rich body sent alongside `text` (the plaintext fallback). */
  email?: { subject: string; text: string; html?: string; replyTo?: string; from?: string; inReplyTo?: string; references?: string };
}

/** Deliver an account-level (platform) notification across the user's chosen
 *  channels: in_app (the bell), email (the platform sender), discord_dm (the
 *  bot — only if connected + verified). Honors the Communication Preferences
 *  matrix; a disabled channel is simply skipped. */
export async function notifyAccount(
  args: NotifyAccountParams,
): Promise<{ notificationId: string | null; deliveredVia: PrefChannel[]; outcomes: DeliveryOutcomes }> {
  const prefs = await resolveAccountPrefs(args.userId, args.notificationType);
  const deliveredVia: PrefChannel[] = [];
  // Every channel says why, not just whether — a bare false cannot tell an
  // operator "they opted out" from "our sender is down". See delivery-outcome.ts.
  const outcomes: DeliveryOutcomes = {};
  let notificationId: string | null = null;

  // in_app — the row's existence IS the delivery (the bell reads the table).
  if (prefs.in_app) {
    const inserted = await meta
      .insertInto("notifications")
      .values({
        org_id: args.representativeOrgId,
        user_id: args.userId,
        event_type: args.notificationType,
        module_name: args.module ?? null,
        entity_type: null,
        entity_id: null,
        message: args.message,
        link_url: args.link_url ?? null,
        priority: "normal",
        delivered_via: ["in_app"],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    notificationId = inserted.id;
    deliveredVia.push("in_app");
    outcomes.in_app = "sent";
  } else {
    outcomes.in_app = "opted-out";
  }

  // email — only when the caller supplies an email payload (so an event that
  // isn't meant to email never does), gated by the user's pref + the PLATFORM
  // sender (managed mailer in prod), not per-user BYO SMTP.
  if (!args.email) {
    outcomes.email = "not-offered";
  } else if (!prefs.email) {
    outcomes.email = "opted-out";
  } else if (!hasAuthEmailSender()) {
    outcomes.email = "no-sender";
  } else {
    const u = await meta
      .selectFrom("users")
      .select(["email"])
      .where("id", "=", args.userId)
      .executeTakeFirst();
    if (!u?.email) {
      outcomes.email = "no-address";
    } else {
      const ok = await sendAuthEmail({ to: u.email, subject: args.email.subject, text: args.email.text, html: args.email.html, kind: "notification", replyTo: args.email.replyTo, from: args.email.from, inReplyTo: args.email.inReplyTo, references: args.email.references });
      if (ok) deliveredVia.push("email");
      outcomes.email = ok ? "sent" : "send-failed";
    }
  }

  // discord_dm — only when the user has connected + verified Discord.
  if (!prefs.discord_dm) {
    outcomes.discord_dm = "opted-out";
  } else {
    const conn = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id", "verified", "verified_app_id"])
      .where("user_id", "=", args.userId)
      .executeTakeFirst();
    const state = discordConnectionState(conn);
    if (state === "not-connected") {
      outcomes.discord_dm = "not-connected";
    } else if (state === "unverified") {
      outcomes.discord_dm = "unverified";
    } else if (state === "stale-app") {
      // Verified, but by a Discord app that is no longer the one sending. The
      // current bot may not share a server with this person, so the DM would
      // vanish rather than fail loudly. Say so instead of sending into it.
      outcomes.discord_dm = "stale-app";
    } else {
      const dmBody = args.discordMessage ?? args.message;
      const text = args.link_url
        ? `${dmBody}\n${absoluteAppUrl(args.link_url)}`
        : dmBody;
      const res = await sendDiscordDm({ discord_user_id: conn!.discord_user_id!, text });
      if (res.ok) deliveredVia.push("discord_dm");
      outcomes.discord_dm = res.ok ? "sent" : res.deliverable ? "send-failed" : "blocked";
      if (!res.ok && !res.deliverable) {
        // BLOCKED is durable, not a blip: privacy settings, a bot that shares no
        // server, a deleted account. Leaving `verified` true means every future
        // notification goes quietly nowhere and the settings page keeps claiming
        // Discord works. Dropping it surfaces the reconnect prompt and lets the
        // account-pref fallback route this person somewhere they will see it.
        // A transient send-failed is left alone on purpose.
        await meta
          .updateTable("discord_connections")
          .set({ verified: false, updated_at: new Date() })
          .where("user_id", "=", args.userId)
          .execute();
      }
    }
  }

  return { notificationId, deliveredVia, outcomes };
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
