// Is this Discord connection still good, given which app is sending today?
//
// `verified` means "a test DM arrived". It does not say WHO sent it, and a DM
// channel belongs to a BOT rather than to Cobblr: a bot may only DM someone it
// shares a server with, and that permission does not transfer when the server
// is pointed at a different Discord application.
//
// So after an app switch every existing row still reads `verified: true` while
// the new bot may have no way to reach the person at all. Nothing errors.
// notifications.ts writes `outcomes.discord_dm = "blocked"` and moves on, so
// they simply stop hearing anything and nobody finds out — the same silent
// shape as a green test that never ran.
//
// One function decides it, so the settings page, the dispatcher and anything
// added later cannot drift on the answer.

import { discordAppId } from "./discord-oauth.js";

/** The stored half of a connection this question needs. */
export interface StoredDiscordConnection {
  discord_user_id: string | null;
  verified: boolean;
  verified_app_id?: string | null;
}

export type DiscordConnectionState =
  /** No Discord account linked at all. */
  | "not-connected"
  /** Linked, but the test DM was never confirmed. */
  | "unverified"
  /** Confirmed, by an app that is no longer the one sending. Re-prove it. */
  | "stale-app"
  /** Confirmed by the app that is sending today. */
  | "verified";

/**
 * NULL `verified_app_id` is GRANDFATHERED, deliberately.
 *
 * Those rows were verified before the column existed, so treating them as stale
 * would prompt every existing user the moment this ships — for a switch that
 * has not happened yet. They count as verified and get stamped with whatever
 * app is configured when they are next confirmed, which means exactly one
 * prompt, at the moment the app genuinely changes.
 *
 * An unconfigured server (`discordAppId()` empty) never reports "stale-app":
 * with no app there is nothing to disagree with, and un-verifying everyone
 * because an env var went missing would be its own outage.
 */
export function discordConnectionState(
  conn: StoredDiscordConnection | null | undefined,
): DiscordConnectionState {
  if (!conn?.discord_user_id) return "not-connected";
  if (!conn.verified) return "unverified";
  const current = discordAppId();
  if (!current) return "verified";
  const stamped = conn.verified_app_id ?? null;
  if (stamped === null) return "verified";
  return stamped === current ? "verified" : "stale-app";
}

/** Can we put a notification in front of this person over Discord right now?
 *
 *  "stale-app" is deliberately NOT deliverable. Sending into a channel the
 *  current bot may not own is how the silence starts. */
export function canDeliverDiscordDm(conn: StoredDiscordConnection | null | undefined): boolean {
  return discordConnectionState(conn) === "verified";
}

/** Does this row need stamping on the way past? True only for a grandfathered
 *  row on a configured server — a cheap lazy backfill that avoids a data
 *  migration and cannot prompt anybody. */
export function needsAppStamp(conn: StoredDiscordConnection | null | undefined): boolean {
  return (
    !!conn?.discord_user_id &&
    conn.verified &&
    (conn.verified_app_id ?? null) === null &&
    discordAppId() !== ""
  );
}
