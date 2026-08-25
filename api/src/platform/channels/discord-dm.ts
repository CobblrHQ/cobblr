// Discord DM channel — delivers a notification as a direct message to the user's
// VERIFIED Discord account. Unlike the `discord` webhook channel (which posts to
// a server channel and reads a per-subscription webhook_url), this targets the
// user's linked Discord identity in discord_connections — there is no
// per-subscription config. Skips (returns false) when the user hasn't connected
// + verified Discord, so an unverified link never silently swallows
// notifications.
//
// ONE bot sends everything. This briefly grew a second sender for a separate
// "notifications" app, on the reasoning that a button belongs to the app that
// owns the message and the existing app was "the support bot". Both halves were
// wrong: that app already does releases and announcements as well as support,
// and two Cobblr bots in one DM list is worse than the coupling it avoided —
// a person who replies to a notification would be talking to a bot that cannot
// hear them. So the actions ride the existing /dm door, which already attaches
// a button for the verification flow.
//
// See docs/design-decisions/discord-workspace-app.md.

import { meta } from "../../db/meta.js";
import { sendDiscordDm, dmResultUnverifies } from "../discord-bot-trigger.js";
import { canDeliverDiscordDm } from "../discord-connection.js";
import { absoluteAppUrl } from "../public-url.js";
import { componentsFor } from "./discord-card.js";
import type { Channel, ChannelEvent } from "./types.js";

export const discordDmChannel: Channel = {
  name: "discord_dm",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const conn = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id", "verified", "verified_app_id"])
      .where("user_id", "=", event.userId)
      .executeTakeFirst();
    // The SAME question notifyAccount asks, through the same function. This
    // used to check bare `verified`, which meant a subscription-routed
    // notification kept sending into a connection whose verifying app is no
    // longer the one talking — the exact silent dead channel `stale-app`
    // exists to prevent, alive on one of the two delivery paths.
    if (!canDeliverDiscordDm(conn)) {
      // Not connected / unverified / stale — nothing to do here. Other
      // channels still deliver, and the settings page says what is wrong.
      return false;
    }

    // With a card, the EMBED carries the link (its title is clickable) and the
    // button carries the answer — a bare URL line under the sentence is the
    // exact thing the card replaced. Without a card there is nothing else to
    // click, so the link stays in the text.
    //
    // plainForm is the DEGRADED shape: if Discord rejects the rich payload
    // (malformed embed, component limit change), the bot retries with this, so
    // a render failure costs the decoration and never the notification.
    const plainForm = event.link_url
      ? `${event.message}\n${absoluteAppUrl(event.link_url)}`
      : event.message;
    const text = event.card ? event.message : plainForm;

    // The card becomes ONE embed. Discord renders it with a coloured spine and
    // its own block, which is what makes a notification readable at a glance
    // instead of a sentence you have to act on to understand. The one-line
    // `text` stays either way: it is what the phone's lock screen previews, and
    // what the interactions endpoint reads back as the message's "original".
    const embeds = event.card
      ? [
          {
            ...(event.card.heading ? { title: event.card.heading.slice(0, 250) } : {}),
            ...(event.card.body ? { description: event.card.body.slice(0, 4000) } : {}),
            ...(event.card.context ? { footer: { text: event.card.context.slice(0, 2000) } } : {}),
            ...(event.link_url ? { url: absoluteAppUrl(event.link_url) } : {}),
            color: 0xc98a3f,
          },
        ]
      : undefined;

    const res = await sendDiscordDm({
      discord_user_id: conn!.discord_user_id!,
      text,
      ...(embeds ? { embeds } : {}),
      // Undefined when the notification offers nothing to do, which is most of
      // them — the bot then sends exactly what it sent before.
      components: componentsFor(event.notificationId, event.actions),
      fallback_text: plainForm,
    });
    if (dmResultUnverifies(res)) {
      // Durable refusal (privacy settings, no shared server, deleted account):
      // same treatment as the account-pref path (audit B4a), because a
      // connection that cannot be reached must stop claiming it can, whichever
      // path discovered it. Transient failures are left alone.
      await meta
        .updateTable("discord_connections")
        .set({ verified: false, updated_at: new Date() })
        .where("user_id", "=", event.userId)
        .execute();
    }
    return res.ok;
  },
};
