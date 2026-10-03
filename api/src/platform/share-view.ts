// View as, through a share (#4627 §5a, docs/design-decisions/share-spaces.md §14).
//
// The owner opens the share space exactly as the friend sees it: their role,
// their scan inbox, their suggestions and notifications, what the toggles let
// through. The share space lives on the friend's Cobblr, where the owner has no
// account, so the owner's Cobblr asks the friend's for a grant over the signed
// link, and the friend's Cobblr makes one: a short-lived token for the share
// space's own person, held by requireAuth to reads of that one workspace and
// refused once the grant (share_view_sessions) is ended or runs out, or the
// share itself has ended. It is a preview of one's own share, not a support
// session: the tab renews its grant quietly while the share lasts (#4695),
// so there is no allowance of minutes to watch. The
// friend's Sharing page shows when it was last used. Owner-only: the owner's
// side of a share is his whole workspace, so there is no reverse.

import { meta } from "../db/meta.js";
import { signShareView } from "../auth/jwt.js";
import { getShareLink, signedPeerPost, type ShareLinkRow } from "./share-sync.js";

/** How long one grant lasts before the tab renews it: a stolen token stays
 *  short-lived, while the preview itself has no end but Exit or the share's. */
const VIEW_MINUTES = 30;

/** The share space's side: make a grant to look through this link. */
export async function mintShareView(shareLinkId: string, viewerName: string | null): Promise<{ token: string; slug: string; expires_at: string }> {
  const link = await meta.selectFrom("share_links as l").innerJoin("orgs as o", "o.id", "l.org_id").select(["l.id", "l.org_id", "l.side", "l.status", "l.created_by", "o.slug"]).where("l.id", "=", shareLinkId).executeTakeFirst();
  if (!link || link.side !== "share" || link.status !== "active") throw new Error("This share has ended.");
  if (!link.created_by) throw new Error("This share space has nobody to view it as.");
  const expires = new Date(Date.now() + VIEW_MINUTES * 60_000);
  const row = await meta
    .insertInto("share_view_sessions")
    .values({ link_id: link.id, org_id: link.org_id, target_user_id: link.created_by, viewer_name: viewerName?.slice(0, 120) || null, expires_at: expires })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token: await signShareView(link.created_by, row.id, expires), slug: link.slug, expires_at: expires.toISOString() };
}

/** The owner's side: ask for a grant, and say where to open it. */
export async function requestShareView(ownerLinkId: string, viewerName: string | null): Promise<{ url: string; expires_at: string }> {
  const link = (await getShareLink(ownerLinkId)) as ShareLinkRow | null;
  if (!link || link.side !== "owner" || link.status !== "active" || !link.peer_link_id) throw new Error("This share is not live.");
  if (!link.peer_url) {
    const got = await mintShareView(link.peer_link_id, viewerName);
    return { url: `/view-as#t=${encodeURIComponent(got.token)}&w=${encodeURIComponent(got.slug)}`, expires_at: got.expires_at };
  }
  const res = await signedPeerPost(link, `/api/v1/share-links/${link.peer_link_id}/view`, { viewer: viewerName });
  const said = (await res.json().catch(() => null)) as { token?: string; slug?: string; expires_at?: string; error?: { message?: string } } | null;
  if (!res.ok || !said?.token || !said.slug) throw new Error(said?.error?.message ?? `${link.peer_name ?? "Their"} Cobblr would not open a view (${res.status}).`);
  return { url: `${link.peer_url}/view-as#t=${encodeURIComponent(said.token)}&w=${encodeURIComponent(said.slug)}`, expires_at: said.expires_at ?? "" };
}

/** The tab renews its grant while the view is open: the same session, a
 *  fresh token and end, refused once Exit ended it or the share has ended. */
export async function renewShareView(sessionId: string): Promise<{ token: string; expires_at: string }> {
  const s = await meta
    .selectFrom("share_view_sessions as v")
    .innerJoin("share_links as l", "l.id", "v.link_id")
    .select(["v.id", "v.target_user_id", "v.ended_at", "l.status"])
    .where("v.id", "=", sessionId)
    .executeTakeFirst();
  if (!s || s.ended_at || s.status !== "active") throw new Error("This view has ended.");
  const expires = new Date(Date.now() + VIEW_MINUTES * 60_000);
  await meta.updateTable("share_view_sessions").set({ expires_at: expires }).where("id", "=", s.id).execute();
  return { token: await signShareView(s.target_user_id, s.id, expires), expires_at: expires.toISOString() };
}

/** End a grant early (Exit). */
export async function endShareView(sessionId: string): Promise<void> {
  await meta.updateTable("share_view_sessions").set({ ended_at: new Date() }).where("id", "=", sessionId).where("ended_at", "is", null).execute();
}

/** When each of these share-side links was last looked through, and by whom. */
export async function lastViews(linkIds: string[]): Promise<Map<string, { at: Date; by: string | null }>> {
  if (!linkIds.length) return new Map();
  const rows = await meta
    .selectFrom("share_view_sessions")
    .select(["link_id", "created_at", "viewer_name"])
    .where("link_id", "in", linkIds)
    .orderBy("created_at", "desc")
    .execute();
  const out = new Map<string, { at: Date; by: string | null }>();
  for (const r of rows) if (!out.has(r.link_id)) out.set(r.link_id, { at: r.created_at, by: r.viewer_name });
  return out;
}
