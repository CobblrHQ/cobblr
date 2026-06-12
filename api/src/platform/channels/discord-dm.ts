// Discord DM channel — delivers a notification as a direct message to the user's
// VERIFIED Discord account, via the bot. Unlike the `discord` webhook channel
// (which posts to a server channel and reads a per-subscription webhook_url),
// this targets the user's linked Discord identity in discord_connections — there
// is no per-subscription config. Skips (returns false) when the user hasn't
// connected + verified Discord, so an unverified link never silently swallows
// notifications. The bot is the only thing holding a Discord connection.

import { meta } from "../../db/meta.js";
import { sendDiscordDm } from "../discord-bot-trigger.js";
import { absoluteAppUrl } from "../public-url.js";
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
    const res = await sendDiscordDm({ discord_user_id: conn.discord_user_id, text });
    return res.ok;
  },
};
