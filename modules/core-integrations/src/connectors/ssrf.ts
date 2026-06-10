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

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — unwrap and recheck.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]!);
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const a = p[0]!, b = p[1]!;
  return (
    a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function internalAllowed(): boolean {
  return (
    process.env.COBBLR_WEBHOOK_ALLOW_INTERNAL === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/** Validate an outbound connector URL. Async because it resolves DNS to
 *  catch hostnames pointing at internal addresses. Throws on a blocked URL. */
export async function assertSafeOutboundUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("connector: invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("connector: only http(s) URLs are allowed");
  }
  if (internalAllowed()) return;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("connector: internal host blocked");
  }
  // Literal IP — check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("connector: private/loopback address blocked");
    return;
  }
  // Hostname — resolve and reject if ANY address is internal (DNS-rebind safe).
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("connector: host did not resolve");
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("connector: host resolves to a private/loopback address");
  }
}
