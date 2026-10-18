// Turning on push asks which other channels to turn off (#7070).
//
// The owner turned on notifications in the iPhone Home Screen app and kept
// getting Discord messages: push was set to buzz for high and urgent only, so
// every normal update stayed "bell only" there and went to Discord as before.
// Nothing told him either half. He asked for a question, not an automatic
// switch: after a device is turned on, one prompt lists the other channels
// still carrying his workspace updates, each with "turn off" (all left on),
// and asks whether normal updates should push too. Nothing changes until he
// confirms; skipping changes nothing. A person who turned push on before this
// is asked once, the next time they open their notification settings.
//
// "Off" is a row in notification_channels_off, read by dispatch(): workspace
// updates skip that channel whatever a subscription or an account default
// says. Account notices (a feedback reply, a sign-in alert) are not workspace
// updates and never reach push, so they keep their own choices.

import { meta } from "../db/meta.js";
import type { NotificationPriority } from "../db/schema.js";
import { canDeliverDiscordDm } from "./discord-connection.js";
import { windowsFor } from "./delivery-windows.js";
import { pushSettingsFor } from "./push-delivery.js";
import { worthAPush, inQuietHours } from "./push-policy.js";

/** The personal channels a person can turn off for their workspace updates. */
export const HANDOFF_CHANNELS = ["discord_dm", "email", "discord", "slack", "sms", "webhook"] as const;
export type HandoffChannel = (typeof HANDOFF_CHANNELS)[number];

export const CHANNEL_LABEL: Record<HandoffChannel, string> = {
  discord_dm: "Discord messages",
  email: "Email",
  discord: "A Discord channel",
  slack: "Slack",
  sms: "Text messages",
  webhook: "A webhook",
};

export function isHandoffChannel(c: string): c is HandoffChannel {
  return (HANDOFF_CHANNELS as readonly string[]).includes(c);
}

const ORDER: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "urgent"];

/** The channels this person turned off for their workspace updates. */
export async function channelsOffFor(userId: string): Promise<Set<string>> {
  const rows = await meta.selectFrom("notification_channels_off").select("channel").where("user_id", "=", userId).execute();
  return new Set(rows.map((r) => r.channel));
}

export interface ActiveChannel {
  channel: HandoffChannel;
  label: string;
  /** The lowest priority it carries; "daily" when it carries one message a day. */
  from: NotificationPriority;
  daily: boolean;
}

/** The other channels still carrying this person's workspace updates, as the
 *  dispatcher would send them: a verified Discord connection (DMs go to it by
 *  default from normal up), an enabled binding in any workspace, and email
 *  once it is on a daily window. Channels turned off are left out. */
export async function activeOtherChannels(userId: string): Promise<ActiveChannel[]> {
  const [off, conn, subs, windows] = await Promise.all([
    channelsOffFor(userId),
    meta.selectFrom("discord_connections").select(["discord_user_id", "verified", "verified_app_id"]).where("user_id", "=", userId).executeTakeFirst(),
    meta.selectFrom("notification_subscriptions").select(["channel", "min_priority"]).where("user_id", "=", userId).where("enabled", "=", true).execute(),
    windowsFor(meta as never, userId),
  ]);
  const from = new Map<HandoffChannel, NotificationPriority>();
  const lower = (c: HandoffChannel, p: NotificationPriority) => {
    const had = from.get(c);
    if (!had || ORDER[p] < ORDER[had]) from.set(c, p);
  };
  if (canDeliverDiscordDm(conn)) lower("discord_dm", "normal");
  for (const s of subs) if (isHandoffChannel(s.channel)) lower(s.channel, s.min_priority);
  if (windows.get("email")?.mode === "daily") lower("email", "normal");
  return [...from.entries()]
    .filter(([c]) => !off.has(c))
    .map(([channel, p]) => ({ channel, label: CHANNEL_LABEL[channel], from: p, daily: windows.get(channel)?.mode === "daily" }))
    .sort((a, b) => HANDOFF_CHANNELS.indexOf(a.channel) - HANDOFF_CHANNELS.indexOf(b.channel));
}

export interface Handoff {
  /** Show the prompt: a device is on and the person has not been asked. */
  due: boolean;
  channels: ActiveChannel[];
  /** Does push already carry normal updates? */
  normal_pushes: boolean;
}

