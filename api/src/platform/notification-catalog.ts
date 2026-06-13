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

/** Default enablement when a user has no explicit pref row:
 *  in_app ON, email ON, discord_dm OFF (hidden until connected). */
export function defaultEnabled(channel: PrefChannel): boolean {
  return channel === "in_app" || channel === "email";
}
