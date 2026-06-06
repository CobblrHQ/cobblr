// SSRF guard for print-manager URLs — same posture as digifab's machine-URL
// guard: a self-hosted api INTENTIONALLY talks to a LAN CUPS host (printhost.lan
// at 192.168.x / 10.x) or an edge-bridge, so we allow private ranges and block
// only the genuinely dangerous targets (loopback = the api itself, link-local /
// cloud-metadata 169.254.x, 0.0.0.0).
//
// NOTE (intentional duplication): this is the 3rd copy of this guard
// (digifab/drivers/ssrf.ts, core-integrations' webhook guard, here). It's flagged
// in docs/BACKLOG.md "Device connectivity" — the cloud-safe answer is one
// per-tenant egress allow-list, promoted to the platform. Until then, mirror the
// digifab posture so self-hosted LAN printing works.

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

/** Throw if `raw` is not an http(s) URL safe for a server-side fetch to a print
 *  manager. Allows LAN/private + public; blocks loopback + metadata. */
export function assertSafePrinterUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost")) {
    throw new Error("loopback host is not allowed");
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new Error("loopback / link-local / metadata address is not allowed");
  }
}
