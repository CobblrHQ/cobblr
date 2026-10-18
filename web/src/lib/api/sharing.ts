import { request } from "./client";
import type { ScopeDef, VisibilityDef } from "@cobblr/platform-contract/share-scope";

export interface ShareOfferItem {
  send_file?: {id: string;transport: "file-export" | "file-import";state: string;can_download: boolean;can_undo: boolean;connected?: boolean;can_remote_undo?: boolean;can_restore?: boolean};
  id: string;
  direction: "out" | "in";
  title: string;
  status: "offered" | "maybe" | "taken" | "passed" | "withdrawn" | "returned";
  peer_name: string | null;
  created_at: string;
  taken_at: string | null;
  can_withdraw: boolean;
  can_send_back: boolean;
  can_undo?: boolean;
  send_mode?: "copy" | "move";
}

export interface ShareLinkItem {
  id: string;
  side: "owner" | "share";
  status: "pending" | "active" | "revoked";
  label: string | null;
  peer_name: string | null;
  peer_workspace_name: string | null;
  /** The other Cobblr's host; null when it is this one. */
  peer_host: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  invite_expires_at: string | null;
  waiting: number;
  /** The friend's edits waiting for this workspace to decide. */
  edits_waiting?: number;
  /** In a share space: when the person who shared it last looked through
   *  it with View as. */
  last_viewed?: { at: string; by: string | null } | null;
  edit_mode?: ShareEditMode;
  /** A pending invite's address, when it was made for one. */
  invite_email?: string | null;
  /** The collections a pending invite reaches. */
  invite_kinds?: string[];
  created_at: string;
}

/** An invite just made: its link, and what happened to its email. */
export interface ShareInviteMade {
  id: string;
  invite_url: string;
  expires_at: string;
  links?: Array<{ label: string; origin: string; url: string; note: string | null }>;
  email?: string | null;
  mail?: "sent" | "no_mail" | "rate_limited" | "failed" | null;
  /** The sentence to show: "Invited sam@…: email sent." */
  said?: string;
}

/** Whether a friend's edits apply at once ("direct") or wait ("suggest"). */
export type ShareEditMode = "suggest" | "direct";

export interface ShareEditItem {
  id: string;
  entity_kind: string;
  entity_id: string;
  title: string | null;
  field: string;
  label: string;
  was: string | null;
  now: string | null;
  /** On a conflict: what the record says here now. */
  yours: string | null;
  /** False once the record left the share; the edit still waits. */
  still_shared: boolean;
  link_id: string;
  status: "pending" | "conflict" | "applied" | "undone" | "accepted" | "rejected";
  by_name: string | null;
  created_at: string;
}

