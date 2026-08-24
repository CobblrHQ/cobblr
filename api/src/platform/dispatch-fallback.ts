// Where a notification goes when the workspace has said nothing about it.
//
// `dispatch` reads per-WORKSPACE subscriptions. Most workspaces have none, and
// the rule for that was a hardcoded "in_app only" — which meant a person could
// verify Discord, be recorded account-wide as wanting Discord, and still get
// nothing for anything a module sent. The two systems never spoke: account
// prefs decide platform notifications, subscriptions decide workspace ones, and
// the second had no default beyond the bell.
//
// So the fallback now asks account prefs — but only where that is the right
// thing to do, which is what POLICY below spells out per channel.
//
// This is ONLY the "no subscriptions at all" branch. A workspace that has said
// anything keeps saying it; this cannot override a choice, only fill a silence.

import type { NotificationChannel, NotificationPriority } from "../db/schema.js";
import type { PrefChannel } from "./notification-catalog.js";

const ORDER: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Below this, a notification is bell-only. A `low` event is the kind a module
 *  emits freely, and freely-emitted things do not earn a DM. */
export const DM_FLOOR: NotificationPriority = "normal";

type FallbackPolicy =
  /** Send regardless of prefs. Only for a channel nobody can be hurt by. */
  | { send: "always" }
  /** Send when the account pref is on AND the event clears the floor. */
  | { send: "when-wanted"; floor: NotificationPriority }
  /** Never in the fallback. Reaching this channel takes an explicit
   *  subscription; `why` is the argument, so the next person changing it has
   *  to answer it rather than rediscover it. */
  | { send: "never"; why: string }
  /** Send ONLY when the person has batched this channel — i.e. they have set a
   *  daily cadence on it, so whatever arrives arrives once.
   *
   *  This exists because the argument against a channel is sometimes about
   *  VOLUME rather than about the channel. "Would mail every module event to
   *  everyone" is a real objection to per-event mail and no objection at all to
   *  one message a day, so the honest rule is not "never" but "not unless it is
   *  bounded". Setting a daily cadence IS the request, which is also why it
   *  needs no second opt-in to forget to give. */
  | { send: "when-batched"; floor: NotificationPriority; why: string };

/** ⚠️ EXHAUSTIVE BY CONSTRUCTION — this is the guardrail, not decoration.
 *
 *  `Record<PrefChannel, …>` means adding a channel to the account-prefs matrix
 *  fails to COMPILE until someone decides what it does here. That is the exact
 *  bug this file was written for: `discord_dm` was added to account prefs, was
 *  a working server channel, and was silently absent from the workspace path,
 *  so a person who asked for DMs got none and nothing anywhere said why. A
 *  missing row must be a build error, never a silent "no". */
const POLICY: Record<PrefChannel, FallbackPolicy> = {
  // This IS the previous behaviour, and a bell row costs nobody anything.
  // Turning it off is a choice made with a subscription.
  in_app: { send: "always" },

  discord_dm: { send: "when-wanted", floor: DM_FLOOR },

  // Account prefs default email ON, so honouring it unconditionally would start
  // mailing every workspace notification to everyone — parcel updates, order
  // nudges, scan events. None of that has ever been emailed and nobody asked
  // for it. A DM is glanceable and a mail is not; the volume that is fine in
  // one is not fine in the other.
  //
  // But that is an argument about VOLUME, and a daily cadence removes it: one
  // message a day is not "every module event". So email is reachable exactly
  // when it is bounded, and a person who has not asked for a daily digest is
  // still mailed nothing at all.
  //
  // Note what this is NOT: an extra toggle. Setting email to "once a day" is
  // already an unambiguous request for a daily email, and making somebody
  // confirm it twice is how you end up with a setting that looks on and is off.
  email: {
    send: "when-batched",
    floor: DM_FLOOR,
    why: "per-event mail is too much; one message a day is what was asked for",
  },
};

/** The channels POLICY has an answer for. Exported so a test can hold it
 *  against the account-prefs matrix at runtime as well — the Record type is
 *  the real guard, this is the second net for anyone editing in JS. */
export const POLICIED_CHANNELS = Object.keys(POLICY) as PrefChannel[];

export function fallbackChannels(
  prefs: Record<PrefChannel, boolean>,
  priority: NotificationPriority,
  /** Channels this person has put on a daily cadence, so anything sent there
   *  arrives once rather than per event. Empty means nobody has batched
   *  anything, which is the state every workspace starts in. */
  batched: ReadonlySet<string> = new Set(),
): NotificationChannel[] {
  const out: NotificationChannel[] = [];
  for (const [channel, policy] of Object.entries(POLICY) as [PrefChannel, FallbackPolicy][]) {
    if (policy.send === "always") {
      out.push(channel);
    } else if (policy.send === "when-wanted" && prefs[channel] && ORDER[priority] >= ORDER[policy.floor]) {
      out.push(channel);
    } else if (
      policy.send === "when-batched" &&
      prefs[channel] &&
      batched.has(channel) &&
      ORDER[priority] >= ORDER[policy.floor]
    ) {
      out.push(channel);
    }
  }
  return out;
}
