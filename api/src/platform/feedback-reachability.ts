// Can anyone be reached about a piece of feedback? Decided ONCE, where the item
// is written (#4645), so the card, the console, the reply route and the triage
// all read the same answer instead of each guessing from the address.

/** The domain a sandbox guest's synthetic address ends with (try-sandbox.ts
 *  SANDBOX_EMAIL_DOMAIN; repeated here so this stays pure and testable). */
const SANDBOX_DOMAIN = "try.invalid";

export interface Reachability {
  reachable: boolean;
  unreachable_reason: string | null;
  /** The address a person left on purpose, when they did. */
  contact_email: string | null;
}

export const ANONYMOUS_SANDBOX = "anonymous sandbox";

export function isSandboxAddress(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${SANDBOX_DOMAIN}`);
}

/** `email` is the filing account's address (null for a chat ticket, which has
 *  its own door); `contactEmail` is what the reporter chose to leave. */
export function feedbackReachability(input: { email: string | null | undefined; contactEmail?: string | null }): Reachability {
  // Only a sandbox guest needs a contact address: everyone else has an account
  // with its own channels, and a second address would double the message.
  if (!isSandboxAddress(input.email)) return { reachable: true, unreachable_reason: null, contact_email: null };
  const contact = input.contactEmail?.trim() || null;
  if (contact && !isSandboxAddress(contact)) return { reachable: true, unreachable_reason: null, contact_email: contact };
  return { reachable: false, unreachable_reason: ANONYMOUS_SANDBOX, contact_email: null };
}
