// The one link every "Connect Discord" door uses: the Delivery page, which
// starts Discord's consent at once when opened this way, and returns with the
// test message sent and the morning digest chosen (me.ts oauth-start).
export const CONNECT_DISCORD_PATH = "/me/communication?connect=discord";

/** The getting-started step for a collection whose things carry a date. */
export const DISCORD_REMINDER_STEP = {
  label: "Get reminders on Discord",
  module: "me",
  path: CONNECT_DISCORD_PATH,
  hint: "A message before things go off, and one morning list",
} as const;
