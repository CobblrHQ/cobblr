// What a View as through a share may ask (docs/design-decisions/share-spaces.md §14).
//
// One rule for both sides. The server holds a share view's requests to it
// (requireAuth, api/src/auth/middleware.ts), and the web's client refuses,
// unsent, what it would refuse: the bell and the record stream asked the
// /me notifications and a stream ticket in every share view and were refused
// with 403 for the life of the tab (#9129).

import type { BlockedAction } from "@cobblr/platform-contract/blocked-action";

export const SHARE_VIEW_READ_ONLY = "Viewing as someone is read-only.";

/** Why, for the app's one refusal sheet (#4687): the same from either side. */
export const SHARE_VIEW_BLOCKED: BlockedAction = {
  sentence: "This is a read-only preview of what they see, so nothing can be changed here.",
  remedies: [],
  requestable: false,
  reason: "Exit the view to make changes in your own workspace.",
  approvers: { count: 0, names: [] },
  pending: null,
};

/** Reads of its one workspace, the account read the app starts from
 *  (answered narrowed, me.ts), and ending or renewing itself. `path` is the
 *  request's full path ("/api/v1/..."). `slug` is the share space's: the web
 *  learns it only from /me, so a null slug admits any workspace's reads, and
 *  the client never refuses what the server would answer. */
export function shareViewPathAllowed(method: string, originalUrl: string, slug: string | null): boolean {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  if (path.includes("..")) return false;
  if (method === "POST") return path === "/api/v1/share-view/end" || path === "/api/v1/share-view/renew";
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/api/v1/me") return true;
  if (slug === null) return /^\/api\/v1\/orgs\/[^/]+(\/|$)/.test(path);
  const safe = slug.replace(/[^a-z0-9-]/gi, "");
  if (!safe) return false;
  return path === `/api/v1/orgs/${safe}` || path.startsWith(`/api/v1/orgs/${safe}/`);
}
