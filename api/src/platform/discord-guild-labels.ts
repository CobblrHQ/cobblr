// Which chat server a Discord-origin report came from, as a name a human reads.
//
// One operator can run more than one server — a private ops one and a public
// community one — and the console showed a flat "discord" chip for both. With
// two servers that is the difference between "somebody on my team" and "a user
// in public", and it was not on the card.
//
//   COBBLR_DISCORD_GUILD_LABELS=<guild-id>=Community <guild-id>=Ops
//
// Resolved server-side so the label lives in one place instead of every client
// carrying a copy of the map. Unset, cards render exactly as before.
//
// A leaf module for the same reason as announce-routes.ts: no database import,
// so a unit test can reach it.

/** Parse the config into guild id -> label. Malformed entries are dropped. */
export function parseGuildLabels(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of String(raw || "").split(/[\s,]+/)) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const guild = entry.slice(0, eq);
    const label = entry.slice(eq + 1).trim();
    // A whitelist, not a blacklist: only a snowflake is a guild id, and a label
    // has to be something worth printing. An entry keyed by "" would otherwise
    // attach a server name to every report that has no server at all.
    if (!/^\d{5,}$/.test(guild)) continue;
    if (!label) continue;
    out.set(guild, label.slice(0, 40));
  }
  return out;
}

/**
 * The label for a report's origin, or null when there is nothing honest to say.
 *
 * Null for a report with no guild — which is every in-app submission, and also
 * every Discord report filed before the guild was recorded. Those must stay
 * unlabelled rather than be attributed to a default server: a wrong server on
 * the card is worse than no server, because it reads as fact.
 */
export function guildLabelFor(
  guildId: string | null | undefined,
  raw: string | undefined,
): string | null {
  // No explicit empty-guild guard: the parser cannot produce an empty key, so a
  // lookup of "" or undefined misses and returns null on its own. A guard here
  // would read as load-bearing and be dead code.
  return parseGuildLabels(raw).get(guildId ?? "") ?? null;
}
