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
import { sendDiscordDm } from "../discord-bot-trigger.js";
import { absoluteAppUrl } from "../public-url.js";
import { componentsFor } from "./discord-card.js";
import type { Channel, ChannelEvent } from "./types.js";

export const discordDmChannel: Channel = {
  name: "discord_dm",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const conn = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id", "verified"])
      .where("user_id", "=", event.userId)
      .executeTakeFirst();
    if (!conn?.verified || !conn.discord_user_id) {
      // Not connected/verified — nothing to do. Other channels still deliver.
      return false;
    }

    const text = event.link_url
      ? `${event.message}\n${absoluteAppUrl(event.link_url)}`
      : event.message;

    const res = await sendDiscordDm({
      discord_user_id: conn.discord_user_id,
      text,
      // Undefined when the notification offers nothing to do, which is most of
      // them — the bot then sends exactly what it sent before.
      components: componentsFor(event.notificationId, event.actions),
    });
    return res.ok;
  },
};
