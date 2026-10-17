// How many notices one person's channel may send in an hour (#6908). PURE, and
// free of imports, so env.ts can validate an override with it at boot.
//
// Delivery windows and digests cut the noise a person chose; nothing capped one
// channel, so a wildcard webhook subscription on low events fanned out a call
// per event. Over the cap a notice is held into that channel's next digest,
// never dropped. The bell (in_app) is the log and is never capped. Sign-in
// links, password resets and two-step codes go through the auth-email sender,
// not a notification channel, so a cap here can never delay them.

/** Sends per person per channel per hour. Webhooks and chat are free and
 *  generous; email costs and is tight. */
export const CHANNEL_SEND_CAP_DEFAULTS = {
  webhook: 120,
  discord: 60,
  discord_dm: 60,
  slack: 60,
  browser_push: 30,
  email: 10,
  sms: 5,
} as const;

export type CappedChannel = keyof typeof CHANNEL_SEND_CAP_DEFAULTS;

/** `NOTIFY_SEND_CAP_PER_HOUR`, e.g. "webhook=300,email=20": the channels it
 *  names, over the defaults. Throws on anything it cannot read, so a typo
 *  refuses boot instead of quietly keeping a default. */
export function parseSendCaps(raw: string | undefined): Record<CappedChannel, number> {
  const caps: Record<CappedChannel, number> = { ...CHANNEL_SEND_CAP_DEFAULTS };
  if (!raw || !raw.trim()) return caps;
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)=(\d+)$/.exec(part);
    if (!m || !(m[1]! in caps)) throw new Error(`NOTIFY_SEND_CAP_PER_HOUR: "${part}" is not <channel>=<sends an hour> for one of ${Object.keys(caps).join(", ")}`);
    const n = Number(m[2]);
    if (n < 1) throw new Error(`NOTIFY_SEND_CAP_PER_HOUR: ${m[1]} must allow at least 1 send an hour`);
    caps[m[1] as CappedChannel] = n;
  }
  return caps;
}

export const CHANNEL_WORDS: Record<CappedChannel, string> = {
  webhook: "Your webhook",
  discord: "Discord",
  discord_dm: "Discord",
  slack: "Slack",
  browser_push: "Phone notifications",
  email: "Email",
  sms: "Text messages",
};

/** The bell's one line when a channel goes over (#6908). PURE. */
export function pausedSentence(channel: CappedChannel, cap: number, minutesLeft: number): string {
  const mins = minutesLeft <= 1 ? "a minute" : `${minutesLeft} minutes`;
  return `${CHANNEL_WORDS[channel]} paused for ${mins}: more than ${cap} notices in an hour; the rest are in your next summary.`;
}
