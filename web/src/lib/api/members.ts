import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { request } from "./client";

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: OrgRoleName;
  /** A guest's only: what the workspace's portal shares, so a guest's page
   *  asks only for reads the server answers (#5992). */
  portal_shares?: import("@cobblr/platform-contract/guest-reads").PortalShares | null;
  /** When the workspace was made. Absent from an older server. */
  created_at?: string;
  /** "share": a workspace someone shared with you (Settings → Sharing). */
  kind?: "workspace" | "share";
  /** Display name of the workspace's owner — for the switcher's "Owner: …" on
   *  workspaces you don't own. Null if unresolved. */
  owner_name?: string | null;
  /** Set when this workspace is a managed vertical app ("Cobblr for Yarn") —
   *  the shell hides ALL platform chrome and lands the user in `home_path`.
   *  Null/absent = a normal platform workspace. */
  app_mode?: { app: string; home_path: string; label?: string } | null;
  /** "Focused mode" — the owner has hidden the platform BUILDER chrome
   *  (marketplace / add-modules / AI builder / Configuration / "+ New thing")
   *  to see a finished app, not a toolkit. Softer than app_mode: the workspace
   *  stays navigable and any owner/admin flips it back (the upsell). */
  focused?: boolean;
  /** Per-user switcher order (0-based). The orgs list arrives already sorted by
   *  it; drag-to-reorder persists via reorderWorkspaces. */
  position?: number;
  /** Per-user default workspace — a fresh device opens into it. */
  is_default?: boolean;
}

/** True when the active workspace is a managed single-purpose app — the shell
 *  must hide the marketplace, bundles, modules, wires, fields, Configuration,
 *  and the workspace switcher, and land the user in `app_mode.home_path`. */
export function isAppMode(org: OrgMembership | null | undefined): org is OrgMembership & { app_mode: { app: string; home_path: string; label?: string } } {
  return !!org?.app_mode;
}

/** True when the active workspace is in FOCUSED mode — the shell hides the
 *  builder chrome (marketplace, AI builder, "add modules", Configuration, the
 *  "+ New thing" funnel) but keeps the workspace navigable. app_mode takes
 *  precedence: a managed app is already locked tighter, so `focused` only
 *  applies to a normal platform workspace. */
export function isFocused(org: OrgMembership | null | undefined): boolean {
  return !!org?.focused && !org?.app_mode;
}

/** Owner/admin: flip focused mode on/off for a workspace. */
export const setFocused = (slug: string, focused: boolean) =>
  request<{ focused: boolean }>("PATCH", `/orgs/${slug}/focused`, { focused });

export interface PermissionsMember {
  id: string;
  email: string;
  display_name: string;
  role: OrgRoleName;
  grants: string[];
  /** Custom-role assignments — array of workspace_roles.id values. */
  custom_role_ids: string[];
}

export interface GrantableAction {
  action_id: string;
  label: string;
  description: string;
  /** Owning module — groups the capability rows in the permissions matrix. */
  module: string;
}

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  capabilities: string[];
  member_count: number;
}

export interface WorkspaceMember {
  user_id: string;
  email: string;
  display_name: string;
  role: OrgMembership["role"];
  joined_at: string;
}

export interface WorkspaceInvite {
  id: string;
  org_id: string;
  invited_by_user: string;
  token: string;
  invited_email: string | null;
  role: OrgMembership["role"];
  expires_at: string | null;
  consumed_at: string | null;
  consumed_by_user: string | null;
  revoked_at: string | null;
  created_at: string;
  /** A join link: anyone with it may join, counted rather than consumed. */
  reusable?: boolean;
  max_uses?: number | null;
  use_count?: number;
  /** Item labels offer this join link to someone who scans one signed out. */
  offer_on_labels?: boolean;
  pace_limit?: number | null;
  pace_period?: "day" | "week" | "month" | "year" | null;
  /** Set while the link is paused for going past its pace. */
  paused_at?: string | null;
  /** Who joined through a join link, newest first. */
  joined?: Array<{ user_id: string; name: string; used_at: string }>;
}

