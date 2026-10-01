// The one link every "Connect Discord" door uses: the Delivery page, which
// starts Discord's consent at once when opened this way, and returns with the
// test message sent and the morning digest chosen (me.ts oauth-start).
//
// And the one rule every such door asks before it shows: a server with no
// Discord app or no bot to send the test message (a self-hoster, staging) can
// start a connect and never finish it. There a door is not a slower way in, it
// is a dead end, so it is not drawn at all. The page itself says once, to the
// people who can change it, that Discord is not set up here.
// (a-server-with-no-discord-never-offers-to-connect-discord.test.tsx holds every
// door to it.)
export const CONNECT_DISCORD_PATH = "/me/communication?connect=discord";

/** The getting-started step for a collection whose things carry a date. */
export const DISCORD_REMINDER_STEP = {
  label: "Get reminders on Discord",
  module: "me",
  path: CONNECT_DISCORD_PATH,
  hint: "A message before things go off, and one morning list",
} as const;

export interface DiscordStatusLike {
  configured?: boolean;
  verified?: boolean;
}

/** Whether this server can finish connecting Discord. Unknown (still loading,
 *  or the status call failed) answers no: a door that appears a moment late
 *  costs nothing, one that leads nowhere costs the person's trust. */
export function discordConnectable(status: DiscordStatusLike | undefined): boolean {
  return !!status?.configured;
}

/** Whether a door to `to` leads somewhere: every door does, except the
 *  connect link on a server that cannot finish it. */
export function doorLeadsSomewhere(to: string | undefined, status: DiscordStatusLike | undefined): boolean {
  return to !== CONNECT_DISCORD_PATH || discordConnectable(status);
}
