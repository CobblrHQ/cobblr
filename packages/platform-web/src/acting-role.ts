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
import { guestMayAsk } from "@cobblr/platform-contract/guest-reads";
import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";
import { raiseBlockedAction, refusedRequestFor } from "./blocked-action";

const roles = new Map<string, string>();

export function rememberRole(slug: string, role: string): void {
  roles.set(slug, role);
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
  return !guestMayAsk(path);
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
 *  (#5865). The response still reaches the caller unchanged. */
export async function workspaceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/api\/v1(?=\/orgs\/)/, "");
  if (refusedForGuest(method, path)) {
    return new Response(JSON.stringify({ error: { code: "guest_not_shared", message: GUEST_NOT_SHARED } }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const res = await fetch(input, init);
  if (res.status >= 400 && res.status < 500 && path.startsWith("/orgs/")) await raiseIfBlocked(res, method, path, init?.body);
  return res;
}

/** The blocked refusal in a response, if it carries one, raised for the sheet. */
async function raiseIfBlocked(res: Response, method: string, path: string, sent: unknown): Promise<void> {
  const refused = refusedRequestFor(method, path, typeof sent === "string" ? parseBody(sent) : undefined);
  if (!refused) return;
  const body = (await res.clone().json().catch(() => null)) as { error?: { blocked?: BlockedAction } } | null;
  const blocked = body?.error?.blocked;
  if (blocked && Array.isArray(blocked.remedies)) raiseBlockedAction({ blocked, refused, subject: null });
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
