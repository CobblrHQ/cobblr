// Who this instance says it is when it calls somebody else's API.
//
// Third-party services ask two things of a well-behaved client: a User-Agent
// naming the software, and a way to reach whoever is running it. The second half
// is the part that must never be baked into the image, because the answer is
// different for every install — and until 2026-08-09 it was baked in twice:
//
//   • the Polar filament resolver sent a literal `email=` belonging to whoever
//     publishes Cobblr, on every self-hoster's lookup
//   • two User-Agents advertised the hosted deployment's own URL as the contact
//
// So every install identified as one caller. Rate limits and abuse reports for
// traffic nobody at that address sent would land there, the vendor could not
// reach the person actually calling, and the operator was told none of it.
//
// The rule: the SOFTWARE half is a constant (it is the same software), the
// CONTACT half comes from the instance's own config, and when there is no contact
// we send none rather than borrowing somebody else's.
//
// Precedent for the shape: platform/receipt-email.ts, which derives its mail
// domain from env and reports the feature unavailable when unset instead of
// falling back to something that looks configured and is not.

/** The operator's contact address: how a third-party service reaches whoever runs
 *  THIS instance. Not Cobblr's address — the person or org hosting this copy.
 *
 *  COBBLR_OPERATOR_EMAIL first; otherwise the first SUPERADMIN_EMAILS entry, which
 *  an operator has usually already set for alert mail and is by definition a real
 *  inbox they read. Empty when neither is configured, and callers must treat empty
 *  as "cannot identify" rather than substituting anything. */
export function operatorEmail(): string {
  const explicit = (process.env.COBBLR_OPERATOR_EMAIL || "").trim();
  if (explicit) return explicit;
  // SUPERADMIN_EMAILS is a comma-separated list; the first is the primary.
  const first = (process.env.SUPERADMIN_EMAILS || "").split(",")[0]?.trim() ?? "";
  return first;
}

/** This instance's public URL, for the `+url` courtesy field in a User-Agent.
 *  Empty for an instance with no public URL configured (a LAN-only install), in
 *  which case the User-Agent simply carries no URL. */
export function contactUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  // A localhost default (the dev/compose value) is not a contact address for
  // anybody outside the box, so it is treated as unset.
  if (!base || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(base)) return "";
  return base;
}

/** The courtesy suffix appended to an outgoing User-Agent: " (+<url>)", or the
 *  operator's email when there is no public URL, or "" when neither exists. */
export function contactSuffix(): string {
  const url = contactUrl();
  if (url) return ` (+${url})`;
  const email = operatorEmail();
  return email ? ` (+${email})` : "";
}

/** A User-Agent for an outbound call. `component` names the part of Cobblr doing
 *  the calling, so a vendor reading their logs can tell a book lookup from a
 *  filament lookup. The identity half is appended from this instance's config. */
export function userAgent(component: string): string {
  return `Cobblr/1.0 (${component})${contactSuffix()}`;
}
