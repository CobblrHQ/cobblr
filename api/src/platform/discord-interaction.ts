// Receiving a button press from Discord.
//
// Two jobs, both of which fail dangerously if done loosely:
//
//   1. PROVE the request came from Discord. The endpoint is public and
//      unauthenticated — it has to be, Discord will not carry our session — so
//      the Ed25519 signature over (timestamp + raw body) is the ONLY thing
//      standing between this and anyone who knows the URL. Verified against the
//      exact transmitted bytes, which is why the server captures a raw body on
//      this path.
//
//   2. Resolve the press to something the presser is actually allowed to do.
//      A custom_id arrives from a client. It names a notification and one of
//      its actions and nothing else; the org, the action and its arguments are
//      read back from the stored row. So the worst a forged id can do is name
//      a notification that is not yours, which the ownership check refuses.
//
// Kept apart from the route because both are decisions worth testing, and the
// route's imports pull the database and therefore env validation, which exits
// the process when the environment is incomplete.

import { createPublicKey, verify as edVerify } from "node:crypto";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** Discord's interaction types, the three that matter here. */
export const INTERACTION = { PING: 1, COMPONENT: 3 } as const;
/** Response types: ack a PING, and replace the message a button sat on. */
export const RESPONSE = { PONG: 1, UPDATE_MESSAGE: 7 } as const;

/** A raw Ed25519 public key as DER/SPKI, which is what node's KeyObject wants.
 *  Discord hands out 32 raw bytes as hex; this is the standard prefix. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Is this really Discord?
 *
 * Never throws: a malformed key or signature is a failed verification, not a
 * 500. An endpoint that 500s on garbage tells an attacker their garbage was
 * interesting.
 */
export function verifySignature(args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  rawBody: string;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = args;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return edVerify(
      null,
      Buffer.from(timestamp + rawBody, "utf8"),
      key,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    return false;
  }
}

export interface PressRef {
  notificationId: string;
  actionId: string;
}

/**
 * What a press refers to — two identifiers, nothing more.
 *
 * Strict by construction: a uuid and a short slug. Anything else is not a
 * Cobblr card and is ignored rather than guessed at, so another app's ids (or
 * a probe) fall through instead of reaching a lookup.
 */
export function parsePress(customId: string): PressRef | null {
  const m = /^cbl:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Za-z0-9_-]{1,32})$/.exec(
    customId,
  );
  return m ? { notificationId: m[1]!, actionId: m[2]! } : null;
}

export interface StoredNotification {
  id: string;
  org_id: string;
  user_id: string;
  actions: { id: string; label: string; action: string; args?: Record<string, unknown> }[] | null;
}

export type Resolution =
  | { ok: true; orgId: string; userId: string; action: string; args: Record<string, unknown>; label: string }
  | { ok: false; reason: "unknown" | "not-yours" | "no-such-action" };

/**
 * Turn a press into an action to run, or a refusal.
 *
 * `pressedByUserId` comes from OUR discord_connections table, never from the
 * interaction payload — Discord tells us which Discord account pressed, and the
 * mapping to a Cobblr user is ours. A DM is one-to-one, so in practice the
 * presser is the recipient; the check is here because "in practice" is not a
 * security property.
 */
export function resolvePress(
  notification: StoredNotification | null,
  pressedByUserId: string | null,
  ref: PressRef,
): Resolution {
  if (!notification) return { ok: false, reason: "unknown" };
  if (!pressedByUserId || notification.user_id !== pressedByUserId) {
    return { ok: false, reason: "not-yours" };
  }
  const action = notification.actions?.find((a) => a.id === ref.actionId);
  if (!action) return { ok: false, reason: "no-such-action" };
  return {
    ok: true,
    orgId: notification.org_id,
    userId: notification.user_id,
    action: action.action,
    args: action.args ?? {},
    label: action.label,
  };
}

/**
 * May a resolved press actually RUN the action, given the presser's CURRENT
 * membership role in the notification's workspace?
 *
 * A card action is a real write (the reply posts a comment everyone in the
 * workspace sees), so proving-who-pressed (resolvePress) is necessary but not
 * sufficient — the presser must also still be allowed to do it in that
 * workspace. Two holes this closes, both of which resolvePress cannot see
 * because the notification row and the Discord link outlive membership:
 *   • a read-only GUEST, who is legitimately mentioned and DM'd but may only
 *     read in-app (the in-app reply requires member+);
 *   • a member whose access was REVOKED after the DM was sent (no membership
 *     row → role is null/undefined here → refused).
 *
 * Mirrors the in-app twin POST /discussion/'s requireRole("owner","admin",
 * "member"). The role is looked up in the route (a DB read); the DECISION is
 * here so it is pure and tested, the same split as resolvePress.
 */
