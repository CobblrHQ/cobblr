// The one fetch a machine driver uses to reach an address a person gave it.
//
// The address was checked once and then fetched with the plain fetch, which
// looks the name up again to connect (DNS rebinding: public to the check,
// loopback to the connect) and follows a redirect on its own. So each call is
// resolved once, checked under the deployment's egress policy (ssrf.ts: a
// self-hosted box reaches its own LAN, the cloud does not) and the connection
// is pinned to the address that was checked, by the platform's one pinning
// fetch. A manager's address is its own: a redirect is followed only within the
// same host (http to https on a proxy), re-checked and re-pinned, and never to
// another host, so a credential header does not leave with it.
//
// The one name that cannot be pinned is one this machine's resolver cannot
// answer (a `.lan` or mDNS name, self-host only: the cloud refuses it). It is
// fetched by name, without following a redirect.
import { pinnedRedirectingFetch } from "@cobblr/platform-net";
import { resolveSafeMachineTarget } from "./ssrf.js";
import { requestSignal } from "./timeouts.js";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).entries());
}

export async function machineFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const host = new URL(url).hostname.toLowerCase();
  let at = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body ?? undefined;
  for (let hop = 0; ; hop++) {
    const target = await resolveSafeMachineTarget(new URL(at));
    let response: Response;
    if (target) {
      const pinned = await pinnedRedirectingFetch({
        url: at,
        method,
        headers: headersOf(init),
        ...(body != null ? { body: body as never } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        stopAtRedirect: true,
        // Resolved and checked above, once for this hop; the connection goes to
        // this address and the name is not looked up again.
        validate: async () => target,
      });
      response = pinned.response as unknown as Response;
    } else {
      // EGRESS: workspace-lan-device - a name this machine's resolver cannot answer (self-host only), already checked by resolveSafeMachineTarget; a redirect on it is refused
      response = await fetch(at, { ...init, method, ...(body != null ? { body } : {}), redirect: "manual", signal: init.signal ?? requestSignal() });
    }
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (init.redirect === "error") throw new Error("machine address answered with a redirect");
    if (!target) throw new Error("machine address answered with a redirect");
    if (hop >= MAX_REDIRECTS) throw new Error("machine address redirected too many times");
    const next = new URL(location, at);
    if (next.hostname.toLowerCase() !== host) throw new Error("machine address redirected to another host");
    // A redirect after a POST that is not 307/308 is followed as a GET, as browsers do.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    at = next.toString();
  }
}
