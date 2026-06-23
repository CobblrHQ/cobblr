// Per-tenant egress policy — the ONE place every external-HTTP path (sync
// connectors, device drivers, webhooks, module polls) routes outbound fetches,
// so the SSRF posture is consistent instead of the historic per-module guards
// (digifab allowed LAN, integrations' webhook guard blocked all, sync allowed
// LAN — see docs/BACKLOG "Consolidate egress into one per-tenant platform policy").
//
// Policy:
//   • link-local / cloud-metadata (169.254/16, fe80::/10) — ALWAYS blocked.
//   • HOSTED (COBBLR_HOSTED=true — the managed/public-prod deployment): a
//     private/internal target is blocked UNLESS a registered allow-provider OKs
//     it for this org — i.e. the tenant's OWN registered edge endpoint. A tenant
//     cannot reach the host's LAN, co-located stacks, or cloud internals.
//   • SELF-HOSTED (default): private LAN is allowed — it's the user's own network.
//
// Known residual (tracked): check-then-fetch isn't pinned against DNS rebinding;
// the resolved IP is validated but fetch() re-resolves. Same gap the prior
// per-module guards had; pin-the-IP is a follow-up.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { platform } from "@cobblr/platform-contract";

export type EgressAllow = (orgId: string, ip: string, url: URL) => boolean | Promise<boolean>;

const allowProviders: EgressAllow[] = [];
export function registerAllow(p: EgressAllow): void {
  allowProviders.push(p);
}

// The canonical, audited deployment egress signal: the hosted overlay sets
// setEndpointPolicy("strict") at boot (fail-safe default), self-host stays "lan",
// and a hosted box that legitimately needs LAN can opt back to "lan" — so this
// honours that escape hatch where a raw COBBLR_HOSTED check wouldn't.
const isStrict = (): boolean => platform().ai.getEndpointPolicy() === "strict";

export function isLinkLocal(ip: string): boolean {
  if (ip.startsWith("169.254.")) return true; // IPv4 link-local incl. 169.254.169.254
  return ip.toLowerCase().startsWith("fe80:"); // IPv6 link-local
}

/** RFC1918 + loopback + CGNAT/tailnet + IPv6 ULA/loopback + IPv4-mapped. */
export function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o[0] === 10) return true; // 10.0.0.0/8
    if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
    if (o[0] === 127) return true; // loopback
    if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return true; // 100.64.0.0/10 CGNAT (Tailscale)
    if (o[0] === 0) return true; // 0.0.0.0/8
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
  if (low.startsWith("::ffff:")) {
    const mapped = low.slice(7);
    if (net.isIPv4(mapped)) return isPrivate(mapped);
  }
  return false;
}

/** Pure policy decision (the testable core). `strict` = block private (the cloud
 *  egress policy); else LAN is allowed (self-host). Returns a block reason, or null. */
export function egressBlockReason(ip: string, opts: { strict: boolean; allowed: boolean }): string | null {
  if (isLinkLocal(ip)) return `blocked link-local/metadata host ${ip}`;
  if (opts.strict && isPrivate(ip) && !opts.allowed) {
    return `blocked private/internal host ${ip} on a hosted instance — reach local sources via an edge connector, not a direct address`;
  }
  return null;
}

async function resolveIp(host: string): Promise<string> {
  if (net.isIP(host)) return host;
  try {
    return (await lookup(host)).address;
  } catch {
    throw new Error(`egress: cannot resolve host ${host}`);
  }
}

/** SSRF-guarded outbound fetch for a tenant. */
export async function guardedFetch(
  orgId: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const ip = await resolveIp(new URL(href).hostname);

  // Under the strict (cloud) policy, a private target is permitted only if some
  // allow-provider claims it for this org (the tenant's registered edge endpoint).
  const strict = isStrict();
  let allowed = false;
  if (strict && isPrivate(ip)) {
    const url = new URL(href);
    for (const p of allowProviders) {
      if (await p(orgId, ip, url)) {
        allowed = true;
        break;
      }
    }
  }
  const reason = egressBlockReason(ip, { strict, allowed });
  if (reason) throw new Error(`egress: ${reason}`);
  return fetch(input, init);
}
