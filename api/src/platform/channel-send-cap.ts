// The send cap per person per channel per hour (#6908): the counter and the
// one notice. The rule and its defaults are channel-send-cap-rule.ts.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { CHANNEL_SEND_CAP_DEFAULTS, parseSendCaps, pausedSentence, type CappedChannel } from "./channel-send-cap-rule.js";

const caps = parseSendCaps(env.NOTIFY_SEND_CAP_PER_HOUR);

export function isCapped(channel: string): channel is CappedChannel {
  return channel in CHANNEL_SEND_CAP_DEFAULTS;
}

export interface SendSlot {
  /** Under the cap: send now. */
  allowed: boolean;
  /** This send is the first over the cap this hour: say so once. */
  firstOver: boolean;
  cap: number;
  /** When the hour ends and sends go again. */
  resumesAt: Date;
}

const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

/** Count one send for (person, channel) this hour, atomically, and say whether
 *  it may go. Past hours' rows for the pair are pruned as it counts. */
export async function takeSendSlot(userId: string, channel: CappedChannel, now = new Date()): Promise<SendSlot> {
  const windowStart = hourOf(now);
  const row = await sql<{ sends: number }>`
    insert into notification_send_counts (user_id, channel, window_start, sends)
    values (${userId}, ${channel}, ${windowStart}, 1)
    on conflict (user_id, channel, window_start) do update set sends = notification_send_counts.sends + 1
    returning sends
  `.execute(meta);
  const sends = row.rows[0]!.sends;
  if (sends === 1) {
    await sql`delete from notification_send_counts where user_id = ${userId} and channel = ${channel} and window_start < ${windowStart}`.execute(meta);
  }
  const cap = caps[channel];
  return { allowed: sends <= cap, firstOver: sends === cap + 1, cap, resumesAt: new Date(windowStart.getTime() + 3_600_000) };
}

/** The bell's one notice that a channel is paused, written straight to the
 *  person's notifications (the bell is never capped, and the notice must not
 *  itself go out through the channel it is about). Once per channel per hour. */
export async function notePaused(args: { orgId: string; userId: string; channel: CappedChannel; slot: SendSlot; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const minutesLeft = Math.max(1, Math.ceil((args.slot.resumesAt.getTime() - now.getTime()) / 60_000));
  await meta
    .insertInto("notifications")
    .values({
      dedupe_key: `channel-paused:${args.channel}:${args.slot.resumesAt.toISOString()}`,
      org_id: args.orgId,
      user_id: args.userId,
      event_type: "notifications.channel_paused",
      module_name: null,
      entity_type: null,
      entity_id: null,
      message: pausedSentence(args.channel, args.slot.cap, minutesLeft),
      // PAGE-LINK: the pause is about a channel, not a record; its settings page is where it is changed.
      link_url: "/me/notification-channels",
      priority: "normal",
      card: null,
      actions: null,
      delivered_via: ["in_app"],
    } as never)
    .onConflict((oc) => oc.columns(["org_id", "user_id", "dedupe_key"]).doNothing())
    .execute();
}
