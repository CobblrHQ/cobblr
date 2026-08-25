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

export interface DiscordDmResult {
  /** The bot accepted the request and Discord acknowledged the send. */
  ok: boolean;
  /** The user is reachable by DM (false = privacy settings blocked it / unknown
   *  user). This is exactly what the verified test DM detects. Only meaningful
   *  when `transient` is false — a value the bot actually returned. */
  deliverable: boolean;
  /** We could not get an authoritative answer from the bot: it is not
   *  configured, it returned a non-2xx, or the request errored/timed out.
   *  `deliverable:false` under `transient:true` means "unknown", NOT "blocked" —
   *  the difference matters because a caller that unverifies a Discord link on
   *  an undeliverable result must NOT do so on a blip, or one bot restart
   *  unverifies everyone (audit B4a). */
  transient: boolean;
}

/** Send a DM to a Discord user via the bot. Awaitable (unlike the fire-and-forget
 *  pokes) because callers need the deliverability signal — a user whose privacy
 *  settings block DMs from non-mutual-server members can't be reached, which is
 *  why the verified test DM exists. `verify_token` attaches a "Yes, I got this 👋"
 *  button to the message. No bot configured → {ok:false, deliverable:false}. */
export async function sendDiscordDm(args: {
  discord_user_id: string;
  text: string;
  verify_token?: string;
  /** Message components, already in Discord's shape. The bot passes them
   *  through — it already attaches a button for `verify_token`, so this is the
   *  same door widened rather than a new one.
   *
   *  ONE app sends everything. A second app for notifications would have meant
   *  two Cobblr bots in a DM list, one of which cannot be replied to, and the
   *  instinct on receiving a DM is to reply to it. See
   *  docs/design-decisions/discord-workspace-app.md. */
  components?: unknown[];
  /** Already in Discord's embed shape — the channel owns the rendering, this
   *  is a pipe. Same reasoning as `components`. */
  embeds?: unknown[];
  /** The plain form (message + app link) the bot falls back to when Discord
   *  rejects the rich payload. The degraded shape still leads somewhere. */
  fallback_text?: string;
}): Promise<DiscordDmResult> {
  // No bot (every self-host box, and the hosted box mid-restart): we cannot
  // judge deliverability, so this is transient, never "blocked".
  if (!BOT_URL) return { ok: false, deliverable: false, transient: true };
  try {
    const r = await fetch(`${BOT_URL.replace(/\/+$/, "")}/dm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    // A non-2xx is the bot being up-but-unhappy (5xx, a rolling restart, a 429):
    // we did not get an authoritative deliverability verdict, so treat it as
    // transient rather than as the user having blocked us.
    if (!r.ok) return { ok: false, deliverable: false, transient: true };
    // The bot answered. NOW deliverable is authoritative: false here means the
    // user genuinely cannot be DM'd (privacy, no shared server, deleted).
    const d = (await r.json().catch(() => ({}))) as Partial<DiscordDmResult>;
    return { ok: Boolean(d.ok), deliverable: Boolean(d.deliverable), transient: false };
  } catch {
    // Network error / timeout — the bot may be fine and just slow. Transient.
    return { ok: false, deliverable: false, transient: true };
  }
}

/** Should an undeliverable DM cause us to mark the Discord link unverified?
 *  ONLY when the bot authoritatively said the user is unreachable — never on a
 *  transient blip. The bug this guards (audit B4a): every failure path used to
 *  look identical, so one bot restart during a notification wave unverified
 *  every recipient at once and Discord silently went dark for all of them. */
export function dmResultUnverifies(res: DiscordDmResult): boolean {
  return !res.ok && !res.deliverable && !res.transient;
}

/** The delivery outcome label. `blocked` is durable (the link gets dropped);
 *  `send-failed` is transient (retry / leave the link alone). */
export function dmOutcome(res: DiscordDmResult): "sent" | "send-failed" | "blocked" {
  if (res.ok) return "sent";
  return dmResultUnverifies(res) ? "blocked" : "send-failed";
}

export interface DiscordWaitlistCardPoke {
  waitlist_id: string;
  email: string;
  source: string | null;
  signed_up_at: string | null;
  user_agent: string | null;
}

/** Post a new-signup card (rich embed + Approve/Dismiss buttons) to the Discord
 *  admin channel so the author can approve from his phone. Fire-and-forget: the signup
 *  is already durably in the waitlist table; a missed card never loses it. The
 *  bot's button calls the same /approve endpoint the web dashboard hits. */
export function pokeDiscordWaitlistCard(card: DiscordWaitlistCardPoke): void {
  if (!BOT_URL) return;
  void (async () => {
    try {
      await fetch(`${BOT_URL.replace(/\/+$/, "")}/waitlist-card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(card),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* no admin card — the signup is still in the Waitlist tab to approve there. */
    }
  })();
}

// A feedback item's lifecycle stage, for the Discord reaction trail. The bot maps
// each to an emoji: grabbed 🤖 · building 🔨 · pr_open 👀 · spec 📋 · shipped ✅ ·
// passed 🚫.
export type FeedbackStage = "grabbed" | "building" | "pr_open" | "spec" | "shipped" | "passed";

export interface FeedbackStagePoke {
  feedback_id: string;
  stage: FeedbackStage;
  /** The public "New feedback" Discord post to react on, when we tracked it. */
  message_id?: string | null;
  channel_id?: string | null;
}

/** Tell the support bot an item reached a new lifecycle stage so it can add the
 *  matching emoji reaction — on the public #feedback post (if we captured its
 *  message id) AND on the private autopilot card (which the bot tracks itself by
 *  feedback_id). Fire-and-forget; no-op if the bot isn't configured. Reactions
 *  are add-only + idempotent, so re-poking a stage is harmless. */
export function pokeDiscordFeedbackStage(poke: FeedbackStagePoke): void {
  if (!BOT_URL) return;
  void (async () => {
    try {
      await fetch(`${BOT_URL.replace(/\/+$/, "")}/feedback-stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(poke),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* a missed reaction is cosmetic — never worth failing or altering the update. */
    }
  })();
}
