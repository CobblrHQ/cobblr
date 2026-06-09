// SSRF guard for AI providers that fetch a WORKSPACE-SUPPLIED URL
// (today: the ollama provider's `base_url`). Without it a tenant can
// point base_url at http://169.254.169.254/ (cloud metadata),
// loopback, or an internal LAN host and make the server fetch it —
// and ollama surfaces response bodies to the caller, so it's a READ
// SSRF, not blind. See docs/operations/security-audit.md §10.
//
// Two policies, picked by deployment via platform().ai.getEndpointPolicy():
//   - "lan"    (default, self-hosted): the Ollama endpoint is
//              legitimately on the LAN (default http://ollama:11434),
//              so RFC1918 is ALLOWED; only the genuinely dangerous
//              targets are blocked — loopback, link-local + cloud
//              metadata, 0.0.0.0, multicast, IPv6 ULA/link-local.
//   - "strict" (cloud): a tenant's "home" endpoint is reached over the
//              public internet, never the cloud's own network, so ALL
//              private + loopback + link-local + metadata + ULA are
//              blocked. The hosted overlay sets this at boot; open core
//              stays "lan" so a fresh self-host works unconfigured
//              (fail-safe by image, not by a forgettable env).

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { AiEndpointPolicy } from "@cobblr/platform-contract";

export function isAllowedAiScheme(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/** Always blocked, under BOTH policies — never a legitimate AI endpoint
 *  and the actual SSRF danger. */
export function isDangerousIp(ip: string): boolean {
  if (!ip) return true;
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check on the v4 form.
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isDangerousIp(v4);
    }
    return false;
  }
  return true; // not a parseable IP → treat as unsafe
}

/** The "strict" set: dangerous + the RFC1918 private ranges + CGNAT. */
export function isPrivateIp(ip: string): boolean {
  if (isDangerousIp(ip)) return true;
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map((p) => Number.parseInt(p, 10)) as [
      number,
      number,
      number,
      number,
    ];
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (incl. tailnet)
    return false;
  }
  if (family === 6 && ip.toLowerCase().startsWith("::ffff:")) {
    const v4 = ip.toLowerCase().slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateIp(v4);
  }
  return false;
}

function blocked(policy: AiEndpointPolicy, ip: string): boolean {
  return policy === "strict" ? isPrivateIp(ip) : isDangerousIp(ip);
}

/** Throws if `url` is not a safe AI endpoint under `policy`; otherwise RETURNS
 *  the validated IP to pin the connection to. RESOLVES DNS and checks EVERY
 *  resolved address, so a hostname that resolves to a blocked IP is caught — not
 *  just literal-IP base_urls. The caller MUST connect to the returned IP via
 *  `pinnedFetch` (not plain `fetch`, which would re-resolve the hostname and
 *  reopen the DNS-rebinding TOCTOU window). `pinnedFetch` also refuses redirects
 *  (an allowed host can 302 to an internal address). */
export async function assertSafeAiEndpoint(url: string, policy: AiEndpointPolicy): Promise<string> {
  if (!isAllowedAiScheme(url)) {
    throw new Error(`refused: AI endpoint must be an http(s) URL (got ${url})`);
  }
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const lowerHost = host.toLowerCase();
  if (lowerHost === "localhost" || lowerHost === "ip6-localhost" || lowerHost.endsWith(".localhost")) {
    throw new Error("refused: loopback host is not allowed for an AI endpoint");
  }
  if (isIP(host)) {
    if (blocked(policy, host)) {
      throw new Error(`refused: AI endpoint ${host} is a blocked address (${policy} policy)`);
    }
    return host; // a literal IP is its own pin
  }
  const records = await dnsLookup(host, { all: true });
  if (records.length === 0) throw new Error(`refused: AI endpoint host ${host} has no DNS records`);
  for (const r of records) {
    if (blocked(policy, r.address)) {
      throw new Error(
        `refused: AI endpoint ${host} resolves to a blocked address ${r.address} (${policy} policy)`,
      );
    }
  }
  const pin = records[0]?.address;
  if (!pin) throw new Error(`refused: AI endpoint host ${host} has no DNS records`);
  return pin; // pin the connection to the first validated address
}

export interface PinnedResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * A `fetch`-like request that PINS the TCP connection to `pinnedIp` — the
 * address `assertSafeAiEndpoint` already validated. The OS never re-resolves the
 * hostname, so the DNS-rebinding TOCTOU window is closed; TLS SNI + cert
 * validation still use the URL hostname (servername), so https endpoints keep
 * working. Does NOT follow redirects — a 3xx comes back as a non-ok response
 * (the caller treats it as an error), so an allowed host can't 302 inward.
 */
export function pinnedFetch(
  url: string,
  pinnedIp: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<PinnedResponse> {
  const requestFn = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
  // Override DNS resolution for this socket → connect ONLY to the validated IP.
  // Handle both callback shapes: `all:true` wants an address array, else the
  // (address, family) tuple. family 0 (shouldn't happen for a real IP) → 4.
  const family = isIP(pinnedIp) || 4;
  const lookup: LookupFunction = (_host, opts, cb) => {
    if (opts.all) cb(null, [{ address: pinnedIp, family }]);
    else cb(null, pinnedIp, family);
  };
  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = requestFn(
      url,
      { method: init.method ?? "GET", headers: init.headers, lookup },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: () => Promise.resolve(data),
            json: () => Promise.resolve(JSON.parse(data) as unknown),
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
