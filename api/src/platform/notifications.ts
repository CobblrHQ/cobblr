// Notification dispatcher. Modules call dispatch(); this writes the
// notification row, looks up the user's enabled channels for the
// event type, fans out, and updates delivered_via on success.
//
// Channel registry is process-static — channels can't be added at
// runtime (and don't need to be in Phase 0).

import { isCapped, notePaused, takeSendSlot } from "./channel-send-cap.js";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { orgMemberIds } from "./memberships.js";
import { inAudience } from "./notification-audience.js";
import { isMember } from "@cobblr/platform-contract/membership";
import { env } from "../env.js";
import { inAppChannel } from "./channels/in-app.js";
import { browserPushChannel } from "./channels/browser-push.js";
import { discordChannel } from "./channels/discord.js";
import { discordDmChannel, discordDmPayload } from "./channels/discord-dm.js";
import { slackChannel } from "./channels/slack.js";
import { webhookChannel } from "./channels/webhook.js";
import { emailChannel } from "./channels/email.js";
import { smsChannel } from "./channels/sms.js";
import type { Channel, NotificationCard } from "./channels/types.js";
import type { NotificationAction } from "../db/schema.js";
import type { NotificationChannel, NotificationPriority } from "../db/schema.js";
import { settleForDisplay, type Settled } from "./notification-subjects.js";
import { announceNotificationChange } from "./notification-stream.js";
// Registers the approval request as a subject whose cards settle; imported
// here so every inbox read has it, whatever else the process has loaded.
import "./approval-subject.js";
import { hasAuthEmailSender, sendAuthEmail } from "./hosted-seams.js";
import { sendDiscordDm, dmOutcome, dmResultUnverifies } from "./discord-bot-trigger.js";
import { discordConnectionState } from "./discord-connection.js";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import type { NotificationDestination } from "@cobblr/platform-contract";
import { defaultEnabled, tierOf, type PrefChannel } from "./notification-catalog.js";
import { fallbackChannels } from "./dispatch-fallback.js";
import {
  shouldDefer,
  windowsFor,
  windowFor,
  enqueueDeferred,
  winningSubscription,
  type TriggeredBy,
} from "./delivery-windows.js";
import { decodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { pushDevicesFor, pushSettingsFor } from "./push-delivery.js";
import { heldForQuietHours, privatePushLine, worthAPush, type PushSettings } from "./push-policy.js";

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

export type DispatchParams = NotificationDestination & {
  idempotencyKey?: string;
  orgId: string;
  userId: string;
  eventType: string;
  message: string;
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
  /** Substance behind the one-liner, for channels that can render a card. */
  card?: NotificationCard;
  /** The message or card carries a person's private content (a personal
   *  document, a secret field): a push shows a generic line and the link. */
  private?: boolean;
};

export interface DispatchResult {
  notificationId: string;
  deliveredVia: NotificationChannel[];
}

export async function dispatch(p: DispatchParams): Promise<DispatchResult> {
  const priority: NotificationPriority = p.priority ?? "normal";

  // 0. A dispatch() notification is WORKSPACE-scoped (it is filed under a
  //    specific org and carries that workspace's content). It must reach only
  //    people who are CURRENTLY members of that workspace. The in-app read
  //    paths already enforce this by joining org_memberships (see
  //    listForUserAcrossOrgs), so a removed member never sees the bell — but
  //    the PUSH channels do not read through that join, so a user removed from
  //    a workspace who still has follow/mention/speaker rows kept getting that
  //    workspace's comment content over Discord (audit M-EXMEMBER). Intersect
  //    the audience with live membership before writing or fanning out anything.
  //
  //    notifyAccount() below is deliberately NOT gated here: it is ACCOUNT
  //    scoped (sign-in, billing, feedback replies) and reaches a person about
  //    their account regardless of any workspace, so membership is irrelevant
  //    to it.
  const members = await orgMemberIds(p.orgId);
  if (!isMember(p.userId, members)) {
    return { notificationId: "", deliveredVia: [] };
  }
  // 0b. And only people this KIND is for, per the workspace's own setting
  //     (notification-audience.ts): everyone by default, the owners, or a
  //     chosen few. Decided here rather than in the emitters, because nine of
  //     them fan out over the member list and a tenth would too; the one door
  //     every workspace notification passes through is this one.
  if (!(await inAudience(p.orgId, p.eventType, p.userId))) {
    return { notificationId: "", deliveredVia: [] };
  }

  // 1. Insert the notification row first so it exists in the DB even
  //    if every channel fails. delivered_via starts empty.
  const inserted = await meta
    .insertInto("notifications")
    .values({
      dedupe_key: p.idempotencyKey ?? null,
      org_id: p.orgId,
      user_id: p.userId,
      event_type: p.eventType,
      module_name: p.module ?? null,
      entity_type: p.entityType ?? null,
      entity_id: p.entityId ?? null,
      message: p.message,
      link_url: p.link_url ?? null,
      priority,
      // Stored for the same reason as `actions` below: the bell reads the row,
      // and a card that only ever existed in flight left the app's own inbox
      // saying "something happened" while the Discord DM showed what.
      // jsonb-object-ok: one small document, written once at dispatch.
      card: p.card ? (JSON.stringify(p.card) as never) : null,
      // Stored, not merely rendered: a press comes back carrying an ID, and
      // the action it maps to is read from HERE.
      //
      // `JSON.stringify(...) as never` is the house convention for a jsonb
      // ARRAY (lint:jsonb-array-writes): node-pg renders a JS array as a
      // Postgres array literal, which jsonb rejects at runtime while
      // typechecking perfectly.
      actions: (p.actions?.length ? JSON.stringify(p.actions) : null) as never,
    })
    .onConflict((oc) => oc.columns(["org_id", "user_id", "dedupe_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) {
    const existing = await meta.selectFrom("notifications").select("id")
      .where("org_id", "=", p.orgId).where("user_id", "=", p.userId)
      .where("dedupe_key", "=", p.idempotencyKey!).executeTakeFirstOrThrow();
    return { notificationId: existing.id, deliveredVia: [] };
  }
  sometimesPrune(p.userId);
  announceNotificationChange(p.userId, { kind: "new", id: inserted.id });

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
  // The held send asks the same question when it flushes (#7074).
  for (const channel of new Set(subs.map((s) => s.channel))) {
    const won = winningSubscription(subs.filter((s) => s.channel === channel), p.eventType);
    if (won) winningByChannel.set(channel, won);
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

  // 2a. Push (#5267) is a person's, across their devices, not a workspace's: a
  //     person who turned it on for a device hears about whatever crosses
  //     their push threshold (high and urgent by default; the bell keeps the
  //     rest). A binding this workspace has for browser_push, enabled or not,
  //     decides instead: it was set on purpose.
  let pushSettings: PushSettings | null = null;
  if (!winningByChannel.has("browser_push") && !effective.some((e) => e.channel === "browser_push")) {
    const devices = await pushDevicesFor(p.userId, p.orgId);
    if (devices.length > 0) {
      pushSettings = await pushSettingsFor(p.userId);
      if (worthAPush(priority, pushSettings)) effective.push({ channel: "browser_push", config: null });
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
    // Quiet hours hold every push but urgent until they end; the sweeper sends
    // what waited as one push then.
    else if (e.channel === "browser_push" && heldForQuietHours(priority, (pushSettings ??= await pushSettingsFor(p.userId)), new Date()))
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
        // A held push is sent later with no payload to say it was private, so
        // a private one waits with only the line it may show.
        message: channel === "browser_push" && p.private ? privatePushLine(p.eventType) : p.message,
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

  // 2c. The send cap (#6908): a channel that has sent its hour's worth holds
  //     the rest for its next digest, and the bell says so once. The bell is
  //     never capped. Counted per send, atomically, so a burst cannot race past.
  const sendNow: typeof liveChannels = [];
  for (const e of liveChannels) {
    if (!isCapped(e.channel)) {
      sendNow.push(e);
      continue;
    }
    const slot = await takeSendSlot(p.userId, e.channel);
    if (slot.allowed) {
      sendNow.push(e);
      continue;
    }
    try {
      await enqueueDeferred(meta as never, {
        user_id: p.userId,
        channel: e.channel,
        notification_id: inserted.id,
        org_id: p.orgId,
        event_type: p.eventType,
        message: e.channel === "browser_push" && p.private ? privatePushLine(p.eventType) : p.message,
        link_url: p.link_url ?? null,
        priority,
        triggered_by: triggeredBy,
      });
      if (slot.firstOver) await notePaused({ orgId: p.orgId, userId: p.userId, channel: e.channel, slot });
    } catch (err) {
      console.error(`[notify] holding over-cap ${e.channel} failed:`, err);
    }
  }
  liveChannels.splice(0, liveChannels.length, ...sendNow);

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
          card: p.card ?? null,
          private: p.private === true,
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
  /** Only these channels, still each as the person set it. An AI-share offer
   *  is in the bell as an approval card with Approve and Deny (#6911); its
   *  email still goes, and a second bell row for the same offer would not. */
  only?: PrefChannel[];
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
  /** How loudly it arrives, as for a workspace notification. */
  priority?: NotificationPriority;
  /** The substance behind the sentence, rendered by the bell and as the
   *  Discord embed, as for a workspace notification.
   *
   *  No buttons: a press runs a workspace action as the person who pressed,
   *  inside the workspace that owns the notification, and an account notice
   *  (a sign-in, a feedback reply) belongs to no workspace. Its link is the
   *  way to act on it. */
  card?: NotificationCard;
  /** Optional richer email than the generic "<message> <link>" fallback.
   *  `replyTo` (optional) carries a tokenized reply-by-email address; `html`
   *  (optional) is a rich body sent alongside `text` (the plaintext fallback). */
  email?: { subject: string; text: string; html?: string; replyTo?: string; from?: string; inReplyTo?: string; references?: string; discordInvite?: boolean };
  /** Set when this notification ANSWERS something the user sent on a specific
   *  channel. An answer goes out on ONE channel (answerChannel): where the
   *  conversation is, unless the person turned that channel off, then the one
   *  they left on. The bell records it either way. Without this, a feedback
   *  reply emailed AND Discord-DM'd the same sentence to the same person
   *  (reported 2026-08-24). NEWS (a parcel arriving, a digest) has no origin
   *  and still fans out to every enabled channel. */
  originChannel?: "email" | "discord_dm" | "in_app";
}

/** The one outbound channel an ANSWER goes out on. The origin channel while
 *  the person has it on; otherwise the one they left on, Discord first (it is
 *  the one they have to have connected). Someone who chose Discord for
 *  feedback replies (email off) gets the DM and no email, whichever door the
 *  report came in by; somebody with every outbound channel off gets the bell
 *  only. Discord counts as on only when it can deliver (verified), so an
 *  answer is never sent into a connection that cannot take it while email
 *  would have. */
export function answerChannel(
  origin: "email" | "discord_dm" | "in_app",
  prefs: Record<PrefChannel, boolean>,
  discordReady: boolean,
): "email" | "discord_dm" | "in_app" {
  if (origin === "in_app") return "in_app";
  const on = { email: prefs.email, discord_dm: prefs.discord_dm && discordReady };
  if (on[origin]) return origin;
  if (on.discord_dm) return "discord_dm";
  if (on.email) return "email";
  return "in_app";
}

/** Deliver an account-level (platform) notification across the user's chosen
 *  channels: in_app (the bell), email (the platform sender), discord_dm (the
 *  bot — only if connected + verified). Honors the Communication Preferences
 *  matrix; a disabled channel is simply skipped. */
/** Whether an account notice may go out on a capped channel now (#7076): it
 *  takes the same per-person slot as a workspace dispatch, so the two funnels
 *  share one hourly budget. A credential (tier 1) is never held. Over the cap
 *  the notice waits for that channel's next summary and the bell says once
 *  that the channel paused. */
async function accountSendSlot(
  args: NotifyAccountParams,
  channel: "email" | "discord_dm",
  notificationId: string | null,
): Promise<"send" | "held" | "capped"> {
  if (tierOf(args.notificationType) === 1) return "send";
  const slot = await takeSendSlot(args.userId, channel);
  if (slot.allowed) return "send";
  if (slot.firstOver) await notePaused({ orgId: args.representativeOrgId, userId: args.userId, channel, slot });
  if (!notificationId) return "capped";
  await enqueueDeferred(meta as never, {
    user_id: args.userId,
    channel,
    notification_id: notificationId,
    org_id: args.representativeOrgId,
    event_type: args.notificationType,
    message: channel === "discord_dm" ? (args.discordMessage ?? args.message) : args.message,
    link_url: args.link_url ?? null,
    priority: args.priority ?? "normal",
    triggered_by: "activity",
  });
  return "held";
}

export async function notifyAccount(
  args: NotifyAccountParams,
): Promise<{ notificationId: string | null; deliveredVia: PrefChannel[]; outcomes: DeliveryOutcomes }> {
  const resolved = await resolveAccountPrefs(args.userId, args.notificationType);
  const prefs = args.only
    ? (Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v && args.only!.includes(k as PrefChannel)])) as typeof resolved)
    : resolved;
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
        priority: args.priority ?? "normal",
        delivered_via: ["in_app"],
        // jsonb-object-ok: one small document, written once, as dispatch does.
        card: args.card ? (JSON.stringify(args.card) as never) : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    sometimesPrune(args.userId);
    announceNotificationChange(args.userId, { kind: "new", id: inserted.id });
    notificationId = inserted.id;
    deliveredVia.push("in_app");
    outcomes.in_app = "sent";
  } else {
    outcomes.in_app = "opted-out";
  }

  const conn =
    args.originChannel || prefs.discord_dm
      ? await meta
          .selectFrom("discord_connections")
          .select(["discord_user_id", "verified", "verified_app_id"])
          .where("user_id", "=", args.userId)
          .executeTakeFirst()
      : undefined;
  const answerOn = args.originChannel ? answerChannel(args.originChannel, prefs, discordConnectionState(conn) === "verified") : undefined;

  // email — only when the caller supplies an email payload (so an event that
  // isn't meant to email never does), gated by the user's pref + the PLATFORM
  // sender (managed mailer in prod), not per-user BYO SMTP.
  if (answerOn && answerOn !== "email") {
    outcomes.email = "ack-on-origin";
  } else if (!args.email) {
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
    const slot = u?.email ? await accountSendSlot(args, "email", notificationId) : null;
    if (!u?.email) {
      outcomes.email = "no-address";
    } else if (slot !== "send") {
      outcomes.email = slot!;
    } else {
      const ok = await sendAuthEmail({ to: u.email, subject: args.email.subject, text: args.email.text, html: args.email.html, kind: "notification", replyTo: args.email.replyTo, from: args.email.from, inReplyTo: args.email.inReplyTo, references: args.email.references });
      if (ok) {
        deliveredVia.push("email");
        await logAccountEmail(args.userId, args.notificationType, args.email.discordInvite === true);
      }
      outcomes.email = ok ? "sent" : "send-failed";
    }
  }

  // discord_dm — only when the user has connected + verified Discord.
  if (answerOn && answerOn !== "discord_dm") {
    outcomes.discord_dm = "ack-on-origin";
  } else if (!prefs.discord_dm) {
    outcomes.discord_dm = "opted-out";
  } else {
    const state = discordConnectionState(conn);
    // Only a DM that would really go takes a send slot.
    const dmSlot = state === "verified" ? await accountSendSlot(args, "discord_dm", notificationId) : null;
    if (state === "not-connected") {
      outcomes.discord_dm = "not-connected";
    } else if (state === "unverified") {
      outcomes.discord_dm = "unverified";
    } else if (state === "stale-app") {
      // Verified, but by a Discord app that is no longer the one sending. The
      // current bot may not share a server with this person, so the DM would
      // vanish rather than fail loudly. Say so instead of sending into it.
      outcomes.discord_dm = "stale-app";
    } else if (dmSlot !== "send") {
      outcomes.discord_dm = dmSlot!;
    } else {
      // The same DM a workspace notification becomes, card and all.
      const res = await sendDiscordDm({
        discord_user_id: conn!.discord_user_id!,
        ...discordDmPayload({
          notificationId: notificationId ?? "",
          message: args.discordMessage ?? args.message,
          link_url: args.link_url ?? null,
          card: args.card ?? null,
          actions: null,
        }),
      });
      if (res.ok) deliveredVia.push("discord_dm");
      outcomes.discord_dm = dmOutcome(res);
      if (dmResultUnverifies(res)) {
        // BLOCKED is durable, not a blip: privacy settings, a bot that shares no
        // server, a deleted account. Leaving `verified` true means every future
        // notification goes quietly nowhere and the settings page keeps claiming
        // Discord works. Dropping it surfaces the reconnect prompt and lets the
        // account-pref fallback route this person somewhere they will see it.
        //
        // A transient failure (bot not configured, non-2xx, timeout) is left
        // alone — dmResultUnverifies is false for those, so a bot restart during
        // a notification wave no longer unverifies everyone at once (audit B4a).
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

/** One row per account email sent (account_email_sends): the weekly count of
 *  feedback emails and each person's Discord-invitation showings both read it.
 *  A failed write is logged and never undoes a send that already happened. */
async function logAccountEmail(userId: string, notificationType: string, discordInvite: boolean): Promise<void> {
  try {
    await meta.insertInto("account_email_sends").values({ user_id: userId, notification_type: notificationType, discord_invite: discordInvite }).execute();
  } catch (err) {
    console.warn("[notify-account] could not record an email send:", (err as Error).message);
  }
}

export interface NotificationListItem {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  /** The substance behind the one-liner, when there is any — same card the
   *  Discord DM renders as an embed, so the bell is not the one surface left
   *  saying "something happened" without saying what. */
  card: NotificationCard | null;
  read_at: Date | null;
  created_at: Date;
  /** When the thing the buttons decide has been decided: how, and when. Its
   *  buttons are gone (notification-subjects.ts). */
  settled: Settled | null;
}

export async function listForUser(
  userId: string,
  orgId: string,
  opts: { limit?: number; unreadOnly?: boolean; before?: string } = {},
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
      "card",
      // The pressable things. Not selected here for a long time, which is why
      // the app could not render a button Discord already showed.
      "actions",
      "read_at",
      "created_at",
      "org_id",
      "entity_type",
      "entity_id",
    ])
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    // Ordered on the millisecond, the precision the page cursor can carry
    // across JSON: comparing microsecond rows against a millisecond cursor
    // skips the rows that fall between the two.
    .orderBy(sql`date_trunc('milliseconds', created_at)`, "desc")
    .orderBy("id", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("read_at", "is", null);
  // `<created_at ISO>|<id>`: strictly after the last row of the previous page
  // in that order, the id breaking a tie between rows of the same millisecond.
  const c = decodeKeysetCursor(opts.before);
  if (c?.id && /^[0-9a-f-]{36}$/i.test(c.id)) {
    q = q.where(sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${c.at}, ${c.id}::uuid)`);
  }
  return (await settleForDisplay(await q.execute())).map(({ org_id: _o, entity_type: _t, entity_id: _i, ...rest }) => rest);
}

export async function markRead(notificationId: string, userId: string): Promise<void> {
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("id", "=", notificationId)
    .where("user_id", "=", userId)
    .execute();
  announceNotificationChange(userId, { kind: "changed", id: notificationId });
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
  opts: { limit?: number; unreadOnly?: boolean; before?: string; orgSlug?: string } = {},
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
      "n.card as card",
      "n.actions as actions",
      "n.read_at as read_at",
      "n.created_at as created_at",
      "n.org_id as org_id",
      "o.name as org_name",
      "o.slug as org_slug",
      "n.entity_type as entity_type",
      "n.entity_id as entity_id",
    ])
    .where("n.user_id", "=", userId)
    // The same order and cursor as one workspace's list (listForUser): on the
    // millisecond, the id breaking a tie, so a page that ends inside a
    // millisecond neither repeats nor skips a row.
    .orderBy(sql`date_trunc('milliseconds', n.created_at)`, "desc")
    .orderBy("n.id", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("n.read_at", "is", null);
  if (opts.orgSlug) q = q.where("o.slug", "=", opts.orgSlug);
  const c = decodeKeysetCursor(opts.before);
  if (c?.id && /^[0-9a-f-]{36}$/i.test(c.id)) {
    q = q.where(sql<boolean>`(date_trunc('milliseconds', n.created_at), n.id) < (${c.at}, ${c.id}::uuid)`);
  }
  return (await settleForDisplay(await q.execute())).map(({ entity_type: _t, entity_id: _i, ...rest }) => rest);
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

/** Back to unread: "I read it and I still have to do it". */
export async function markUnread(notificationId: string, userId: string): Promise<void> {
  await meta
    .updateTable("notifications")
    .set({ read_at: null })
    .where("id", "=", notificationId)
    .where("user_id", "=", userId)
    .execute();
  announceNotificationChange(userId, { kind: "changed", id: notificationId });
}

/** Delete one of a person's own notifications. A digest still waiting to
 *  carry it drops it too (the deferred row cascades). */
export async function remove(notificationId: string, userId: string): Promise<boolean> {
  const gone = await meta.deleteFrom("notifications").where("id", "=", notificationId).where("user_id", "=", userId).returning("id").execute();
  if (gone.length) announceNotificationChange(userId, { kind: "changed", id: notificationId });
  return gone.length > 0;
}

/** Delete every notification a person has read, in every workspace. */
export async function removeRead(userId: string): Promise<number> {
  const gone = await meta.deleteFrom("notifications").where("user_id", "=", userId).where("read_at", "is not", null).returning("id").execute();
  if (gone.length) announceNotificationChange(userId, { kind: "changed" });
  return gone.length;
}

/** How long a notification somebody has READ is kept. An unread one is kept
 *  until it is read or deleted: pruning what nobody has seen would lose it
 *  unread. Before this nothing pruned either, and the table only grew. */
export const READ_RETENTION_DAYS = 180;

/** Drop one person's read notifications past READ_RETENTION_DAYS. Cheap (their
 *  own rows), run now and then as their notifications arrive, never awaited
 *  by the dispatch that triggered it. */
export async function pruneRead(userId: string): Promise<number> {
  const gone = await meta
    .deleteFrom("notifications")
    .where("user_id", "=", userId)
    .where("read_at", "<", sql<Date>`now() - make_interval(days => ${READ_RETENTION_DAYS})`)
    .returning("id")
    .execute();
  return gone.length;
}

function sometimesPrune(userId: string): void {
  if (Math.random() >= 0.05) return;
  void pruneRead(userId).catch((err) => console.error("[notifications] retention prune failed:", (err as Error).message));
}

export async function markAllReadAcrossOrgs(userId: string): Promise<number> {
  const updated = await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .returning("id")
    .execute();
  if (updated.length) announceNotificationChange(userId, { kind: "changed" });
  return updated.length;
}

/**
 * Tell the deployment's OPERATORS that something happened, rather than telling a
 * tenant. `dispatch` is org+user scoped, which is right for "your print finished"
 * and useless for "a stranger just signed up": the new account's own org is the one
 * place nobody wants that notice.
 *
 * So this fans the event out to every address in SUPERADMIN_EMAILS, dispatching under
 * each admin's own first org, exactly as the invite-accepted path already does for the
 * inviter. Each admin then routes it wherever they like through the ordinary
 * notification-channel settings, Discord included, with no special-cased webhook.
 *
 * Failure here must never break the thing being reported, so every admin is attempted
 * independently and errors are logged rather than thrown.
 */
export async function notifyPlatformAdmins(p: {
  eventType: string;
  message: string;
  /** Where the operator acts on it: an admin console page ("/admin/users"). */
  link_url: string;
  priority?: NotificationPriority;
  payload?: unknown;
}): Promise<number> {
  const emails = (env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) return 0;

  let delivered = 0;
  for (const email of emails) {
    try {
      const admin = await meta
        .selectFrom("users")
        .select("id")
        .where(sql`lower(email)`, "=", email)
        .executeTakeFirst();
      if (!admin) continue; // configured but never signed in yet

      // Their first org, same rule the invite path uses to pick a home for the notice.
      const org = await meta
        .selectFrom("org_memberships")
        .select("org_id")
        .where("user_id", "=", admin.id)
        .orderBy("joined_at", "asc")
        .executeTakeFirst();
      if (!org) continue;

      await dispatch({
        orgId: org.org_id,
        userId: admin.id,
        eventType: p.eventType,
        message: p.message,
        link_url: p.link_url,
        priority: p.priority ?? "normal",
        payload: p.payload,
      });
      delivered++;
    } catch (err) {
      console.error(`[notify-admins] ${p.eventType} to ${email} failed:`, err);
    }
  }
  return delivered;
}
