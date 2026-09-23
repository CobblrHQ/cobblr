// The platform's public origin (e.g. https://cobblr.example.com), for building absolute
// links in contexts with no inbound `req` — Discord DMs, OAuth redirect default.
// Unset → links stay relative (still useful in-app; just not clickable from a
// DM). The address itself is read in one place, the contract's publicBaseUrl.
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";

export { publicBaseUrl };

/** Absolute app URL for a relative route. Passthrough for already-absolute URLs;
 *  returns the relative path unchanged when no public base is configured. */
export function absoluteAppUrl(path: string | null | undefined): string {
  const BASE = publicBaseUrl();
  if (!path) return BASE;
  if (/^https?:\/\//.test(path)) return path;
  if (!BASE) return path;
  return `${BASE}/${path.replace(/^\/+/, "")}`;
}