export async function handoffFor(userId: string): Promise<Handoff> {
  const [row, devices, channels, settings] = await Promise.all([
    meta.selectFrom("push_settings").select("handoff_asked_at").where("user_id", "=", userId).executeTakeFirst(),
    meta.selectFrom("push_subscriptions").select("id").where("user_id", "=", userId).limit(1).execute(),
    activeOtherChannels(userId),
    pushSettingsFor(userId),
  ]);
  const normal_pushes = ORDER[settings.min_priority] <= ORDER.normal;
  const due = devices.length > 0 && !row?.handoff_asked_at && (channels.length > 0 || !normal_pushes);
  return { due, channels, normal_pushes };
}

export interface HandoffAnswer {
  turn_off: HandoffChannel[];
  /** Yes: normal updates push too. No: the threshold stays where it is. */
  normal_here: boolean;
  /** The device's timezone, taken when the account still has the UTC default. */
  timezone?: string;
}

/** The person confirmed the prompt: exactly what they chose, and the stamp. */
export async function applyHandoff(userId: string, a: HandoffAnswer): Promise<void> {
  const settings = await pushSettingsFor(userId);
  const set: { handoff_asked_at: Date; updated_at: Date; min_priority?: NotificationPriority; timezone?: string } = {
    handoff_asked_at: new Date(),
    updated_at: new Date(),
  };
  if (a.normal_here && ORDER[settings.min_priority] > ORDER.normal) set.min_priority = "normal";
  if (a.timezone && settings.timezone === "UTC") set.timezone = a.timezone;
  await meta.transaction().execute(async (trx) => {
    await trx
      .insertInto("push_settings")
      .values({ user_id: userId, ...set })
      .onConflict((oc) => oc.column("user_id").doUpdateSet(set))
      .execute();
    if (a.turn_off.length) {
      await trx
        .insertInto("notification_channels_off")
        .values(a.turn_off.map((channel) => ({ user_id: userId, channel })))
        .onConflict((oc) => oc.columns(["user_id", "channel"]).doNothing())
        .execute();
    }
  });
}

/** Skipped: nothing changes, and the prompt is not shown again. */
export async function skipHandoff(userId: string): Promise<void> {
  const set = { handoff_asked_at: new Date(), updated_at: new Date() };
  await meta
    .insertInto("push_settings")
    .values({ user_id: userId, ...set })
    .onConflict((oc) => oc.column("user_id").doUpdateSet(set))
    .execute();
}

/** Turn one channel off, or back on, for the person's workspace updates. */
export async function setChannelOff(userId: string, channel: HandoffChannel, off: boolean): Promise<void> {
  if (off) {
    await meta.insertInto("notification_channels_off").values({ user_id: userId, channel }).onConflict((oc) => oc.columns(["user_id", "channel"]).doNothing()).execute();
  } else {
    await meta.deleteFrom("notification_channels_off").where("user_id", "=", userId).where("channel", "=", channel).execute();
  }
}

/** The device's timezone, when the person still has the UTC default. */
export async function adoptDeviceTimezone(userId: string, timezone: string | undefined): Promise<void> {
  if (!timezone || timezone === "UTC") return;
  const settings = await pushSettingsFor(userId);
  if (settings.timezone !== "UTC") return;
  const set = { timezone, updated_at: new Date() };
  await meta
    .insertInto("push_settings")
    .values({ user_id: userId, ...set })
    .onConflict((oc) => oc.column("user_id").doUpdateSet(set))
    .execute();
}

export interface PriorityRoute {
  priority: NotificationPriority;
  /** What push does with it now. */
  push: "pushed" | "held" | "bell only";
  /** The other channels it also goes to. */
  also: string[];
}

/** Per priority, where a workspace update goes: so "bell only" on push is
 *  never a surprise, and neither is a Discord DM still arriving. */
export function routesByPriority(
  settings: Awaited<ReturnType<typeof pushSettingsFor>>,
  channels: ActiveChannel[],
  hasDevice: boolean,
  now: Date,
): PriorityRoute[] {
  return PRIORITIES.map((priority) => ({
    priority,
    push: !hasDevice || !worthAPush(priority, settings) ? "bell only" : priority !== "urgent" && inQuietHours(settings, now) ? "held" : "pushed",
    also: channels.filter((c) => ORDER[priority] >= ORDER[c.from]).map((c) => (c.daily ? `${c.label} (once a day)` : c.label)),
  }));
}

