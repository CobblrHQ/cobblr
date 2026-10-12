// What a guest may read: the allow-list the API's guest gate enforces, and
// the one the web reads before it asks, so a guest's page never makes a
// request the server will refuse (#5190). The why behind it, and the gate,
// live in api/src/auth/guest-reads.ts.

/** When an entry holds: always, or only for what the portal shares. */
export type GuestGrant = "always" | "pinned-view" | "pinned-kind" | "file-of-pinned-kind";

export interface GuestRead {
  why: string;
  grant: GuestGrant;
}

/** Keys are the route after /api/v1/orgs, with :params. */
export const GUEST_READS: Readonly<Record<string, GuestRead>> = {
  "/:slug/me/capabilities": { grant: "always", why: "what this person may do, so the portal draws only their own buttons" },
  "/:slug/notifications": { grant: "always", why: "their own notifications" },
  "/:slug/notifications/unread-count": { grant: "always", why: "their own notifications" },
  "/:slug/portal-config": { grant: "always", why: "the portal itself: what it shows and how" },
  "/:slug/entity-kinds": { grant: "always", why: "the portal's views draw records by their kind" },
  "/:slug/entity-kind-overrides/": { grant: "always", why: "the names the workspace gave its kinds, for the portal's views" },
  "/:slug/field-defs": { grant: "always", why: "the fields a shared record is drawn with" },
  "/:slug/field-sections": { grant: "always", why: "the headings a shared record's fields sit under" },
  "/:slug/native-field-overrides": { grant: "always", why: "the labels a shared record's fields are drawn with" },
  "/:slug/faces": { grant: "always", why: "how a shared record is drawn in a list" },
  "/:slug/pairings/link-kinds": { grant: "always", why: "how a shared record's links are named" },
  "/:slug/instances/": { grant: "always", why: "the collections the portal's views and apps are made of" },
  "/:slug/modules": { grant: "always", why: "which parts of the workspace are on, so the portal draws only those" },
  "/:slug/nav-headings/": { grant: "always", why: "the portal's navigation" },
  "/:slug/live": { grant: "always", why: "live updates to what the portal shows" },
  "/:slug/trial": { grant: "always", why: "whether the workspace is a trial, for the portal's banner" },
  "/:slug/approval-requests/": { grant: "always", why: "a guest may ask for more, and sees their own requests" },
  "/:slug/approval-requests/:id": { grant: "always", why: "a guest may ask for more, and sees their own requests" },
  "/:slug/calendar/events": { grant: "always", why: "a pinned calendar view" },
  "/:slug/modules/core-views/views": { grant: "always", why: "the portal finds its pinned views among the workspace's shared views" },
  "/:slug/modules/core-apps/apps": { grant: "always", why: "the portal's app launcher" },
  "/:slug/modules/core-apps/apps/:app": { grant: "always", why: "opening an app the launcher lists; the app's own check decides who may (#6044)" },
  "/:slug/modules/core-apps/apps/:app/data/:key": { grant: "always", why: "an app in the portal reads its own state; the app decides who may open it" },
  "/:slug/modules/core-file-preview/renderers": { grant: "always", why: "how a file is previewed, the same for everyone" },
  "/:slug/modules/core-views/views/:id/data": { grant: "pinned-view", why: "the records a view pinned in the portal shows" },
  "/:slug/entities/:kind": { grant: "pinned-kind", why: "records of a kind a pinned view shows" },
  "/:slug/entities/:kind/:id": { grant: "pinned-kind", why: "a record of a kind a pinned view shows" },
  "/:slug/entities/:kind/:id/pairings": { grant: "pinned-kind", why: "what such a record is linked to" },
  "/:slug/entities/:kind/:id/address": { grant: "pinned-kind", why: "where such a record is" },
  "/:slug/modules/core-files/files/:id/raw": { grant: "file-of-pinned-kind", why: "a picture of a record a pinned view shows" },
};

/** The entry a key ("/:slug/..." with the concrete rest) falls under, and the
 *  parameters it captured. */
export function matchKey<T>(key: string, table: Readonly<Record<string, T>>): { entry: T; params: Record<string, string> } | null {
  const exact = table[key];
  if (exact) return { entry: exact, params: {} };
  const parts = key.split("/");
  for (const [pattern, entry] of Object.entries(table)) {
    const p = pattern.split("/");
    if (p.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < p.length && ok; i++) {
      if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(parts[i]!);
      else ok = p[i] === parts[i];
    }
    if (ok) return { entry, params };
  }
  return null;
}

/** What a workspace's portal shares with its guests: the views pinned there
 *  and the kinds of record those views show. The server works it out for its
 *  gate, and sends it to a guest with their membership (GET /me), so a guest's
 *  page can judge an entry that holds only for what is shared, too (#5992). */
export interface PortalShares {
  views: string[];
  kinds: string[];
}

/** Could a guest's GET of this path be answered? `path` is what the web asks,
 *  "/orgs/<slug>/...", with or without a query. A router mounted whole is
 *  keyed by the server with a trailing slash, so both spellings are tried.
 *  Without `shares`, true does not mean it will be: an entry for what the
 *  portal shares is decided by the server. With them, a pinned view or kind
 *  outside the share is false here as it is there; a file's record kinds are
 *  only known to the server, so that entry stays true. False means it never
 *  will be answered. */
export function guestMayAsk(path: string, shares?: PortalShares | null): boolean {
  const bare = path.replace(/[?#].*$/, "");
  const m = /^\/orgs\/[^/]+(\/.*)?$/.exec(bare);
  if (!m) return true;
  const rest = (m[1] ?? "").replace(/\/+$/, "");
  const found = matchKey(`/:slug${rest}`, GUEST_READS) ?? matchKey(`/:slug${rest}/`, GUEST_READS);
  if (!found) return false;
  if (!shares) return true;
  switch (found.entry.grant) {
    case "pinned-view":
      return shares.views.includes(found.params.id ?? "");
    case "pinned-kind":
      return shares.kinds.includes(found.params.kind ?? "");
    default:
      return true;
  }
}