export const sharingApi = {

  // ─── M1 cross-workspace links ─────────────────────────────────────
  /** This workspace's shares (Settings → Sharing). `kind` is "share" in a
   *  share space, where the one link is to whoever shared it. */
  listShareLinks: (slug: string) => request<{ items: ShareLinkItem[]; kind: "workspace" | "share" }>("GET", `/orgs/${slug}/share-links`),
  /** Invite someone new: with an email the invite is bound to it and, when
   *  this Cobblr has mail, sent there; `where` is the place their Cobblr is. */
  createShareLink: (slug: string, p: { email?: string; where?: number; collection?: { kind: string; ids?: string[] } }) =>
    request<ShareInviteMade>("POST", `/orgs/${slug}/share-links`, p),
  /** Where an invite can open, and whether this Cobblr can email one. */
  shareDestinations: (slug: string) => request<{ destinations: Array<{ label: string; note: string | null }>; can_email: boolean }>("GET", `/orgs/${slug}/share-links/destinations`),
  syncShareLink: (slug: string, id: string) => request<{ sent: number; error: string | null; waiting: number }>("POST", `/orgs/${slug}/share-links/${id}/sync`, {}),
  revokeShareLink: (slug: string, id: string) => request<{ ok: true }>("POST", `/orgs/${slug}/share-links/${id}/revoke`, {}),
  connectCobblr: (slug: string, where?: number) => request<{id: string;invite_url: string}>("POST", `/orgs/${slug}/share-links`, {purpose: "own", where}),
  revokeOwnConnection: (slug: string, id: string) => request("POST", `/orgs/${slug}/share-links/${id}/revoke`, {}),
  listShareOffers: (slug: string) => request<{ items: ShareOfferItem[]; targets: Array<{ link_id: string; to: string }> }>("GET", `/orgs/${slug}/share-offers`),
  /** The shares of this workspace's own things, and which hold this record. */
  recordShares: (slug: string, kind?: string, id?: string) =>
    request<{ can_share?: boolean; targets: Array<{ link_id: string; to: string }>; shared_with: Array<{ link_id: string; to: string }> }>(
      "GET",
      kind ? `/orgs/${slug}/record-shares?kind=${encodeURIComponent(kind)}${id ? `&id=${encodeURIComponent(id)}` : ""}` : `/orgs/${slug}/record-shares`,
    ),
  withdrawShareOffer: (slug: string, id: string) => request<{ ok: true }>("POST", `/orgs/${slug}/share-offers/${id}/withdraw`, {}),
  sendBackShareOffer: (slug: string, id: string) => request<{ ok: true }>("POST", `/orgs/${slug}/share-offers/${id}/send-back`, {}),
  /** How many records a scope selects, and the first few: the scope editor's
   *  live count. Shares and public pages read the same scope. */
  previewScope: (slug: string, scope: ScopeDef, linkId?: string) =>
    request<{ count: number; complete: boolean; sample: Array<{ entity_kind: string; id: string; title: string }> }>("POST", `/orgs/${slug}/scope-preview`, { scope, ...(linkId ? { link_id: linkId } : {}) }),
  getShareWhat: (slug: string, id: string) =>
    request<{ scope: ScopeDef; visibility: VisibilityDef; edit_mode: ShareEditMode; person: { id: string; name: string } | null; gated_fields: Array<{ name: string; label: string }> }>("GET", `/orgs/${slug}/share-links/${id}/what`),
  putShareWhat: (slug: string, id: string, body: { scope: ScopeDef; visibility: VisibilityDef; edit_mode: ShareEditMode }) =>
    request<{ scope: ScopeDef; visibility: VisibilityDef; edit_mode: ShareEditMode; preview: { count: number } }>("PUT", `/orgs/${slug}/share-links/${id}/what`, body),
  /** On a copy in a share space: what the owner changed since you edited it. */
  copyNotes: (slug: string, kind: string, id: string) =>
    request<{ from: string | null; notes: Array<{ field: string; label: string; theirs: string | null }> }>("GET", `/orgs/${slug}/copy-notes?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`),
  /** The fields gated to a permission, for a scope editor's restricted list. */
  scopeFields: (slug: string) => request<{ gated_fields: Array<{ name: string; label: string }> }>("GET", `/orgs/${slug}/scope-fields`),
  /** The fields a public page's records can show, to choose from. */
  receivedFrom: (slug: string, kind: string, id: string) =>
    request<{ received: { offer_id: string; from: string | null; until: string } | null }>("GET", `/orgs/${slug}/received-from?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`),
  /** A read-only view of the share space as the other person sees it: where
   *  to open it (a new tab). */
  viewShareAs: (slug: string, id: string) => request<{ url: string; expires_at: string }>("POST", `/orgs/${slug}/share-links/${id}/view-as`, {}),
  endShareView: () => request<{ ok: true }>("POST", "/share-view/end", {}),
  renewShareView: () => request<{ token: string; expires_at: string }>("POST", "/share-view/renew", {}),
  /** The friend's edits on a share: waiting first, then applied. */
  listShareEdits: (slug: string, id: string) => request<{ items: ShareEditItem[] }>("GET", `/orgs/${slug}/share-links/${id}/edits`),
  decideShareEdit: (slug: string, id: string, editId: string, decision: "accept" | "reject" | "undo") =>
    request<{ status: ShareEditItem["status"] }>("POST", `/orgs/${slug}/share-links/${id}/edits/${editId}/${decision}`),
  /** Who an invite is from, asked of the Cobblr that made it. */
  previewShareInvite: (invite: string) =>
    request<{ owner_name: string | null; workspace_name: string; for_email?: string | null; from_host: string | null; purpose?: "own" }>("POST", "/share-links/preview", { invite }),
  /** Accept an invite on this Cobblr: makes the share space, returns its slug. */
  acceptShareInvite: (invite: string, target_org?: string) => request<{ org_id: string; slug: string }>("POST", "/share-links/accept", { invite, target_org }),
};
