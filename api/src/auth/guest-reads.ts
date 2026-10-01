// What a guest may read.
//
// A guest "lands in the member portal and reads what the workspace shares
// there" (USER_GUIDE, the roles table): the workspace itself, its
// configuration, its people and its history are for everyone but a guest, and
// its records are a guest's only where a view pinned in the portal shows them.
// The web only ever showed a guest the portal, but the server answered every
// read to any member of the workspace, so a guest with a token read the
// activity log (who changed what, with their emails), the member list, every
// wire's arguments, the bundle export, the queue's job payloads, the scan
// inbox and every record of every kind.
//
// So this is an ALLOW-list, read in withTenant for every GET a guest makes:
// kernel routes by their pattern, and routes mounted whole (a module, a
// collection's items) by their path. A read not named here is refused, so a
// new route is closed to guests until someone decides otherwise and writes
// down why. Some entries hold only for what the portal shares: a view pinned
// there, the kinds those views show, a file attached to such a record.

import { sql, type Kysely } from "kysely";

/** When an entry holds: always, or only for what the portal shares. */
export type GuestGrant = "always" | "pinned-view" | "pinned-kind" | "file-of-pinned-kind";

interface GuestRead {
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
  "/:slug/modules/core-apps/apps/:app/data/:key": { grant: "always", why: "an app in the portal reads its own state; the app decides who may open it" },
  "/:slug/modules/core-file-preview/renderers": { grant: "always", why: "how a file is previewed, the same for everyone" },
  "/:slug/modules/core-views/views/:id/data": { grant: "pinned-view", why: "the records a view pinned in the portal shows" },
  "/:slug/entities/:kind": { grant: "pinned-kind", why: "records of a kind a pinned view shows" },
  "/:slug/entities/:kind/:id": { grant: "pinned-kind", why: "a record of a kind a pinned view shows" },
  "/:slug/entities/:kind/:id/pairings": { grant: "pinned-kind", why: "what such a record is linked to" },
  "/:slug/entities/:kind/:id/address": { grant: "pinned-kind", why: "where such a record is" },
  "/:slug/modules/core-files/files/:id/raw": { grant: "file-of-pinned-kind", why: "a picture of a record a pinned view shows" },
};

/** What a guest may change, keyed "METHOD key". Everything else a guest
 *  sends that is not a read is refused here, before any route runs, so a
 *  route that forgot its own role check still cannot be written by a guest. */
export const GUEST_WRITES: Readonly<Record<string, { why: string }>> = {
  "POST /:slug/notifications/:id/read": { why: "their own notifications" },
  "POST /:slug/notifications/read-all": { why: "their own notifications" },
  "POST /:slug/approval-requests/": { why: "a guest may ask for more" },
  "POST /:slug/approval-requests/describe": { why: "the explanation a refusal carries, before asking" },
  "POST /:slug/approval-requests/:id/withdraw": { why: "their own request (the route checks it is theirs)" },
  "POST /:slug/approval-requests/:id/ask-again": { why: "their own request (the route checks it is theirs)" },
  "POST /:slug/approval-requests/:id/resume": { why: "their own request, once granted (the route checks it is theirs)" },
  "POST /:slug/approval-requests/:id/complete": { why: "their own request, once granted (the route checks it is theirs)" },
  "PUT /:slug/modules/core-apps/apps/:app/data/:key": { why: "an app in the portal keeps its own state; the app decides who may open it" },
  "DELETE /:slug/members/:userId": { why: "leaving the workspace; the route refuses a guest removing anyone but themselves" },
  "POST /:slug/actions/invoke": { why: "a button in a portal app; the action refuses a guest unless it was granted to them" },
};

/** Whether a guest may make this write. */
export function guestMayWrite(method: string, key: string | null): boolean {
  if (key === null) return true;
  return matchKey(`${method} ${key}`, GUEST_WRITES) !== null;
}

/** The request as the allow-list names it: the route after /api/v1/orgs with
 *  this workspace's slug put back as `:slug`. A kernel route gives its own
 *  pattern; a route mounted whole gives its concrete path, matched below. */
export function guestRouteKey(baseUrl: string, routePath: string | undefined, path: string, slug: string): string | null {
  const full = routePath !== undefined ? `${baseUrl}${routePath}` : `${baseUrl}${path}`;
  const named = full.split(`/orgs/${slug}`).join("/orgs/:slug");
  const prefix = "/api/v1/orgs";
  return named.startsWith(prefix) ? named.slice(prefix.length) || "/" : null;
}

/** The entry a key falls under, and the parameters it captured. */
export function matchGuestRead(key: string): { entry: GuestRead; params: Record<string, string> } | null {
  return matchKey(key, GUEST_READS);
}

function matchKey<T>(key: string, table: Readonly<Record<string, T>>): { entry: T; params: Record<string, string> } | null {
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

/** What the portal shares: the views pinned there and the kinds they show. */
export async function portalShares(
  portalConfig: unknown,
  db: Kysely<unknown>,
): Promise<{ views: Set<string>; kinds: Set<string> }> {
  const pinned = ((portalConfig as { pinned_views?: unknown } | null)?.pinned_views ?? []) as unknown[];
  const views = new Set(pinned.filter((x): x is string => typeof x === "string"));
  const kinds = new Set<string>();
  if (views.size) {
    const { rows } = await sql<{ entity_kind: string }>`select entity_kind from core_views_views where id = any(${[...views]}::uuid[])`
      .execute(db)
      .catch(() => ({ rows: [] as { entity_kind: string }[] }));
    for (const r of rows) kinds.add(r.entity_kind);
  }
  return { views, kinds };
}

/** Whether a guest may make this read. `shares` is read only when an entry
 *  depends on it. */
export async function guestMayRead(
  key: string | null,
  routeParams: Record<string, string>,
  shares: () => Promise<{ views: Set<string>; kinds: Set<string> }>,
  fileKinds: (fileId: string) => Promise<string[]>,
): Promise<boolean> {
  if (key === null) return true;
  const found = matchGuestRead(key);
  if (!found) return false;
  // A kernel route's key is its own pattern: its values are the request's.
  const m = { entry: found.entry, params: { ...found.params, ...routeParams } };
  switch (m.entry.grant) {
    case "always":
      return true;
    case "pinned-view":
      return (await shares()).views.has(m.params.id ?? "");
    case "pinned-kind":
      return (await shares()).kinds.has(m.params.kind ?? "");
    case "file-of-pinned-kind": {
      const kinds = (await shares()).kinds;
      return (await fileKinds(m.params.id ?? "")).some((k) => kinds.has(k));
    }
  }
}
