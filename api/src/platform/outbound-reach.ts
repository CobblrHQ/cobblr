// Can this api reach what it needs outside itself? (#4847)
//
// After a power cut, try's api came back with no DNS inside its container
// (EAI_AGAIN): every signup failed on the captcha check while /healthz said
// 200, because healthz only asked whether the process and its database were
// up. This asks the other half: for each outbound dependency this deployment
// is CONFIGURED to use, can its host be resolved and connected to? /healthz
// reports it (outbound, outbound_ok) and /readyz answers 503 when one is out,
// so a monitor goes red when signup cannot work, not only when the process is
// down.
//
// What counts: the captcha provider when the captcha is on, the barcode
// resolver and BIdb when their URLs are set, the identity service when set,
// and always one public name (`dns`), which is what failed: a container whose
// resolver path died fails that one even on a deployment with nothing else.
// A dependency that is not configured is not asked about.
//
// Cheap on purpose: a DNS lookup and a TCP connect, no request, each bounded
// by a few seconds, the result kept for a minute so a monitor polling every
// few seconds asks the network once a minute.
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { captchaEnabled } from "./captcha.js";

export interface OutboundTarget {
  name: string;
  host: string;
  port: number;
}

export interface OutboundResult extends OutboundTarget {
  ok: boolean;
  error: string | null;
}

const PUBLIC_PROBE: OutboundTarget = { name: "dns", host: "cloudflare.com", port: 443 };

function fromUrl(name: string, raw: string | undefined): OutboundTarget | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return { name, host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
  } catch {
    return { name, host: s, port: 443 };
  }
}

/** The outbound dependencies this deployment is configured to use. */
export function outboundTargets(env: NodeJS.ProcessEnv = process.env): OutboundTarget[] {
  const out: OutboundTarget[] = [PUBLIC_PROBE];
  if (captchaEnabled()) out.push({ name: "captcha", host: "challenges.cloudflare.com", port: 443 });
  for (const [name, key] of [
    ["barcode_resolver", "COBBLR_BARCODE_RESOLVER_URL"],
    ["bidb", "COBBLR_BIDB_URL"],
    ["identity", "IDENTITY_URL"],
  ] as const) {
    const t = fromUrl(name, env[key]);
    if (t) out.push(t);
  }
  return out;
}

export interface Probe {
  resolve(host: string): Promise<void>;
  reach(host: string, port: number): Promise<void>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

export const realProbe: Probe = {
  async resolve(host) {
    await withTimeout(lookup(host), 4000, `resolving ${host}`);
  },
  reach(host, port) {
    return withTimeout(
      new Promise<void>((resolve, reject) => {
        const s = connect({ host, port });
        s.once("connect", () => { s.destroy(); resolve(); });
        s.once("error", (e) => { s.destroy(); reject(e); });
      }),
      4000,
      `connecting to ${host}:${port}`,
    );
  },
};

/** Ask every target, in parallel; never throws, and never waits on one step
 *  longer than `timeoutMs`: a resolver that hangs is a resolver that is out. */
export async function checkOutbound(targets: OutboundTarget[], probe: Probe = realProbe, timeoutMs = 5000): Promise<OutboundResult[]> {
  return Promise.all(
    targets.map(async (t) => {
      try {
        await withTimeout(probe.resolve(t.host), timeoutMs, `resolving ${t.host}`);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { ...t, ok: false, error: `cannot resolve ${t.host}${code ? ` (${code})` : ""}: ${(e as Error).message}`.slice(0, 200) };
      }
      try {
        await withTimeout(probe.reach(t.host, t.port), timeoutMs, `connecting to ${t.host}:${t.port}`);
      } catch (e) {
        return { ...t, ok: false, error: `cannot connect to ${t.host}:${t.port}: ${(e as Error).message}`.slice(0, 200) };
      }
      return { ...t, ok: true, error: null };
    }),
  );
}

const TTL_MS = 60_000;
let cached: { at: number; results: OutboundResult[] } | null = null;
let inflight: Promise<OutboundResult[]> | null = null;

/** The last minute's answer, asking again when it is older. */
export async function outboundReport(now = Date.now()): Promise<OutboundResult[]> {
  if (cached && now - cached.at < TTL_MS) return cached.results;
  inflight ??= checkOutbound(outboundTargets()).then((results) => {
    cached = { at: Date.now(), results };
    inflight = null;
    return results;
  });
  return inflight;
}

/** What /healthz shows: the last answer without waiting for a new one (healthz
 *  stays fast for the deploy readers and the container healthcheck), and a
 *  refresh started when it is stale. null until the first answer is in. */
export function outboundSnapshot(now = Date.now()): OutboundResult[] | null {
  if (!cached || now - cached.at >= TTL_MS) void outboundReport(now).catch(() => {});
  return cached?.results ?? null;
}
