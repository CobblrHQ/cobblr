// Why a notification channel did, or did not, reach someone.
//
// "emailed: false" is not an answer. It reads identically whether the reporter
// turned email off, has no address on file, or the platform sender is down —
// and only the last of those is a fault. An operator closing a feedback item saw
// the bare false and could not tell "she opted out" from "we are silently
// dropping every resolve email" (2026-08-21).
//
// So each channel returns a REASON, and the copy for each reason lives here, in
// one exhaustive switch: a new outcome cannot be added without being named.

export type ChannelOutcome =
  | "sent"
  | "opted-out"
  | "no-address"
  | "no-sender"
  | "not-connected"
  | "unverified"
  | "blocked"
  | "send-failed"
  | "not-offered";

export type DeliveryChannel = "in_app" | "email" | "discord_dm";
export type DeliveryOutcomes = Partial<Record<DeliveryChannel, ChannelOutcome>>;

/** Operator-facing phrasing. Short enough for a card line. */
export function describeOutcome(outcome: ChannelOutcome): string {
  switch (outcome) {
    case "sent": return "sent";
    case "opted-out": return "they turned it off";
    case "no-address": return "no address on file";
    case "no-sender": return "no sender configured";
    case "not-connected": return "not connected";
    case "unverified": return "not verified";
    case "blocked": return "their privacy settings block it";
    case "send-failed": return "send failed";
    case "not-offered": return "not offered for this message";
    default: {
      const unreachable: never = outcome;
      throw new Error(`unnamed delivery outcome: ${String(unreachable)}`);
    }
  }
}

/** Does this outcome mean something is WRONG on our side (as opposed to the
 *  person's own choice, or nothing to send)? Those are the ones worth chasing. */
export function isOurFault(outcome: ChannelOutcome): boolean {
  return outcome === "no-sender" || outcome === "send-failed";
}

/** One line for a card: "bell sent · email they turned it off". Channels that
 *  were never in play are left out rather than shown as noise. */
export function describeDelivery(outcomes: DeliveryOutcomes): string {
  const LABEL: Record<DeliveryChannel, string> = { in_app: "bell", email: "email", discord_dm: "discord" };
  return (Object.keys(LABEL) as DeliveryChannel[])
    .filter((ch) => outcomes[ch] && outcomes[ch] !== "not-offered")
    .map((ch) => `${LABEL[ch]} ${describeOutcome(outcomes[ch]!)}`)
    .join(" · ");
}
