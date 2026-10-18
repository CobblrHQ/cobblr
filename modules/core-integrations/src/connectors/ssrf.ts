// Shared SSRF guard for admin-configured outbound connector URLs
// (webhook / slack / discord). Blocks non-http(s) schemes and internal
// targets — loopback / private / link-local, incl. the cloud metadata IP
// 169.254.169.254. Resolves DNS and checks every resolved address, so a
// public hostname that resolves to a private IP (DNS-rebind) is rejected too.
//
// Escape hatch: COBBLR_WEBHOOK_ALLOW_INTERNAL=1 skips the internal-target
// checks for local dev / tests — but ONLY outside production. In production
// the guard is always on regardless of the env var, so a stray compose
// default can't disable it. See docs/history/2026-06-10-prelaunch-audit.md #2.

import net from "node:net";
import { lookup } from "node:dns/promises";
// The ONE canonical private-IP rule. This module's own copy used to miss the
// Tailscale/CGNAT range (100.64/10), so an admin-configured webhook/http
// connector pointed at a tailnet address slipped through (audit B2c).
import { isPrivateIp } from "@cobblr/platform-contract/private-ip";

function internalAllowed(): boolean {
  return (
    process.env.COBBLR_WEBHOOK_ALLOW_INTERNAL === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/** The address a request is to connect to, as checked: the one a connection
 *  must be pinned to, so the name is not looked up a second time (a name that
 *  answers public to the check and private to the connect is DNS rebinding). */
export interface CheckedAddress {
  address: string;
  family: number;
}

/** Validate an outbound connector URL. Async because it resolves DNS to
 *  catch hostnames pointing at internal addresses. Throws on a blocked URL. */
export async function assertSafeOutboundUrl(raw: string): Promise<void> {
  await resolveSafeOutboundTarget(raw);
}

/** The same check, and the address it checked: resolve once, refuse the URL if
 *  ANY answer is internal, and hand back the first answer to connect to. Null
 *  only where the internal-network hatch is on (nothing is checked, so nothing
 *  is pinned). */
export async function resolveSafeOutboundTarget(raw: string): Promise<CheckedAddress | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("connector: invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("connector: only http(s) URLs are allowed");
  }
  if (internalAllowed()) return null;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("connector: internal host blocked");
  }
  // Literal IP — check directly.
  const literal = net.isIP(host.replace(/^\[|\]$/g, ""));
  if (literal) {
    const bare = host.replace(/^\[|\]$/g, "");
    if (isPrivateIp(bare)) throw new Error("connector: private/loopback address blocked");
    return { address: bare, family: literal };
  }
  // Hostname — resolve and reject if ANY address is internal (DNS-rebind safe).
  let addrs: Array<{ address: string; family?: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("connector: host did not resolve");
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("connector: host resolves to a private/loopback address");
  }
  const first = addrs[0];
  if (!first) throw new Error("connector: host did not resolve");
  return { address: first.address, family: first.family ?? (net.isIP(first.address) || 4) };
}
