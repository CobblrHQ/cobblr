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
// Redirect + DNS-rebind safe (audit B2b): guardedFetch follows redirects itself
// with redirect:"manual", re-validating EVERY hop's target (so a public host that
// 302s to http://<tailnet>/ is caught at the hop, not followed blindly), and pins
// each hop's TCP connection to the exact IP the guard just validated via an
// undici Agent (so a DNS rebind between our check and the connect can't land on a
// private address). Mirrors the sandbox HOST_FETCH loop.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { pinnedRedirectingFetch, type PinnedFetchArgs } from "@cobblr/platform-net";
import { platform } from "@cobblr/platform-contract";
import { isPrivateIp, isLinkLocalIp } from "@cobblr/platform-contract/private-ip";

/** A redirect chain longer than this is refused rather than followed. */
const MAX_REDIRECTS = 5;

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

// The private/link-local rule is the ONE canonical predicate in the contract
// (@cobblr/platform-contract/private-ip) — re-exported here under the names this
// module's callers already use, so there is one rule, not five that drift.
export const isLinkLocal = isLinkLocalIp;
export const isPrivate = isPrivateIp;

/** Pure policy decision (the testable core). `strict` = block private (the cloud
 *  egress policy); else LAN is allowed (self-host). Returns a block reason, or null. */
export function egressBlockReason(ip: string, opts: { strict: boolean; allowed: boolean }): string | null {
  if (isLinkLocal(ip)) return `blocked link-local/metadata host ${ip}`;
  if (opts.strict && isPrivate(ip) && !opts.allowed) {
    return `blocked private/internal host ${ip} on a hosted instance — reach local sources via an edge connector, not a direct address`;
  }
  return null;
}

/** Resolve EVERY address for a host (a public+private split answer must not pass
 *  on the public record then connect to the private one). Returns them all. */
async function resolveAll(host: string): Promise<{ address: string; family: number }[]> {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  try {
    return await lookup(host, { all: true });
  } catch {
    throw new Error(`egress: cannot resolve host ${host}`);
  }
}

/** Validate one hop's URL under the current policy and return the IP to pin the
 *  connection to (all resolved addresses are checked; the first is the pin, since
 *  they all passed). Throws with the block reason on any disallowed address. */
async function validateEgressHop(orgId: string, url: URL): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = await resolveAll(host);
  if (addrs.length === 0) throw new Error(`egress: cannot resolve host ${host}`);
  const strict = isStrict();
  for (const { address } of addrs) {
    let allowed = false;
    if (strict && isPrivate(address)) {
      for (const p of allowProviders) {
        if (await p(orgId, address, url)) {
          allowed = true;
          break;
        }
      }
    }
    const reason = egressBlockReason(address, { strict, allowed });
    if (reason) throw new Error(`egress: ${reason}`);
  }
  return addrs[0]!;
}

/** SSRF-guarded outbound fetch for a tenant. Follows redirects and re-pins every
 *  hop through the shared pinnedRedirectingFetch (the policy is validateEgressHop).
 *  Returns a WHATWG Response (undici's); its pinned Agent is left for undici's
 *  idle reaper, since the caller streams the body (e.g. the bounded gunzip read). */
export async function guardedFetch(
  orgId: string,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();
  const { response } = await pinnedRedirectingFetch({
    url: href,
    method,
    body:
      init?.body !== undefined && method !== "GET" && method !== "HEAD"
        ? (init.body as PinnedFetchArgs["body"])
        : undefined,
    maxRedirects: MAX_REDIRECTS,
    ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
    ...(init?.signal ? { signal: init.signal as AbortSignal } : {}),
    validate: (url) => validateEgressHop(orgId, url),
  });
  return response as unknown as Response;
}
