// The Discord invitation in the two feedback emails, shown only while it can
// still help (#4318).
//
// Every feedback email costs money; a reply that reaches someone on Discord
// costs nothing and arrives sooner. So both emails carry a short section with
// up to two lines, each hidden once it has done its job:
//   - the community line, until the person is in the community server (the
//     bot asks Discord; an unknown answer shows it, never guesses "member");
//   - the connect line, until Discord is linked, when it becomes the line that
//     switches feedback replies over to Discord.
// The whole section stops after three showings per person, and never appears
// where Discord cannot be connected (discordConnectConfigured).
//
// The rule is discordInviteLines, pure, so the table of who sees what is a
// test; discordInviteFor gathers the facts it needs.

import { productName } from "./product-name.js";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { discordConnectConfigured } from "./discord-oauth.js";
import { discordInviteUrl } from "./community.js";
import { discordConnectionState } from "./discord-connection.js";
import { discordCommunityMember } from "./discord-bot-trigger.js";
import { emailableUrl } from "./link-origin.js";
import type { EmailLine } from "./email-html.js";

/** A person sees the invitation in at most this many feedback emails. */
export const DISCORD_INVITE_MAX_SHOWINGS = 3;

/** Where the Discord connection and the feedback-replies row live. */
const SETTINGS_PATH = "/me/communication";
const FEEDBACK_ROW = "platform.feedback.replied";

export interface DiscordInviteFacts {
  /** Discord can be connected on this server at all. */
  connectable: boolean;
  /** The community invite (discordInviteUrl), or null when unset. */
  inviteUrl: string | null;
  /** Feedback emails already sent to this person with the invitation. */
  shown: number;
  /** Discord is linked and verified for this person. */
  linked: boolean;
  /** In the community server: true, false, or null when nobody could say. */
  member: boolean | null;
  /** Absolute base of this surface, for the settings links. */
  appUrl: (path: string) => string | null;
}

/** Which lines the invitation carries for this person; none means no section. */
export function discordInviteLines(f: DiscordInviteFacts): EmailLine[] {
  if (!f.connectable || f.shown >= DISCORD_INVITE_MAX_SHOWINGS) return [];
  const lines: EmailLine[] = [];
  if (f.inviteUrl && f.member !== true) {
    lines.push([
      `Join the ${productName()} community on Discord to ask questions, share your projects, and see what's new: `,
      { text: f.inviteUrl.replace(/^https?:\/\//, ""), href: f.inviteUrl },
    ]);
  }
  // Where no address can be given, the words stay and the link is dropped.
  const to = (text: string, path: string): string | { text: string; href: string } => {
    const href = f.appUrl(path);
    return href ? { text, href } : text;
  };
  lines.push(
    f.linked
      ? [
          "You've connected Discord, so these replies can come there instead of by email: ",
          to("switch feedback replies to Discord", `${SETTINGS_PATH}#${FEEDBACK_ROW}`),
          ".",
        ]
      : [
          "Get our replies as a Discord message: ",
          to("open your notification settings", SETTINGS_PATH),
          " and connect Discord (it's under ",
          { strong: "Your account → Notifications" },
          ").",
        ],
  );
  return lines;
}

/** The invitation for this person, now. A person who is not linked has no
 *  Discord id to ask about, so the community line shows for them. */
export async function discordInviteFor(userId: string): Promise<EmailLine[]> {
  const connectable = discordConnectConfigured();
  if (!connectable) return [];
  const shownRow = await meta
    .selectFrom("account_email_sends")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("user_id", "=", userId)
    .where("discord_invite", "=", true)
    .executeTakeFirst();
  const shown = shownRow?.n ?? 0;
  if (shown >= DISCORD_INVITE_MAX_SHOWINGS) return [];
  const conn = await meta
    .selectFrom("discord_connections")
    .select(["discord_user_id", "verified", "verified_app_id"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const linked = discordConnectionState(conn) === "verified";
  const member = linked && conn?.discord_user_id ? await discordCommunityMember(conn.discord_user_id) : null;
  return discordInviteLines({ connectable, inviteUrl: discordInviteUrl() || null, shown, linked, member, appUrl: emailableUrl });
}
