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

/** Where an assistant bridge reaches THIS api's MCP endpoint, or "" to let
 *  the bridge use its own default.
 *
 *  Usually the public origin. Not always: a canary shares its release's public
 *  address (links in emails must point at the release), and a relay sent there
 *  is answered by the release's older code. COBBLR_MCP_RELAY_URL names the
 *  instance's own endpoint for that case, typically an internal address the
 *  bridge reaches directly. */
export function mcpRelayUrl(): string {
  const own = (process.env.COBBLR_MCP_RELAY_URL || "").trim().replace(/\/+$/, "");
  if (own) return own;
  const base = publicBaseUrl();
  return base ? `${base}/api/v1/hooks/mcp` : "";
}
