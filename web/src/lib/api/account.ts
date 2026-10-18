import type { CommunityLinkId } from "@cobblr/platform-contract/community-links";
import type { TitleFormat } from "@cobblr/platform-contract/display-identity";
import type { TipState } from "@cobblr/platform-web";
import type { OrgMembership } from "./members";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import type { TokenAccess } from "@cobblr/platform-contract/token-access";
import { ApiError, browserTimeZone, getToken, request, setToken } from "./client";
import type { SignupInvite } from "./admin";

export interface CommunityLink {
  id: CommunityLinkId;
  label: string;
  url: string;
  blurb: string;
}

// ─────────────────────────── public api ──────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  /** A name to sign in with beside the email, or null (#6910). */
  username?: string | null;
  /** False for an account made with only a username: its address is a placeholder nothing is sent to. */
  has_email?: boolean;
  display_name: string;
  /** Per-user theme preference — follows you across devices + workspaces.
   *  null/absent = follow the device/OS. */
  theme_pref?: "light" | "dark" | null;
  /** Desktop nav layout, follows you across devices. null/absent = this device's
   *  own default stands. Phones ignore it (the sidebar is `hidden md:block`). */
  nav_pref?: { mode: "top" | "side"; autohide: boolean; topbar: boolean } | null;
  /** How a title that has an original, a translation and a transliteration
   *  reads for this person. null/absent = the platform default. */
  title_pref?: TitleFormat | null;
  /** When the guided tour was completed or skipped. null = never, absent = the
   *  account has not loaded yet. Account-level so a new device, a different
   *  origin and a new workspace all agree. */
  tour_seen_at?: string | null;
  /** The IANA zone this account last reported from a browser; absent when the response did not carry it. */
  time_zone?: string | null;
  /** Tips this person has been shown and dismissed (users.tips); absent = not loaded. */
  tips?: TipState;
  /** True when an admin minted this account with a temp password. UI
   *  renders the set-a-password screen in place of every route until
   *  cleared (a gate, not a URL). PATCH /me/password clears it. */
  must_reset_password: boolean;
  /** True once the user confirmed their email via a verification link.
   *  Informational — the app shows a "verify your email" banner while false.
   *  Optional for back-compat with cached responses; treat undefined as true
   *  (don't nag a session that predates the field). */
  email_verified?: boolean;
  /** False when no email can reach anyone from this install (no sender
   *  configured), so verification is impossible and is never asked for. */
  can_verify_email?: boolean;
  /** True when this user's email is in the platform's
   *  SUPERADMIN_EMAILS env var. Unlocks the /super-admin/* shell. */
  is_platform_admin?: boolean;
  /** The community Discord invite (DISCORD_INVITE_URL), or null when unset.
   *  Signed-in only; rendered in the account menu + feedback modal. */
  discord_invite_url?: string | null;
  /** Every place this deployment offers for questions. Older servers do not
   *  send it, hence optional; the widget falls back to discord_invite_url. */
  community_links?: CommunityLink[];
}

export interface MeResponse {
  user: SessionUser;
  orgs: OrgMembership[];
  /** Set while this tab is a View as through a share: who is looking, until when. */
  share_view?: { viewer_name: string | null; expires_at: string; slug: string } | null;
}

export interface WorkspaceLinkItem {
  id: string;
  kinds: string[];
  status: "pending" | "active" | "revoked";
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  min_target_role: OrgRoleName | null;
  source_org_id: string;
  source_org_name: string;
  source_org_slug: string;
  target_org_id: string;
  target_org_name: string;
  target_org_slug: string;
  source_role: string | null;
  target_role: string | null;
}

export interface ApiTokenListItem {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** Capability scopes; null = unrestricted (full access). */
  scopes: string[] | null;
  /** look | change | full; null = a token from before access levels (full). */
  access?: TokenAccess | null;
  /** The one workspace it may reach; null = every workspace. */
  org_id?: string | null;
  org_name?: string | null;
  org_slug?: string | null;
}