export function pressMayAct(role: string | null | undefined): boolean {
  return roleSatisfies(role, ["owner", "admin", "member"]);
}

/** What the message becomes after a press.
 *
 *  The card is REPLACED rather than answered beside, so a pressed button cannot
 *  be pressed again from scrollback and the message reads as settled. The
 *  original text is kept: a card that erases what it was about leaves the
 *  reader with only the outcome. */
export function settledMessage(
  original: string,
  outcome: string,
  /** What the person typed, when the press carried a reply. Shown back to them:
   *  a DM that answers "✅ Sent." and nothing else leaves you unable to check
   *  what you actually said, in the one place you cannot scroll back to it -
   *  the message you typed lives in a modal that is already gone. */
  echo?: string | null,
  /** The card the press was on, when the notification arrived as one. With a
   *  reply, the card is REWRITTEN as the conversation so far: the message it
   *  carried, then the reply under it with a time, in the order they happened,
   *  and the outcome in the footer. The reply belongs with the message it
   *  answers, not as a quote below the card. */
  card?: PressCard | null,
  /** Injected for tests; the reply's Discord timestamp. */
  now: Date = new Date(),
): {
  type: number;
  data: { content: string; components: never[]; embeds?: PressEmbed[] };
} {
  if (card && echo) {
    const stamp = `<t:${Math.floor(now.getTime() / 1000)}:t>`;
    const reply = `**You** · ${stamp}\n${echo}`;
    const description = [card.description?.trim(), reply].filter(Boolean).join("\n\n").slice(0, 4000);
    const footer = [outcome, card.footer].filter((x): x is string => !!x && x.trim().length > 0).join(" · ");
    return {
      type: RESPONSE.UPDATE_MESSAGE,
      data: {
        content: "",
        components: [],
        embeds: [
          {
            ...(card.title ? { title: card.title } : {}),
            ...(card.url ? { url: card.url } : {}),
            description,
            footer: { text: footer.slice(0, 2000) },
            color: card.color ?? 0xc98a3f,
          },
        ],
      },
    };
  }
  const quoted = echo
    ? // Discord's blockquote continues across newlines with each line prefixed,
      // so a multi-line reply stays inside the quote instead of half escaping it.
      "\n" + echo.split("\n").map((l) => `> ${l}`).join("\n")
    : "";
  // A card-only message has no text of its own; the embed stays on the edited
  // message (the bot leaves embeds alone), so the outcome goes under the card
  // rather than under two blank lines.
  const lead = original.trim() ? `${original}\n\n` : "";
  return {
    type: RESPONSE.UPDATE_MESSAGE,
    data: { content: `${lead}${outcome}${quoted}`, components: [] },
  };
}

/** The card a press was on, as the bot forwards it. */
export interface PressCard {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  /** The footer's text. */
  footer?: string | null;
  color?: number | null;
}
export interface PressEmbed {
  title?: string;
  url?: string;
  description: string;
  footer: { text: string };
  color: number;
}

/** The card on the pressed message, or null when it had none. */
export function cardOf(
  message:
    | {
        content?: string | null;
        embeds?: Array<{
          title?: string | null;
          description?: string | null;
          url?: string | null;
          footer?: { text?: string | null } | string | null;
          color?: number | null;
        }> | null;
      }
    | null
    | undefined,
): PressCard | null {
  const e = message?.embeds?.[0];
  if (!e) return null;
  const footer = typeof e.footer === "string" ? e.footer : (e.footer?.text ?? null);
  return { title: e.title ?? null, description: e.description ?? null, url: e.url ?? null, footer, color: e.color ?? null };
}

/** The text a press was about. The message's own content when it had any;
 *  otherwise the card's title and body, which is what the person was looking
 *  at when a notification arrived as an embed with no line above it. */
export function originalOf(
  message: { content?: string | null; embeds?: Array<{ title?: string | null; description?: string | null }> | null } | null | undefined,
): string {
  const content = (message?.content ?? "").trim();
  if (content) return content;
  const e = message?.embeds?.[0];
  return [e?.title, e?.description].filter((x): x is string => !!x && x.trim().length > 0).join("\n");
}
