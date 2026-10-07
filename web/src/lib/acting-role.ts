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
// The role is recorded while the active workspace is worked out (in render,
// not an effect): a page's queries start before its parents' effects run, and
// a query that started before the role was known would still be sent.
import { guestMayAsk } from "@cobblr/platform-contract/guest-reads";

const roles = new Map<string, string>();

export function rememberRole(slug: string, role: string): void {
  roles.set(slug, role);
}

export function roleIn(slug: string): string | null {
  return roles.get(slug) ?? null;
}

/** Is this a read the server would refuse because the person is a guest? */
export function refusedForGuest(method: string, path: string): boolean {
  if (method !== "GET") return false;
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
