// Fire-and-forget poke to the Discord support bot when a discord-origin ticket
// is resolved → the bot posts the reply into the ticket's thread and marks it
// done. No-op when COBBLR_DISCORD_BOT_URL is unset (the bot isn't running). The
// bot is the only thing that holds a Discord connection; the API never talks to
// Discord directly. `||` not `??` for the env default (core CLAUDE.md §14.6).

const BOT_URL = process.env.COBBLR_DISCORD_BOT_URL || "";

export interface DiscordResolvePoke {
  thread_id: string;
  /** What to post into the thread (the reporter-facing reply). */
  text: string;
}

export function pokeDiscordResolved(ref: DiscordResolvePoke): void {
  if (!BOT_URL) return;
  void (async () => {
    try {
      await fetch(`${BOT_URL.replace(/\/+$/, "")}/resolved`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* the thread just won't get the auto-reply — not worth failing the resolve. */
    }
  })();
}
