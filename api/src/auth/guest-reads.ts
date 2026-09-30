// What a guest may read of the workspace's own (kernel) routes.
//
// A guest "lands in the member portal and reads what the workspace shares
// there" (USER_GUIDE, the roles table): the workspace itself, its
// configuration, its people and its history are for everyone but a guest. The
// web only ever showed a guest the portal, but the server answered every read
// route to any member of the workspace, so a guest with a token read the
// activity log (who changed what, with their emails), the member list, every
// wire's arguments, the bundle export, the queue's job payloads, the receipt
// address and the calendar feed.
//
// So this is an ALLOW-list, read in withTenant: a kernel GET route not named
// here is refused to a guest, and a new route is closed to guests until
// someone decides otherwise and writes down why. The keys are the route as
// mounted, after /api/v1/orgs. Module routes are not judged here (a module
// mount has no route of its own at that point); the role matrix test holds
// them.

export const GUEST_READS: Readonly<Record<string, string>> = {
  "/:slug/me/capabilities": "what this person may do, so the portal draws only their own buttons",
  "/:slug/notifications": "their own notifications",
  "/:slug/notifications/unread-count": "their own notifications",
  "/:slug/portal-config": "the portal itself: what it shows and how",
  "/:slug/entity-kinds": "the portal's views draw records by their kind",
  "/:slug/entity-kind-overrides/": "the names the workspace gave its kinds, for the portal's views",
  "/:slug/field-defs": "the fields a shared record is drawn with",
  "/:slug/field-sections": "the headings a shared record's fields sit under",
  "/:slug/native-field-overrides": "the labels a shared record's fields are drawn with",
  "/:slug/faces": "how a shared record is drawn in a list",
  "/:slug/entities/:kind": "the records a pinned view lists",
  "/:slug/entities/:kind/:id": "a shared record's own page",
  "/:slug/entities/:kind/:id/pairings": "what a shared record is linked to",
  "/:slug/entities/:kind/:id/address": "where a shared record is",
  "/:slug/pairings/link-kinds": "how a shared record's links are named",
  "/:slug/instances/": "the collections the portal's views and apps are made of",
  "/:slug/modules": "which parts of the workspace are on, so the portal draws only those",
  "/:slug/nav-headings/": "the portal's navigation",
  "/:slug/calendar/events": "a pinned calendar view",
  "/:slug/live": "live updates to what the portal shows",
  "/:slug/trial": "whether the workspace is a trial, for the portal's banner",
  "/:slug/approval-requests/": "a guest may ask for more, and sees their own requests",
  "/:slug/approval-requests/:id": "a guest may ask for more, and sees their own requests",
};

/** The route as the allow-list names it: the matched pattern with this
 *  request's workspace slug put back as `:slug`, after /api/v1/orgs. Null
 *  when the request is not on a route of its own (a module mount). */
export function guestRouteKey(baseUrl: string, routePath: string | undefined, slug: string): string | null {
  if (routePath === undefined) return null;
  const full = `${baseUrl}${routePath}`.split(`/orgs/${slug}`).join("/orgs/:slug");
  const prefix = "/api/v1/orgs";
  return full.startsWith(prefix) ? full.slice(prefix.length) || "/" : null;
}

/** Whether a guest may make this read. */
export function guestMayRead(key: string | null): boolean {
  return key === null || Object.prototype.hasOwnProperty.call(GUEST_READS, key);
}
