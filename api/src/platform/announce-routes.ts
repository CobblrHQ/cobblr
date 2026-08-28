// Where an announcement goes when the thing it is about came from somewhere.
//
// Feedback raised in a community chat server should surface IN that server,
// privately, rather than making the operator switch to a separate ops server to
// read it. Feedback from the in-app form has no chat origin and must NOT go
// there: it carries workspace names and user email addresses, and a community
// server is a different audience from an ops one even when both channels are
// private today.
//
// So the destination is a function of the ORIGIN, and the origin is a Discord
// guild id that the ingest already knows. Config is data:
//
//   COBBLR_FEEDBACK_DISCORD_ROUTES=<guild-id>=<webhook-url> <guild-id>=<url>
//
// Anything with no matching route falls back to the per-category webhook and
// then to COBBLR_FEEDBACK_DISCORD_WEBHOOK, so an instance that sets none of this
// behaves exactly as before.
//
// A leaf module on purpose, like announce-url.ts: announce.ts reaches db/meta,
// which reaches env, which calls process.exit(1) when the database vars are
// absent. Keeping the branching here is what makes it unit-testable.

/**
 * Parse `COBBLR_FEEDBACK_DISCORD_ROUTES` into guild id -> webhook URL.
 *
 * Entries are `<guild-id>=<url>`, separated by whitespace, newlines or commas.
 * A comma cannot appear in a Discord webhook URL, so splitting on it is safe.
 *
 * Malformed entries are DROPPED rather than half-kept. The failure this guards
 * against is a routing table that silently gains an entry keyed by "" or one
 * pointing at a non-URL: the first would match feedback with no origin and send
 * private in-app reports to a community server, which is the exact mistake the
 * split exists to prevent.
 */
export function parseAnnounceRoutes(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of String(raw || "").split(/[\s,]+/)) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const guild = entry.slice(0, eq);
    const url = entry.slice(eq + 1);
    if (!/^\d{5,}$/.test(guild)) continue;
    if (!/^https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/\S+$/.test(url)) continue;
    out.set(guild, url);
  }
  return out;
}

/**
 * The webhook for something that originated in `guildId`, or null to fall back.
 *
 * Null when there is no origin at all — that is the in-app case, and it must
 * take the default rather than any route.
 */
export function routeForGuild(guildId: string | null | undefined, raw: string | undefined): string | null {
  if (!guildId) return null;
  return parseAnnounceRoutes(raw).get(guildId) ?? null;
}
