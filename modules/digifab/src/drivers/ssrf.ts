// SSRF guard for machine-manager URLs. digifab INTENTIONALLY talks to LAN
// managers on a self-hosted box — your OctoPrint at 192.168.x, your bridge at
// 10.x — so on self-host we allow private ranges and block only loopback /
// link-local / cloud-metadata. On a MULTI-TENANT CLOUD host that's unsafe: a
// tenant could point a machine URL at the prod internal network and probe it.
//
// So the policy is deployment-aware, reusing the platform's egress signal
// (`platform().ai.getEndpointPolicy()` — the contract documents it as the
// read-this-before-fetching-a-user-URL policy; the hosted overlay sets it to
// "strict" at boot, open core stays "lan"):
//   - "lan"    (self-host): RFC1918 allowed; loopback/metadata/0.0.0.0 blocked.
//   - "strict" (cloud): ALL private + loopback + link-local + metadata blocked.
//
// And it RESOLVES DNS, checking every resolved address — so a hostname that
// resolves to a blocked IP can't slip past the literal-IP check (the previous
// guard only inspected `net.isIP(host)`, so ANY hostname bypassed it entirely).
//
// NOTE: still a resolve-then-fetch (the driver re-resolves on the actual
// request), so a fast DNS-rebind has a narrow TOCTOU window. Connection-pinning
// (see core-ai's pinnedFetch) closes the last gap — a follow-up; this shuts the
// wide-open hostname bypass + the cloud-allows-LAN hole. See 2026-06-10 audit.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { platform } from "@cobblr/platform-contract";

/** Always blocked under BOTH policies — loopback, link-local + cloud metadata
 *  (169.254.169.254), 0.0.0.0, multicast, IPv6 loopback/ULA/link-local. */
export function isDangerousIp(ip: string): boolean {
  if (!ip) return true;
  const family = isIP(ip);
  if (family === 4) {
    const p = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isDangerousIp(v4);
    }
    return false;
  }
  return true; // not a parseable IP → unsafe
}

/** The strict (cloud) set: dangerous + RFC1918 private + CGNAT/tailnet. */
export function isPrivateIp(ip: string): boolean {
  if (isDangerousIp(ip)) return true;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map((n) => Number.parseInt(n, 10)) as [number, number, number, number];
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (incl. tailnet)
    return false;
  }
  if (isIP(ip) === 6 && ip.toLowerCase().startsWith("::ffff:")) {
    const v4 = ip.toLowerCase().slice("::ffff:".length);
    if (isIP(v4) === 4) return isPrivateIp(v4);
  }
  return false;
}

/** Throw if `raw` isn't an http(s) URL safe for a server-side fetch to a
 *  machine manager under the current deployment's egress policy. Async because
 *  it resolves DNS. */
export async function assertSafeMachineUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // CI/test-only escape: the FDMM-import + webhook tests spin a fake manager on
  // loopback (127.0.0.1 / ::1) next to the api. Mirrors the webhook guard's
  // COBBLR_WEBHOOK_ALLOW_INTERNAL. NEVER set in any deployed environment, so it
  // can't loosen prod — the guard's real policy is unchanged there.
  const allowInternal = process.env.COBBLR_MACHINE_ALLOW_INTERNAL === "1";
  const isLoopbackIp = (ip: string) => ip === "::1" || (isIP(ip) === 4 && ip.split(".")[0] === "127");
  if (!allowInternal && (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost"))) {
    throw new Error("loopback host is not allowed");
  }
  const strict = platform().ai.getEndpointPolicy() === "strict";
  const blocked = (ip: string) => {
    if (allowInternal && isLoopbackIp(ip)) return false;
    return strict ? isPrivateIp(ip) : isDangerousIp(ip);
  };

  if (isIP(host)) {
    if (blocked(host)) throw new Error(`address ${host} is not allowed (${strict ? "strict" : "lan"} egress policy)`);
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dnsLookup(host, { all: true });
  } catch {
    records = [];
  }
  if (records.length === 0) {
    // Doesn't resolve here. On self-host (lan) that's fine — a `.lan`/mDNS name
    // resolves only on the operator's own network, and a host that resolves to
    // nothing can't be an SSRF target. On cloud (strict) there's no legitimate
    // non-resolving machine URL, and allowing one would re-open a rebind via an
    // NXDOMAIN-at-check host, so refuse it.
    if (strict) throw new Error(`host ${host} does not resolve (strict egress policy)`);
    return;
  }
  for (const r of records) {
    if (blocked(r.address)) {
      throw new Error(`host ${host} resolves to a blocked address ${r.address} (${strict ? "strict" : "lan"} egress policy)`);
    }
  }
}
