// The one fetch an outbound connector uses to reach a URL a person gave it.
//
// Two ways a checked address stops being the address that is reached: fetch
// follows a redirect on its own (a public server can send it to a loopback or
// private service), and fetch looks the name up again when it connects (a name
// that answered public to the check can answer private to the connect: DNS
// rebinding). So every hop is resolved once, checked, and the connection is
// pinned to the address that was checked, by the platform's one pinning fetch
// (@cobblr/platform-net). The chain is walked here, a hop at a time, because a
// credential must not follow a redirect to another origin.

import { pinnedRedirectingFetch } from "@cobblr/platform-net";
import { resolveSafeOutboundTarget } from "./ssrf.js";

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
  let body = init.body as string | undefined;
  let headers = headersOf(init);
  for (let hop = 0; ; hop++) {
    const { response, dispatcher } = await pinnedRedirectingFetch({
      url: at,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal,
      stopAtRedirect: true,
      // Resolved and checked here, once for this hop; the connection goes to this
      // address and the name is not looked up again.
      validate: async (u) => resolveSafeOutboundTarget(u.toString()),
    });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response as unknown as Response;
    await response.body?.cancel().catch(() => undefined);
    await dispatcher?.close().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error("connector: too many redirects");
    const next = new URL(location, at).toString();
    if (new URL(next).origin !== new URL(at).origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.includes(k.toLowerCase())));
    }
    // A redirect after a POST that is not 307/308 is followed as a GET, as browsers do.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !["content-type", "content-length"].includes(k.toLowerCase())));
    }
    at = next;
  }
}
