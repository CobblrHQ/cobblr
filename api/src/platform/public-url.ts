// The platform's public origin (e.g. https://cobblr.example.com), for building absolute
// links in contexts with no inbound `req` — OAuth redirect default, the MCP relay.
// A link in a message body is built by emailableUrl (link-origin.ts), which
// returns null rather than a relative path when no address is known (#7543).
// The address itself is read in one place, the contract's publicBaseUrl.
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";

export { publicBaseUrl };

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
