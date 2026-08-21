// Account-level notification types for the Communication Preferences matrix
// (Account Settings). Two tiers:
//   • Tier 1 — critical, EMAIL-LOCKED. Never configurable; shown in the matrix
//     as "Always email" (password reset, magic link, billing, account deletion).
//     These ride the auth-email path, not the channel matrix — listed here only
//     so the UI can render the locked rows honestly.
//   • Tier 2 — time-sensitive / fun, channel-configurable across in_app /
//     discord_dm / email. These flow through notifyAccount().

export type PrefChannel = "in_app" | "discord_dm" | "email";

export interface NotificationTypeDef {
  key: string;
  label: string;
  description: string;
  tier: 1 | 2;
}

export const NOTIFICATION_TYPES: NotificationTypeDef[] = [
  // ── Tier 1 — always email, locked ──────────────────────────────────────────
  { key: "auth.magic_link", label: "Magic sign-in link", description: "Your one-tap login links.", tier: 1 },
  { key: "auth.security", label: "Password & security", description: "Password resets and 2FA changes.", tier: 1 },
  { key: "billing", label: "Subscription & billing", description: "Plan, payment and billing notices.", tier: 1 },
  { key: "account.deletion", label: "Account deletion", description: "Confirmation when an account is deleted.", tier: 1 },
  { key: "platform.account.notice", label: "Important notices", description: "Breaking changes or actions that affect your access — e.g. a workspace web address change.", tier: 1 },
  // ── Tier 2 — configurable ───────────────────────────────────────────────────
  { key: "platform.feedback.replied", label: "Feedback responses", description: "When we reply to or ship the feedback you sent.", tier: 2 },
  { key: "platform.feature.announced", label: "Feature announcements", description: "New features and bundle releases.", tier: 2 },
  { key: "platform.workspace.update", label: "Workspace updates", description: "Notable changes in your workspaces.", tier: 2 },
  { key: "platform.ai.share_offered", label: "AI-sharing offers", description: "When a member offers to share their AI with a workspace you own.", tier: 2 },
  { key: "platform.claude.message", label: "Messages from Claude", description: "Personalized notes from your Cobblr assistant.", tier: 2 },
];

/** The matrix columns, in display order — Discord before email (Discord is the
 *  faster/cooler channel). The UI only renders the discord_dm column once the
 *  user has connected + verified Discord. */
export const PREF_CHANNELS: PrefChannel[] = ["in_app", "discord_dm", "email"];

const BY_KEY = new Map(NOTIFICATION_TYPES.map((t) => [t.key, t] as const));

export function notificationTypeDef(key: string): NotificationTypeDef | undefined {
  return BY_KEY.get(key);
}

export function isTier2(key: string): boolean {
  return BY_KEY.get(key)?.tier === 2;
}

export function isPrefChannel(c: string): c is PrefChannel {
  return c === "in_app" || c === "discord_dm" || c === "email";
}

/** Default enablement when a user has no explicit pref row.
 *
 *  in_app and email are always on. Discord follows the connection: OFF for
 *  someone who has not linked an account, ON once they have VERIFIED one.
 *
 *  That last part was the other way round, and it was wrong. Linking Discord
 *  here is not a general identity link with notifications as one possible use —
 *  it exists for this and nothing else, and `verified` only flips true after
 *  the person confirms a test DM. Someone who completes an OAuth flow and then
 *  confirms the DM has said "send me things here" as clearly as it can be said.
 *  Making them say it again in a different screen is ceremony, not consent, and
 *  in practice it meant a connected account that silently received nothing.
 *
 *  EXCEPT tier 1. Sign-in links, password resets, 2FA changes and billing keep
 *  their existing channels: a credential is not something to put in a chat DM
 *  by default, and unlike everything else here, tier 1 cannot be turned off
 *  afterwards. The opt-in someone gave was for being told things, not for
 *  moving their auth. */
export function defaultEnabled(
  channel: PrefChannel,
  ctx?: { discordVerified?: boolean; tier?: 1 | 2 },
): boolean {
  if (channel === "in_app" || channel === "email") return true;
  if (channel === "discord_dm") return !!ctx?.discordVerified && ctx.tier !== 1;
  return false;
}

/** The tier a notification type belongs to, for `defaultEnabled`. Unknown
 *  types are treated as tier 2: a module's own notification is ordinary news,
 *  not a credential. */
export function tierOf(key: string): 1 | 2 {
  return BY_KEY.get(key)?.tier === 1 ? 1 : 2;
}
