// What the SERVER is currently telling us about the account's theme — or
// nothing, which is a third answer and not the same as "no preference".
//
// Three states, and collapsing the first two is the bug this exists to stop:
//
//   undefined  the account has not loaded (signed out, or a response that did
//              not carry the field). Say NOTHING. Applying it writes the cache,
//              and the cache is what carries your theme across a sign-in.
//   null       loaded, and the account defers to this device. Apply it.
//   light/dark loaded, with a choice. Apply it.
//
// `user?.theme_pref ?? null` conflates the first two, so merely landing on the
// login page erased the cached preference and you signed in to the wrong theme.

import type { SessionUser } from "../lib/api";

export type ServerThemePref = "light" | "dark" | null;

/** null = follow this device. undefined = we have not been told; do nothing. */
export function themePrefToApply(
  user: Pick<SessionUser, "theme_pref"> | null | undefined,
): ServerThemePref | undefined {
  if (!user) return undefined;
  // `in` rather than a truthiness check: a response that carries an explicit
  // null IS telling us something, and it must not be mistaken for silence.
  if (!("theme_pref" in user)) return undefined;
  const p = user.theme_pref;
  return p === "light" || p === "dark" ? p : null;
}
