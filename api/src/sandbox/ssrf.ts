// SSRF guard for outbound fetches in the sandbox install path.
// Pure helpers — extracted so unit tests can import them without
// pulling in the full route + DB graph (which calls process.exit
// on missing env at import time).
//
// `assertSafeUrl(url)` throws if the URL is not safe to fetch:
//   - scheme is not https (http allowed when
//     SANDBOX_ALLOW_HTTP_INSTALL=1, dev only)
//   - hostname resolves to a private/loopback/link-local IP
//     (defends against `http://169.254.169.254/...` cloud metadata,
//      LAN hosts, etc.)
//
// Without this guard a malicious registry could point at internal
// services. Always-on in production.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isAllowedScheme(url: string): boolean {
  try {
    const u = new URL(url);
    if (process.env.SANDBOX_ALLOW_HTTP_INSTALL === "1") {
      return u.protocol === "https:" || u.protocol === "http:";
    }
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;                                // 10/8
    if (a === 127) return true;                               // loopback
    if (a === 169 && b === 254) return true;                  // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16/12
    if (a === 192 && b === 168) return true;                  // 192.168/16
    if (a === 0) return true;                                 // 0.0.0.0/8
    if (a >= 224) return true;                                // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;      // ULA fc00::/7
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return true;    // link-local fe80::/10
    if (lower.startsWith("ff")) return true;                                // multicast
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check on the v4 form.
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isPrivateIp(v4);
    }
    return false;
  }
  return true;
}

export async function assertSafeUrl(url: string): Promise<void> {
  if (!isAllowedScheme(url)) {
    throw new Error(`refused: only https:// URLs are allowed for module install (got ${url})`);
  }
  const u = new URL(url);
  if (isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) {
      throw new Error(`refused: ${u.hostname} resolves to a private/loopback IP`);
    }
    return;
  }
  // Strip IPv6 brackets if present — URL.hostname leaves them for
  // bracketed-literal forms in some parsers; isIP rejects bracketed.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`refused: ${host} resolves to a private/loopback IP`);
    }
    return;
  }
  const records = await dnsLookup(host, { all: true });
  if (records.length === 0) {
    throw new Error(`refused: ${host} has no DNS records`);
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error(`refused: ${host} resolves to private IP ${r.address}`);
    }
  }
}
