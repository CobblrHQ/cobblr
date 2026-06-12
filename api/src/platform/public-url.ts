// The platform's public origin (e.g. https://cobblr.me), for building absolute
// links in contexts with no inbound `req` — Discord DMs, OAuth redirect default.
// `||` not `??` for the env default (core CLAUDE.md §14.6). Unset → links stay
// relative (still useful in-app; just not clickable from a DM).

const BASE = (process.env.PUBLIC_BASE_URL || process.env.COBBLR_PUBLIC_URL || "").replace(/\/+$/, "");

/** Absolute app URL for a relative route. Passthrough for already-absolute URLs;
 *  returns the relative path unchanged when no public base is configured. */
export function absoluteAppUrl(path: string | null | undefined): string {
  if (!path) return BASE;
  if (/^https?:\/\//.test(path)) return path;
  if (!BASE) return path;
  return `${BASE}/${path.replace(/^\/+/, "")}`;
}

/** The configured public origin, or "" if unset. */
export function publicBaseUrl(): string {
  return BASE;
}
