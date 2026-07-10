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
   *  user). This is exactly what the verified test DM detects. */
  deliverable: boolean;
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
}): Promise<DiscordDmResult> {
  if (!BOT_URL) return { ok: false, deliverable: false };
  try {
    const r = await fetch(`${BOT_URL.replace(/\/+$/, "")}/dm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { ok: false, deliverable: false };
    const d = (await r.json().catch(() => ({}))) as Partial<DiscordDmResult>;
    return { ok: Boolean(d.ok), deliverable: Boolean(d.deliverable) };
  } catch {
    return { ok: false, deliverable: false };
  }
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