export const accountApi = {
  // Mint an API token (plaintext returned ONCE). Used by the edge-bridge setup to
  // generate a least-privilege devices:edge token in-flow, and by the API Recipes
  // auto-scoper (records:* scopes + source/meta provenance) — no trip to the tokens page.
  createApiToken: (body: {
    name: string;
    scopes?: string[];
    expires_at?: string;
    source?: string;
    meta?: Record<string, unknown>;
    /** The one workspace it may reach (id or slug); omit for every workspace. */
    workspace?: string;
    access?: TokenAccess;
  }) =>
    request<{ id: string; name: string; token: string; token_prefix: string }>("POST", "/me/api-tokens", body),
  // Any workspace OWNER: invite a friend to Cobblr who gets their OWN
  // workspace (distinct from a workspace-member invite). Reuses the
  // signup-invite machinery, attributed to the caller.
  mintMySignupInvite: (body: { email?: string; note?: string; expires_in_days?: number; from_workspace?: string }) =>
    request<SignupInvite & { token: string; emailed: boolean }>("POST", "/me/signup-invites", body),
  listMySignupInvites: () =>
    request<{ items: SignupInvite[] }>("GET", "/me/signup-invites"),
  revokeMySignupInvite: (id: string) =>
    request<void>("POST", `/me/signup-invites/${id}/revoke`),
  /** The person's linked sign-ins. */
  myOidc: () => request<{ items: Array<{ slug: string; display_name: string; linked: boolean; email: string | null; last_used_at: string | null }> }>("GET", "/me/oidc"),
  /** Start linking a provider to this account: the URL to send the browser to. */
  linkOidc: (slug: string) => request<{ url: string }>("POST", `/me/oidc/${encodeURIComponent(slug)}/link`, {}),
  unlinkOidc: (slug: string) => request<{ ok: true }>("DELETE", `/me/oidc/${encodeURIComponent(slug)}`),
  // Email verification (consume link; resend for the signed-in user).
  /** The sign-in address, a change waiting for its link, and whether the
   *  address is managed by the central account service instead. */
  myEmail: () =>
    request<{ email: string; pending: { email: string; expires_at: string } | null; managed_by_identity: boolean; has_password?: boolean }>("GET", "/me/email"),
  /** Ask to change the sign-in address: a link goes to the new one. An
   *  account with no password sends none and is proven by a recent sign-in. */
  requestEmailChange: (body: { new_email: string; current_password?: string }) =>
    request<{ pending: string; expires_at: string; emailed: boolean }>("POST", "/me/email", body),
  resendVerification: () =>
    request<{ ok: boolean; emailed?: boolean; already_verified?: boolean; dev_link?: string }>(
      "POST",
      "/me/verify-email/resend",
    ),
  me: () => request<MeResponse>("GET", "/me"),
  /** Persist the signed-in user's switcher order (drag-to-reorder). `slugs` is
   *  the user's workspaces in the desired order. */
  reorderWorkspaces: (slugs: string[]) =>
    request<{ ok: boolean; order: string[] }>("PATCH", "/me/workspaces/order", { slugs }),
  /** Pin (or clear, slug=null) the workspace a fresh device opens into. */
  setDefaultWorkspace: (slug: string | null) =>
    request<{ ok: boolean; default_slug: string | null }>("PATCH", "/me/default-workspace", { slug }),
  /** Persist the per-user theme preference (follows you across devices +
   *  workspaces). null = follow the device/OS. */
  setThemePref: (theme_pref: "light" | "dark" | null) =>
    request<{ user: { theme_pref: "light" | "dark" | null } }>("PATCH", "/me", { theme_pref }),
  /** Persist how a title with variants reads for this person. null = the
   *  platform default. */
  setTitlePref: (title_pref: TitleFormat | null) =>
    request<{ user: { title_pref: TitleFormat | null } }>("PATCH", "/me", { title_pref }),
  /** Persist the per-user desktop nav layout (follows you across devices). */
  setNavPref: (nav_pref: { mode: "top" | "side"; autohide: boolean; topbar: boolean } | null) =>
    request<{ user: { nav_pref: unknown } }>("PATCH", "/me", { nav_pref }),
  /** Remember that this person has seen the tour, on the ACCOUNT — localStorage
   *  alone forgets on a new device, a different origin and a cleared cache. */
  /** A tip was shown to this person (the account keeps the first time). */
  tipShown: (id: string) =>
    request<{ tips: TipState }>("POST", `/me/tips/${encodeURIComponent(id)}/shown`, {}),
  /** This person dismissed a tip: final, on every device. */
  tipDismissed: (id: string) =>
    request<{ tips: TipState }>("POST", `/me/tips/${encodeURIComponent(id)}/dismissed`, {}),
  /** Tell the engine where this person is, when this browser says otherwise than the account:
   *  "today" on what it dates for them is then their day. Null when the browser names no zone. */
  syncTimeZone: (known: string | null) => {
    const tz = browserTimeZone();
    return tz && tz !== known ? request<{ user: { time_zone: string | null } }>("PATCH", "/me", { time_zone: tz }) : Promise.resolve(null);
  },
  setTourSeen: (tour_seen: boolean) =>
    request<{ user: { tour_seen_at: string | null } }>("PATCH", "/me", { tour_seen }),

  // Long-lived API tokens
  listApiTokens: () =>
    request<{ items: ApiTokenListItem[] }>("GET", "/me/api-tokens"),
  apiTokenScopes: () =>
    request<{ items: { key: string; label: string; description: string; offered_in: "personal" | "operator" | "elsewhere"; elsewhere?: string }[] }>(
      "GET",
      "/me/api-token-scopes",
    ),
  mintApiToken: (body: { name: string; expires_at?: string; scopes?: string[]; workspace?: string; access?: TokenAccess }) =>
    request<{
      id: string;
      name: string;
      token_prefix: string;
      expires_at: string | null;
      created_at: string;
      scopes: string[] | null;
      token: string;
    }>("POST", "/me/api-tokens", body),
  revokeApiToken: (id: string) =>
    request<void>("DELETE", `/me/api-tokens/${id}`),

  // /me/profile (display_name + password change).
  updateMe: (body: { display_name?: string; username?: string | null }) =>
    request<{ user: SessionUser }>("PATCH", "/me", body),
  // Changing the password revokes all prior tokens server-side; the response
  // carries a freshly-minted one for THIS session, which we persist so the
  // user stays logged in on this device.
  changeMyPassword: async (body: { current_password: string; new_password: string }) => {
    const res = await request<{ token: string }>("POST", "/me/password", body);
    if (res?.token) setToken(res.token);
    return res;
  },
  // Sign out of every other device without changing the password. Revokes all
  // prior tokens server-side and returns a fresh one for THIS device, which we
  // persist so the current session survives.
  // Every other device's push subscription goes too; this browser's own
  // (keepPushEndpoint) stays on (#7124).
  signOutEverywhere: async (keepPushEndpoint?: string | null) => {
    const res = await request<{ token: string }>("POST", "/me/sign-out-everywhere", keepPushEndpoint ? { keep_push_endpoint: keepPushEndpoint } : {});
    if (res?.token) setToken(res.token);
    return res;
  },
  /** Delete this account. Refused (409 sole_owner, with the workspaces) while
   *  the person is the only owner of a live workspace; 409 delete_at_identity
   *  for an account that belongs to the central account service. */
  /** "Download my data" (#4185): ask for a copy, list them, fetch one. */
  requestMyData: () => request<{ id: string; status: "building" }>("POST", "/me/export", {}),
  myDataExports: () =>
    request<{ items: Array<{ id: string; status: "building" | "ready" | "failed"; created_at: string; ready_at: string | null; expires_at: string; size_bytes: number | null }>; days: number }>("GET", "/me/export"),
  downloadMyData: async (id: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`/api/v1/me/export/${encodeURIComponent(id)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, "not_found", "That copy is not here. Ask for a new one.");
    return res.blob();
  },
  deleteMyAccount: (currentPassword: string) =>
    request<void>("DELETE", "/me", { current_password: currentPassword }),

  // ─── Communication Preferences matrix (Feature 1) ─────────────────
  /** Keeping photos of things you file (#3769 step 3). `available` is false
   *  until the updated terms ship; then `keep` is the account's choice. */
  mePhotoConsent: () =>
    request<{ available: boolean; keep: boolean; accepted_at: string | null; declined_at: string | null }>("GET", "/me/photo-consent"),
  setMePhotoConsent: (keep: boolean) =>
    request<{ available: boolean; keep: boolean; accepted_at: string | null; declined_at: string | null; unlinked: boolean }>("PUT", "/me/photo-consent", { keep }),
  listWorkspaceLinks: () =>
    request<{ items: WorkspaceLinkItem[] }>("GET", "/me/links"),
  createWorkspaceLink: (body: {
    source_org_id: string;
    target_org_id: string;
    kinds: string[];
    expires_at?: string | null;
    min_target_role?: OrgRoleName | null;
  }) => request<WorkspaceLinkItem>("POST", "/me/links", body),
  acceptWorkspaceLink: (id: string) =>
    request<WorkspaceLinkItem>("POST", `/me/links/${id}/accept`),
  revokeWorkspaceLink: (id: string) =>
    request<void>("POST", `/me/links/${id}/revoke`),
  patchWorkspaceLink: (
    id: string,
    body: {
      expires_at?: string | null;
      min_target_role?: OrgRoleName | null;
    },
  ) => request<WorkspaceLinkItem>("PATCH", `/me/links/${id}`, body),

  /** The backups kept after workspaces this person owned were deleted. */
  myWorkspaceExports: () =>
    request<{
      items: Array<{ id: string; workspace: string; filename: string; size_bytes: number; created_at: string; expires_at: string }>;
    }>("GET", "/me/workspace-exports"),

  getMyCapabilities: (slug: string) =>
    request<{ role: string; all: boolean; grants: string[] }>(
      "GET",
      `/orgs/${slug}/me/capabilities`,
    ),
};
