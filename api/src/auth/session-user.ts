// WHO THE SIGNED-IN USER IS — one answer, for every door that hands it over.
//
// There are two: `GET /me`, which the app calls on boot, and buildAuthResponse,
// which login, signup, invite-accept and every other auth entry return. They
// each had their own select, and they disagreed: /me carried the account
// PREFERENCES (theme, nav layout, whether the tour has been seen) and the auth
// payload did not.
//
// The app's SessionUser types all three as optional, so the gap was invisible
// to tsc and reachable only by using the product: sign in and your workspace
// came up in the wrong theme, because the response said nothing about your
// theme and the client read silence as "no preference". A refresh fixed it,
// which is the signature of exactly this - the refresh went through /me
// (reported 2026-09-08).
//
// So the columns live here and both doors read them. A preference added to the
// users table now reaches the client on login and on boot, or on neither; it
// cannot reach one and not the other.

import { meta } from "../db/meta.js";

/** Every column the client is given about itself. Add account-level
 *  preferences HERE, not in a route. */
export const SESSION_USER_COLUMNS = [
  "id",
  "email",
  "display_name",
  "must_reset_password",
  "email_verified_at",
  // The account-level preferences. Absent from a response means "not loaded",
  // which is NOT the same as null ("follow this device") - the client draws
  // that distinction, so a door that omits them makes it lie.
  "theme_pref",
  "nav_pref",
  "tour_seen_at",
] as const;

/** The row, with email_verified_at already folded into the boolean the client
 *  reads. Both doors add their own request-scoped extras on top. The shape is
 *  INFERRED from the column list above, so widening that list widens both
 *  responses without a second edit. */
export async function loadSessionUser(userId: string) {
  const user = await meta
    .selectFrom("users")
    .select(SESSION_USER_COLUMNS)
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const { email_verified_at, ...rest } = user;
  return { ...rest, email_verified: email_verified_at !== null };
}
