// SSRF guard for outbound fetches in the sandbox — both the install
// path (registry browse/download) AND the wasm HOST_FETCH op.
// Pure helpers — extracted so unit tests can import them without
// pulling in the full route + DB graph (which calls process.exit
// on missing env at import time), nor pool.ts's worker_threads + wasm
// runtime.
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

/** Does `hostname` satisfy a HOST_FETCH network[] allowlist? Each entry
 *  is an exact hostname ("api.bricklink.com") or a leading-dot wildcard
 *  (".bricklink.com" matches the apex AND any subdomain). */
export function hostInAllowlist(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    if (entry === hostname) return true;
    if (entry.startsWith(".")) {
      const bare = entry.slice(1);
      if (hostname === bare) return true;
      if (hostname.endsWith(entry)) return true;
    }
    return false;
  });
}

/** Validate one HOST_FETCH target: scheme (http/https) + allowlist +
 *  SSRF (private/loopback/metadata IPs, DNS-resolved). Returns the
 *  parsed URL or an error string. Called on the ORIGINAL url AND on
 *  every redirect hop — a 302 to http://169.254.169.254/ must not slip
 *  past a guard that only saw the first URL. (Audit 2026-06-19 #3.)
 *
 *  On success it ALSO returns a validated `pin` { address, family } — the
 *  concrete IP every resolved record agreed was public. The caller
 *  connects to THAT ip rather than re-resolving, which closes the
 *  DNS-rebind window (the guard resolves, then the HTTP client resolves
 *  again — a hostile resolver could answer differently). `pin` is null
 *  only in the can't-happen case of an empty record set. */
export type FetchTarget = { url: URL; pin: { address: string; family: number } | null };
export async function validateFetchTarget(
  urlStr: string,
  allowlist: string[],
): Promise<FetchTarget | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { error: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: `protocol ${parsed.protocol} not allowed (https/http only)` };
  }
  if (!hostInAllowlist(parsed.hostname, allowlist)) {
    return { error: `host ${parsed.hostname} not in allowlist` };
  }
  let pin: { address: string; family: number } | null = null;
  const fetchHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(fetchHost)) {
    if (isPrivateIp(fetchHost)) {
      return { error: `host ${fetchHost} is a blocked (private/loopback) address` };
    }
    pin = { address: fetchHost, family: isIP(fetchHost) };
  } else {
    try {
      const recs = await dnsLookup(fetchHost, { all: true });
      if (recs.length === 0 || recs.some((r) => isPrivateIp(r.address))) {
        return { error: `host ${fetchHost} resolves to a blocked (private/loopback) address` };
      }
      // Pin to the first validated record. EVERY record was checked
      // public above, so any is safe; the HTTP client will connect to
      // this exact ip instead of re-resolving.
      const first = recs[0]!;
      pin = { address: first.address, family: first.family };
    } catch {
      return { error: `host ${fetchHost} did not resolve` };
    }
  }
  return { url: parsed, pin };
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
