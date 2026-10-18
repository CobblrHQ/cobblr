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
// The dangerous/private split (self-host allows RFC1918, cloud blocks it) is the
// ONE canonical rule in the contract now, so this module's copy cannot drift
// from the kernel's. Re-exported under the names the driver code already uses.
import { isDangerousIp, isPrivateIp } from "@cobblr/platform-contract/private-ip";

export { isDangerousIp, isPrivateIp };

/** Check one URL under the current deployment's egress policy and return the
 *  address to hold the connection to, or null for a name this machine cannot
 *  resolve (self-host only: a `.lan`/mDNS name the OS resolves). Throws when the
 *  URL is not one a machine may have. Every resolved address is checked; the
 *  first is the pin. Async because it resolves DNS. */
export async function resolveSafeMachineTarget(u: URL): Promise<{ address: string; family: number } | null> {
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

  const literal = isIP(host);
  if (literal) {
    if (blocked(host)) throw new Error(`address ${host} is not allowed (${strict ? "strict" : "lan"} egress policy)`);
    return { address: host, family: literal };
  }
  let records: Array<{ address: string; family: number }>;
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
    return null;
  }
  for (const r of records) {
    if (blocked(r.address)) {
      throw new Error(`host ${host} resolves to a blocked address ${r.address} (${strict ? "strict" : "lan"} egress policy)`);
    }
  }
  return { address: records[0]!.address, family: records[0]!.family };
}

/** Throw if `raw` isn't an http(s) URL safe for a machine manager under the
 *  current egress policy. For an early answer when an address is saved; the
 *  call itself goes through machineFetch, which checks and pins each hop. */
export async function assertSafeMachineUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  await resolveSafeMachineTarget(u);
}
