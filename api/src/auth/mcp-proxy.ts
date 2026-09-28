// The hosted MCP endpoint's proof that a REST call is its own.
//
// A connector's access token is for the MCP endpoint only (its audience). The
// endpoint reaches REST through this api's own HTTP surface, so REST has to
// tell that call apart from somebody who copied the token out of a connector.
// "It came from loopback" cannot: any process on the box, a test runner or a
// host-networked container, is loopback too. A secret made when this process
// starts, sent only by the proxy to this same process, can.
import { randomBytes, timingSafeEqual } from "node:crypto";

export const MCP_PROXY_HEADER = "x-cobblr-mcp-proxy";
const SECRET = randomBytes(32).toString("hex");

/** The header the hosted MCP endpoint adds to its own REST calls. */
export function mcpProxyHeaders(): Record<string, string> {
  return { [MCP_PROXY_HEADER]: SECRET };
}

/** Whether a request carries this process's proxy secret. */
export function isMcpProxyCall(headers: Record<string, string | string[] | undefined>): boolean {
  const v = headers[MCP_PROXY_HEADER];
  const got = Buffer.from(Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}
