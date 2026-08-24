// Discord OAuth (`identify` scope) for the discord_dm notification channel.
// Links a user's Discord identity so the bot can DM them. All env-gated: open
// core / self-host without a Discord app just doesn't show the option.
//
//   start    → discordAuthorizeUrl(state)  (state = short-lived signed token
//              binding the flow to the user, CSRF-safe)
//   callback → exchangeCodeForIdentity(code) → { id, username }
//
// The DM itself goes through the bot (sendDiscordDm); this module only resolves
// WHO. `||` not `??` for env defaults (core CLAUDE.md §14.6).

import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";
import { publicBaseUrl } from "./public-url.js";

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
// Must match a redirect registered on the Discord app. Defaults to the public
// base + the callback route when COBBLR_PUBLIC_URL is set.
const REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  (publicBaseUrl() ? `${publicBaseUrl()}/api/v1/me/discord/oauth-callback` : "");

const STATE_ALG = "HS256";
const STATE_AUD = "discord-oauth";
const STATE_TTL_SECONDS = 10 * 60;

export function discordOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

/** The Discord APPLICATION currently configured, as its client id.
 *
 *  A DM channel belongs to a bot, not to Cobblr. Swap the app and every stored
 *  `verified` becomes a claim about a bot that is no longer sending — one that
 *  fails silently, because an undeliverable DM is recorded as an outcome and
 *  nothing else. So verification is stamped with the app that proved it, and a
 *  mismatch means re-prove rather than assume.
 *
 *  "" when unconfigured, which reads as "no app", never as "matches". */
export function discordAppId(): string {
  return CLIENT_ID;
}

/** Optional invite link to the Cobblr Discord server — offered when a test DM
 *  bounces (joining a shared server unblocks DMs). "" when unset. */
export function discordInviteUrl(): string {
  return process.env.DISCORD_INVITE_URL || process.env.COBBLR_DISCORD_INVITE_URL || "";
}

/** Sign a short-lived state token binding the OAuth round-trip to one user. */
export async function signOAuthState(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: STATE_ALG })
    .setIssuer("cobblr")
    .setAudience(STATE_AUD)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}

/** Verify a state token; returns the bound user id or null. */
export async function verifyOAuthState(state: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(state, new TextEncoder().encode(env.JWT_SECRET), {
      issuer: "cobblr",
      audience: STATE_AUD,
      algorithms: [STATE_ALG],
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function discordAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${p.toString()}`;
}

export interface DiscordIdentity {
  id: string;
  username: string;
}

/** Exchange the OAuth code for a token, then fetch the user's identity. Returns
 *  null on any failure (caller surfaces a friendly error). */
export async function exchangeCodeForIdentity(code: string): Promise<DiscordIdentity | null> {
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) return null;
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return null;
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!meRes.ok) return null;
    const u = (await meRes.json()) as { id?: string; username?: string; global_name?: string };
    if (!u.id) return null;
    return { id: String(u.id), username: String(u.global_name || u.username || "discord-user") };
  } catch {
    return null;
  }
}
