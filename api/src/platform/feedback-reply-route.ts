// Which door reaches the person who filed a piece of feedback?
//
// Answered ONCE, for every origin, in one exhaustive switch. A feedback reply
// is written for a human, so an origin with no route is a reply that silently
// goes nowhere: `discord-dm` shipped after the resolve handler was written, the
// handler only matched `origin === "discord"`, and a DM reporter with no
// platform account got a resolved ticket and no word of it. Adding a new origin
// to the union now fails to COMPILE here until it names its door.
//
// An account BEATS the origin's own channel: notifyAccount already fans out to
// the in-app bell, email, and a verified Discord DM, so routing a reporter who
// has an account through their origin as well would double the message.

import type { FeedbackOrigin } from "../db/schema.js";

export type ReporterReplyRoute =
  /** Post into the ticket's Discord thread (the ticket IS the conversation). */
  | { via: "discord-thread"; thread_id: string }
  /** DM the Discord user who wrote in — for a reporter with no account. */
  | { via: "discord-dm"; discord_user_id: string }
  /** They have a platform account; notifyAccount picks the channels. */
  | { via: "account" }
  /** Nothing to reply to (no account, and the origin left no way back). */
  | { via: "none" };

export interface FeedbackReplyTarget {
  origin: FeedbackOrigin;
  user_id: string | null;
  origin_ref: { thread_id?: string; user_id?: string } | null;
}

export function reporterReplyRoute(row: FeedbackReplyTarget): ReporterReplyRoute {
  const ref = row.origin_ref ?? {};
  switch (row.origin) {
    case "in-app":
      return row.user_id ? { via: "account" } : { via: "none" };
    case "discord":
      // The thread reply stands even for a reporter who also has an account:
      // it is the ticket's own record, visible to whoever else is in there.
      return ref.thread_id ? { via: "discord-thread", thread_id: ref.thread_id } : row.user_id ? { via: "account" } : { via: "none" };
    case "discord-dm":
      if (row.user_id) return { via: "account" };
      return ref.user_id ? { via: "discord-dm", discord_user_id: ref.user_id } : { via: "none" };
    default: {
      const unreachable: never = row.origin;
      throw new Error(`feedback origin has no reply route: ${String(unreachable)}`);
    }
  }
}
