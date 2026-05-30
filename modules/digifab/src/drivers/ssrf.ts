// SSRF guard for machine-manager URLs. UNLIKE the scan image-download
// guard (which blocks all private IPs because it only fetches public
// catalog images), digifab INTENTIONALLY talks to LAN managers — your
// OctoPrint lives at 192.168.x, your bridge at 10.x. So this allows
// private ranges and blocks only the genuinely dangerous targets:
// loopback (the api itself), link-local / cloud-metadata (169.254.x,
// incl. 169.254.169.254), and 0.0.0.0.
//
// Hostname-based (like the scan guard) — not DNS-rebind-proof; a
// resolve-then-check pass is a follow-up for the multi-tenant phase.

import net from "node:net";

function isBlockedIp(ip: string): boolean {
  if (ip === "::1") return true; // IPv6 loopback
  if (ip.startsWith("fe80:")) return true; // IPv6 link-local
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  return false;
}

/** Throw if `raw` is not an http(s) URL safe for a server-side fetch to a
 *  machine manager. Allows LAN/private + public; blocks loopback + metadata. */
export function assertSafeMachineUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost")) {
    throw new Error("loopback host is not allowed");
  }
  if (net.isIP(host) && isBlockedIp(host)) throw new Error("loopback / link-local / metadata address is not allowed");
}
