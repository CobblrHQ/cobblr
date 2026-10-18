import type { ScopeDef, VisibilityDef } from "@cobblr/platform-contract/share-scope";
import type { AppTheme } from "./bundles";
import { request } from "./client";

/** Something someone you share with added to the shared workspace. */
/** A public page and its links. */
export interface PublicPageItem {
  id: string;
  name: string;
  layout: "gallery" | "table";
  scope: ScopeDef;
  visibility: VisibilityDef;
  /** A signed-out scan of its records' labels opens their public view. */
  label_door?: boolean;
  /** Booth mode: private again on its own at this time. */
  public_until?: string | null;
  contact?: string | null;
  footer?: boolean;
  /** The fields a record shows, in order; null: all the visibility allows. */
  show_fields?: string[] | null;
  about?: string | null;
  /** Addresses shown with every record ("Store"). */
  out_links?: Array<{ label: string; url: string }>;
  skin_html?: string | null;
  /** Search engines may list it; off by default. */
  indexable?: boolean;
  /** Its own accent over the workspace brand. */
  accent?: string | null;
  /** Its memorable address (/p/<workspace>/<address>); null: none. */
  address?: string | null;
  label_scans_today?: number;
  label_scans_week?: number;
  links: Array<{ id: string; label: string; url: string; named?: boolean; visibility: VisibilityDef; own_visibility: boolean; expires_at: string | null; enabled: boolean; visits: number; created_at: string }>;
}

export interface PortalConfig {
  display_name?: string;
  logo_path?: string | null;
  theme?: "light" | "dark" | "auto";
  pinned_views: string[];
  welcome_markdown?: string;
  /** App slug a member lands in directly (the portal becomes a fallback). */
  default_app?: string | null;
  /** Override skin for the portal launcher. Unset → inherit the
   *  workspace's default-app / sole-app theme (resolved in PortalLayout). */
  theme_tokens?: AppTheme | null;
  /** Brand theme for the admin dashboard shell (chrome: page bg + accent
   *  + logo, keeps the Cobblr mark). See AppLayout. */
  admin_theme?: AppTheme | null;
}

export interface SurfaceRecord {
  id: string;
  name: string;
  token: string;
  scope_type: "view" | "entity" | "collection" | "board" | "app";
  scope_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  public_url: string;
}

export interface SurfaceStats {
  views_total: number;
  views_24h: number;
  views_7d: number;
  views_30d: number;
  first_viewed: string | null;
  last_viewed: string | null;
  recent: Array<{
    viewed_at: string;
    referer: string | null;
    ua_hint: string | null;
  }>;
}

export const publicSurfacesApi = {

  // ─── core-public-surfaces ─────────────────────────────────────────
  listSurfaces: (slug: string) =>
    request<{ items: SurfaceRecord[] }>(
      "GET",
      `/orgs/${slug}/modules/core-public-surfaces/surfaces`,
    ),
  createSurface: (
    slug: string,
    body: {
      name: string;
      scope_type: "view" | "entity" | "collection" | "board" | "app";
      scope_id: string;
      config?: Record<string, unknown>;
      expires_at?: string | null;
    },
  ) =>
    request<SurfaceRecord>(
      "POST",
      `/orgs/${slug}/modules/core-public-surfaces/surfaces`,
      body,
    ),
  updateSurface: (
    slug: string,
    id: string,
    body: {
      name?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
      expires_at?: string | null;
    },
  ) =>
    request<SurfaceRecord>(
      "PATCH",
      `/orgs/${slug}/modules/core-public-surfaces/surfaces/${id}`,
      body,
    ),
  revokeSurface: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-public-surfaces/surfaces/${id}`,
    ),
  surfaceStats: (slug: string, id: string) =>
    request<SurfaceStats>(
      "GET",
      `/orgs/${slug}/modules/core-public-surfaces/surfaces/${id}/stats`,
    ),
  /** Public pages: a scope and a visibility, seen through any number of links. */
  listPublicPages: (slug: string) => request<{ items: PublicPageItem[] }>("GET", `/orgs/${slug}/modules/core-public-surfaces/pages`),
  createPublicPage: (slug: string, body: { name: string }) => request<{ id: string; name: string }>("POST", `/orgs/${slug}/modules/core-public-surfaces/pages`, body),
  updatePublicPage: (
    slug: string,
    id: string,
    body: {
      name?: string;
      scope?: ScopeDef;
      visibility?: VisibilityDef;
      layout?: "gallery" | "table";
      label_door?: boolean;
      public_until?: string | null;
      contact?: string | null;
      footer?: boolean;
      show_fields?: string[] | null;
      about?: string | null;
      links?: Array<{ label: string; url: string }>;
      skin_html?: string | null;
      indexable?: boolean;
      accent?: string | null;
      address?: string | null;
    },
  ) =>
    request<{ id: string }>("PATCH", `/orgs/${slug}/modules/core-public-surfaces/pages/${id}`, body),
  recordPublicPages: (slug: string, id: string) =>
    request<{ pages: Array<{ name: string; public_until: string | null; label_door: boolean; links: number }> }>("GET", `/orgs/${slug}/public-status/${encodeURIComponent(id)}`),
  publicPageFields: (slug: string, id: string) => request<{ fields: Array<{ name: string; label: string }> }>("GET", `/orgs/${slug}/public-page-fields/${id}`),
  deletePublicPage: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/modules/core-public-surfaces/pages/${id}`),
  createPublicLink: (slug: string, pageId: string, body: { label: string; visibility?: VisibilityDef; expires_at?: string | null }) =>
    request<{ id: string; url: string }>("POST", `/orgs/${slug}/modules/core-public-surfaces/pages/${pageId}/links`, body),
  revokePublicLink: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/modules/core-public-surfaces/surfaces/${id}`),
  regeneratePublicLink: (slug: string, id: string) => request<{ token: string }>("POST", `/orgs/${slug}/modules/core-public-surfaces/surfaces/${id}/regenerate`, {}),

  // Member portal — config (branding + pinned views) + per-action
  // capability grants. See docs/modules/member-portal-and-
  // permissions.md.
  getPortalConfig: (slug: string) =>
    request<{ config: PortalConfig; org_name: string }>(
      "GET",
      `/orgs/${slug}/portal-config`,
    ),
  updatePortalConfig: (slug: string, body: PortalConfig) =>
    request<{ config: PortalConfig }>(
      "PUT",
      `/orgs/${slug}/portal-config`,
      body,
    ),
};