export const membersApi = {
  listMembers: (slug: string) =>
    request<{ items: WorkspaceMember[]; self: { user_id: string; role: OrgMembership["role"] } }>(
      "GET",
      `/orgs/${slug}/members`,
    ),
  updateMemberRole: (slug: string, userId: string, role: OrgMembership["role"]) =>
    request<WorkspaceMember>("PATCH", `/orgs/${slug}/members/${userId}`, { role }),
  /** `handTo`: a People-list entry who gets what the leaving member owns. */
  removeMember: (slug: string, userId: string, handTo?: string) =>
    request<{ moved: number; kept: Array<{ kind: string; id: string; title: string }> } | void>(
      "DELETE",
      `/orgs/${slug}/members/${userId}${handTo ? `?hand_to=${encodeURIComponent(handTo)}` : ""}`,
    ),
  /** Turn a paused join link back on. */
  resumeJoinLink: (slug: string, id: string) => request<WorkspaceInvite>("POST", `/orgs/${slug}/members/invites/${id}/resume`),
  /** A new code for a join link: the old QR stops working. */
  rotateJoinLink: (slug: string, id: string) => request<WorkspaceInvite>("POST", `/orgs/${slug}/members/invites/${id}/rotate`),
  listInvites: (slug: string, includeAll = false) =>
    request<{ items: WorkspaceInvite[] }>(
      "GET",
      `/orgs/${slug}/members/invites${includeAll ? "?include=all" : ""}`,
    ),
  createInvite: (
    slug: string,
    body: {
      email?: string;
      role: OrgMembership["role"];
      expires_at?: string;
      reusable?: boolean;
      max_uses?: number;
      offer_on_labels?: boolean;
      /** Joins allowed per period before the link pauses; null for none. */
      pace?: { limit: number; period: "day" | "week" | "month" | "year" } | null;
    },
  ) =>
    // `emailed` says whether a mail actually went out — false when the
    // instance has no mail sender, which is the default for a self-hosted one.
    // The toast used to claim "sent to <address>" either way.
    request<WorkspaceInvite & { emailed: boolean }>(
      "POST",
      `/orgs/${slug}/members/invites`,
      body,
    ),
  revokeInvite: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/members/invites/${id}`),
  listPermissionMatrix: (slug: string) =>
    request<{ members: PermissionsMember[] }>(
      "GET",
      `/orgs/${slug}/permissions`,
    ),
  grantCapability: (slug: string, user_id: string, action_id: string) =>
    request<unknown>("POST", `/orgs/${slug}/permissions/grants`, {
      user_id,
      action_id,
    }),
  revokeCapability: (slug: string, user_id: string, action_id: string) =>
    request<void>("DELETE", `/orgs/${slug}/permissions/grants`, {
      user_id,
      action_id,
    }),
  listGrantableActions: (slug: string) =>
    request<{ items: GrantableAction[] }>(
      "GET",
      `/orgs/${slug}/permissions/grantable-actions`,
    ),

  // Admin-creates-user — see api/src/routes/admin-users.ts. Returns
  // the temp password ONCE; the UI has to capture it now or call
  // regen later.
  adminCreateUser: (
    slug: string,
    body: { email?: string; username?: string; display_name: string; role: OrgRoleName },
  ) =>
    request<{
      user: { id: string; email: string | null; username?: string | null; display_name: string; role: string; must_reset_password: boolean };
      temp_password: string;
      instructions: string;
    }>("POST", `/orgs/${slug}/admin/users`, body),
  /** A QR that signs this member's phone in as them (#6692): single use, ten minutes. */
  adminPhoneCode: (slug: string, user_id: string) =>
    request<{ code: string; expires_at: string; claim_url: string; claim_options: { label: string; url: string }[]; for: string }>(
      "POST",
      `/orgs/${slug}/admin/users/pair-code`,
      { user_id },
    ),
  adminCancelPhoneCode: (slug: string, user_id: string) =>
    request<{ revoked: number }>("POST", `/orgs/${slug}/admin/users/pair-code/revoke`, { user_id }),
  adminRegenPassword: (slug: string, user_id: string) =>
    request<{ temp_password: string; instructions: string }>(
      "POST",
      `/orgs/${slug}/admin/users/regen-password`,
      { user_id },
    ),

  // Custom roles (S2): workspace-defined named bundles of
  // capabilities. See member-portal-and-permissions.md §7.
  listCustomRoles: (slug: string) =>
    request<{ items: CustomRole[] }>("GET", `/orgs/${slug}/roles`),
  createCustomRole: (
    slug: string,
    body: { name: string; description?: string; capabilities?: string[] },
  ) =>
    request<{ role: { id: string }; capabilities: string[] }>(
      "POST",
      `/orgs/${slug}/roles`,
      body,
    ),
  updateCustomRole: (
    slug: string,
    id: string,
    body: { name?: string; description?: string | null; capabilities?: string[] },
  ) => request<void>("PATCH", `/orgs/${slug}/roles/${id}`, body),
  deleteCustomRole: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/roles/${id}`),
  assignCustomRole: (slug: string, user_id: string, role_id: string) =>
    request<void>("POST", `/orgs/${slug}/role-assignments`, { user_id, role_id }),
  unassignCustomRole: (slug: string, user_id: string, role_id: string) =>
    request<void>("DELETE", `/orgs/${slug}/role-assignments`, { user_id, role_id }),
};
