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

/** What the message becomes after a press.
 *
 *  The card is REPLACED rather than answered beside, so a pressed button cannot
 *  be pressed again from scrollback and the message reads as settled. The
 *  original text is kept: a card that erases what it was about leaves the
 *  reader with only the outcome. */
export function settledMessage(original: string, outcome: string): {
  type: number;
  data: { content: string; components: never[] };
} {
  return {
    type: RESPONSE.UPDATE_MESSAGE,
    data: { content: `${original}\n\n${outcome}`, components: [] },
  };
}
