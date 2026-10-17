// The one fetch an outbound connector uses to reach a URL a person gave it.
//
// assertSafeOutboundUrl checks the address a connector is pointed at, but fetch
// then follows a redirect on its own, and a public server can redirect to a
// loopback or private service the api can reach. So redirects are followed
// here, one hop at a time, and each hop is checked exactly as the first is.
// A credential does not follow a redirect to another origin.

import { assertSafeOutboundUrl } from "./ssrf.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Sent to the origin they were meant for, and no other. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries());
}

export async function safeFetch(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let at = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = headersOf(init);
  for (let hop = 0; ; hop++) {
    const res = await fetch(at, { ...init, method, headers, body, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error("connector: too many redirects");
    const next = new URL(location, at).toString();
    await assertSafeOutboundUrl(next);
    if (new URL(next).origin !== new URL(at).origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())));
    }
    // A redirect after a POST that is not 307/308 is followed as a GET, as browsers do.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !["content-type", "content-length"].includes(k.toLowerCase())));
    }
    await res.body?.cancel().catch(() => undefined);
    at = next;
  }
}
