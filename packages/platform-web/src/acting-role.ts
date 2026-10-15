// The role this person holds in each workspace they have open, so a request
// can be judged before it is sent (#5190).
//
// A guest is answered only what the guest allow-list names
// (@cobblr/platform-contract/guest-reads), and the server refuses the rest
// with 403. The shell used to ask anyway: the currency, the bundles, the AI
// status, Cobb's models, on every page a guest opened. So a guest's read that
// no entry could answer is refused here, the same way the server would, and
// never leaves the page.
//
// It lives here, not in the web app, because a module's own pages talk to the
// API through their own clients (an inventory page asking what is going off
// soon): those go through workspaceFetch below, and one role registry answers
// for the shell and every module alike (#5598).
//
// The role is recorded while the active workspace is worked out (in render,
// not an effect): a page's queries start before its parents' effects run, and
// a query that started before the role was known would still be sent.
import { guestMayAsk, type PortalShares } from "@cobblr/platform-contract/guest-reads";
import { approvalDedupeKey, type BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { awaitBlockedAction, carriesOnItself, raiseBlockedAction, refusedRequestFor } from "./blocked-action";
import { primedRead } from "./primed-reads";
import { sharedRead } from "./shared-reads";

const roles = new Map<string, string>();
const shared = new Map<string, PortalShares>();

/** `shares`: what the portal shares, sent with a guest's membership. An older
 *  server sends none, and then the server alone judges a read of a share. */
export function rememberRole(slug: string, role: string, shares?: PortalShares | null): void {
  roles.set(slug, role);
  if (shares) shared.set(slug, shares);
  else shared.delete(slug);
}

export function roleIn(slug: string): string | null {
  return roles.get(slug) ?? null;
}

/** Is this a read the server would refuse because the person is a guest?
 *  `path` is "/orgs/<slug>/...", as the web's own client spells it. */
export function refusedForGuest(method: string, path: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const slug = /^\/orgs\/([^/?#]+)/.exec(path)?.[1];
  if (!slug || roleIn(decodeURIComponent(slug)) !== "guest") return false;
  return !guestMayAsk(path, shared.get(decodeURIComponent(slug)));
}

/** For a write the page makes on its own, not one a person pressed (a scanned
 *  label asking its shelf to light up): would it be made at all? A guest
 *  changes nothing but what the portal lets them, so the page does not send
 *  it. A write a person asked for still goes, so the server's refusal can
 *  offer to ask for more. */
export function makesBackgroundWrites(slug: string): boolean {
  return roleIn(slug) !== "guest";
}

/** For a query's `enabled`: may the person in this workspace read this path? */
export function mayRead(path: string): boolean {
  return !refusedForGuest("GET", path);
}

/** The server's sentence for the same refusal (api/src/middleware/tenant.ts). */
export const GUEST_NOT_SHARED = "A guest sees what this workspace shares in its portal, and this is not part of it.";

/** `fetch`, for a module page talking to its workspace: a guest's read the
 *  server would refuse is answered here with the server's own 403, so it never
 *  leaves the page and the client's usual error path handles it. Anything else,
 *  and any address outside /api/v1/orgs, goes out as fetch would send it.
 *
 *  A write the server refuses with a remedy (`error.blocked`: an app that is
 *  off, a permission to ask for) raises the one blocked-action sheet, with the
 *  refused request kept so the sheet can finish it, exactly as the web's own
 *  client does. Without this a module page met the remedy as a sentence and a
 *  Close button: Sales' Make told an owner Builds was off and offered nothing
 *  (#5865). A switch the person holds (an app that is off, for its owner)
 *  holds the call until they choose: turned on, the request runs again and
 *  ITS answer is what the page gets, so a second refusal is shown the way the
 *  first would have been (#5890); closed, the page gets the refusal. */
export async function workspaceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/api\/v1(?=\/orgs\/)/, "");
  if (refusedForGuest(method, path)) {
    return new Response(JSON.stringify({ error: { code: "guest_not_shared", message: GUEST_NOT_SHARED } }), { status: 403, headers: { "content-type": "application/json" } });
  }
  // The dashboard's snapshot may already hold this read (primed-reads.ts).
  if (path.startsWith("/orgs/")) {
    const primed = await primedRead(method, path);
    if (primed) return new Response(JSON.stringify(primed.body), { status: primed.status, headers: { "content-type": "application/json" } });
  }
  let applied: string | null = null;
  for (;;) {
    const res = await send(input, init, method);
    if (res.status < 400 || res.status >= 500 || !path.startsWith("/orgs/")) return res;
    const sent = typeof init?.body === "string" ? parseBody(init.body) : undefined;
    const refused = refusedRequestFor(method, path, sent);
    if (!refused) return res;
    const body = (await res.clone().json().catch(() => null)) as { error?: { blocked?: BlockedAction } } | null;
    const blocked = body?.error?.blocked;
    if (!blocked || !Array.isArray(blocked.remedies)) return res;
    // A body fetch cannot send twice (a stream, a Request) is replayed by the sheet instead.
    const again = carriesOnItself(blocked, method, path, sent) && !(input instanceof Request) && (init?.body == null || typeof init.body === "string");
    const key = approvalDedupeKey(blocked.remedies);
    if (!again || key === applied) {
      raiseBlockedAction({ blocked, refused, subject: null });
      return res;
    }
    if ((await awaitBlockedAction({ blocked, refused, subject: null })) !== "applied") return res;
    applied = key;
  }
}

/** A GET already on its way, asked the same way, is answered by that one
 *  request, and any other method drops what is on its way (shared-reads.ts,
 *  #6613). A read that can be cut short, or is a Request of its own, goes
 *  out as it was asked. */
function send(input: string | URL | Request, init: RequestInit | undefined, method: string): Promise<Response> {
  const own = input instanceof Request || !!init?.signal || init?.body != null;
  if (own && method === "GET") return fetch(input, init);
  const headers = [...new Headers(init?.headers).entries()].map(([k, v]) => `${k}=${v}`).join("&");
  return sharedRead(method, `${headers} ${String(input)}`, () => fetch(input, init));
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
