// A username an account can sign in with beside its email (#6910). PURE.
//
// Lower-case letters, digits, dot, dash and underscore, 3 to 32 long, starting
// with a letter or digit, and never an "@": that is what tells a sign-in
// identifier apart, an "@" is an email and anything else a username.

const SHAPE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** As stored: trimmed and lower-case, so "Demo" and "demo" are one name. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why `raw` cannot be a username, in a person's words, or null. */
export function usernameProblem(raw: string): string | null {
  const u = normalizeUsername(raw);
  if (u.length < 3) return "A username is at least 3 characters.";
  if (u.length > 32) return "A username is at most 32 characters.";
  if (u.includes("@")) return "A username has no @ in it; that is how sign-in tells it from an email.";
  if (!SHAPE.test(u)) return "A username uses letters, digits, dots, dashes and underscores, and starts with a letter or digit.";
  return null;
}

/** Whether a sign-in identifier is an email (it has an "@") or a username. */
export function identifierKind(identifier: string): "email" | "username" {
  return identifier.includes("@") ? "email" : "username";
}

/** The address an account made without an email carries (#6910, only where the
 *  operator allows it): the reserved .invalid domain, so nothing is ever sent
 *  to it and it can never belong to anybody. */
export const NO_EMAIL_DOMAIN = "no-email.invalid";
export function placeholderEmail(username: string): string {
  return `${normalizeUsername(username)}@${NO_EMAIL_DOMAIN}`;
}
/** True for an address nothing may be sent to (#6910): the reserved .invalid top-level domain. */
export function isUndeliverableAddress(email: string): boolean {
  return /\.invalid$/i.test(email.trim());
}
