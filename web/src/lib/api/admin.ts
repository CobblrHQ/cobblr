import type { InvitableOrgRole } from "@cobblr/platform-contract/org-roles";
import type { AiActivityDetail, AiActivityItem } from "./ai";
import { request } from "./client";

/** One cohort of the activation funnel (see docs/operations/product-metrics.md). */
export interface ActivationFunnel {
  signups: number;
  first_item: number;
  first_item_24h: number;
  first_scan: number;
  week2_eligible: number;
  returned_week2: number;
}

export interface ChangelogEntry {
  type: "feature" | "improvement" | "fix" | "selfhost" | "change";
  scope: string | null;
  text: string;
}
export interface ChangelogDay {
  date: string;
  entries: ChangelogEntry[];
}

/** A group at the provider that gives a role in one workspace (#4492). */
export interface OidcGroupRole {
  group: string;
  org_slug: string;
  role: InvitableOrgRole;
  lower?: boolean;
}
export interface OidcProviderInput {
  slug: string;
  display_name: string;
  issuer: string;
  client_id: string;
  /** Write-only: never comes back. Omitted on a save, unchanged. */
  client_secret?: string;
  scopes?: string;
  email_claim?: string;
  groups_claim?: string;
  allow_signup?: boolean;
  signup_groups?: string[];
  group_roles?: OidcGroupRole[];
  allow_http?: boolean;
  enabled?: boolean;
}
export interface OidcProvider extends Required<Omit<OidcProviderInput, "client_secret">> {
  id: string;
  has_secret: boolean;
  from_env: boolean;
}
export interface SignInSettings {
  providers: OidcProvider[];
  password_signin: boolean;
  admins_signed_in_through_a_provider: number;
  redirect_uri: string;
}

export interface SignupInvite {
  id: string;
  invited_email: string | null;
  note: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  consumed_by_email?: string | null;
  status: "open" | "consumed" | "expired" | "revoked";
}

export interface WaitlistEntry {
  id: string;
  email: string;
  source: string;
  signed_up_at: string | null;
  status: "pending" | "invited" | "dismissed";
  decided_at: string | null;
  created_at: string;
  decided_by_email?: string | null;
  invite_status?: "open" | "consumed" | "expired" | "revoked" | null;
}

export interface ScanUrlResolverRow {
  resolver_id: string;
  label: string;
  enabled: boolean;
  position: number;
  manifest: unknown;
  builtin: boolean;
}

export interface ScanUrlResolution {
  source: string;
  name: string;
  brand: string | null;
  category: string | null;
  entityType: string | null;
  fields: Record<string, unknown>;
  imageUrl?: string | null;
}

export interface FeedbackItem {
  id: string;
  type: string;
  message: string;
  context: Record<string, unknown>;
  status: string;
  admin_notes: string | null;
  // Where it came from + how to reply. 'discord' tickets have no user_email/name
  // — the reporter is origin_ref.username, and replies go to the thread.
  origin: "in-app" | "discord";
  origin_ref: { channel_id: string; thread_id: string; username?: string } | null;
  // Reporter follow-up replies in the ticket thread (conversational tickets).
  followups: Array<{ at: string; from: string; text: string; images?: Array<{ url: string; name?: string }> }>;
  // Reporter-attached screenshots (refs into their workspace core-files).
  attachments: Array<{ file_id: string; name?: string; content_type?: string }>;
  // AI triage verdict (null until the analyzer judges it).
  triage_priority: "urgent" | "high" | "medium" | "low" | null;
  triage_valid: boolean | null;
  triage_viable: boolean | null;
  triage_summary: string | null;
  triage_action: string | null;
  triaged_at: string | null;
  triage_model: string | null;
  created_at: string;
  updated_at: string;
  user_email: string | null;
  user_name: string | null;
  workspace_slug: string | null;
  workspace_name: string | null;
}

export interface AnnounceSetting {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  webhook_url: string | null;
  default_channel_set: boolean;
  composable: boolean;
}

export interface Healthz {
  ok: boolean;
  service: string;
  env: string;
  time: string;
}

/** A captured matchmaker eval case (P2). The expected answer = the admin's
 *  corrected scan commit; mirrors the e2e fixture's `expect` shape. */
export interface ScanEvalCase {
  id: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  inbox_item_id: string | null;
  surface: string;
  perceived_input: { name?: string; manufacturer?: string | null; category?: string | null; barcode?: string | null } & Record<string, unknown>;
  scan_menu: unknown[];
  candidates: unknown[];
  expected: { route: { module: string; instance: string | null }; fields: Record<string, unknown>; name?: string };
  note: string | null;
  created_at: string;
}

export interface SuperAdminWorkspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
  member_count: number;
  last_activity_at: string | null;
  owner: { id: string; email: string; display_name: string } | null;
}

export interface SuperAdminUser {
  id: string;
  email: string;
  display_name: string;
  active: boolean;
  must_reset_password: boolean;
  created_at: string;
  last_login_at: string | null;
  orgs: Array<{ org_id: string; org_name: string; org_slug: string; role: string }>;
}

export interface SuperAdminModuleRow {
  module_name: string;
  workspace_count: number;
  workspaces: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    version: string;
    last_migration: string | null;
  }>;
}

export interface SuperAdminActivityRow {
  id: string;
  action: string;
  module_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  diff: unknown;
  occurred_at: string;
  auth_method: string;
  org_name: string | null;
  org_slug: string | null;
  user_email: string | null;
  user_display_name: string | null;
}
export interface SuperAdminAiActivityItem extends AiActivityItem {
  org_id: string;
  org_name: string;
  org_slug: string;
  user_email: string | null;
  user_name: string | null;
}

/** One row of a workspace's per-UPC barcode-lookup cache (operator viewer). */
export interface SuperAdminBarcodeCacheItem {
  upc: string;
  found: boolean;
  source: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: unknown;
  fetched_at: string;
  /** Shared-layer misses carry a TTL (re-checked later); null = permanent. */
  expires_at?: string | null;
  /** Null in the instance-wide (shared-layer) view — it's deduped across workspaces. */
  org_id: string | null;
  org_name: string | null;
  org_slug: string | null;
}

export const adminApi = {
  /** A one-shot URL for an iframe document that must run inline script (a
   *  custom app block, an installed renderer). The browser then applies the
   *  RESPONSE's policy instead of this page's, which is what lets script-src
   *  be enforced here at all (#3300). See lib/frame-doc.ts. */
  createFrameDoc: (html: string, kind: "app-block" | "renderer") =>
    request<{ url: string; expires_in: number }>("POST", `/frame-docs`, { html, kind }),
  healthz: () => request<Healthz>("GET", "/healthz"),
  changelog: () => request<{ sections: ChangelogDay[] }>("GET", "/changelog"),
  // Superadmin: mint / list / revoke signup invites.
  mintSignupInvite: (body: { email?: string; note?: string; expires_in_days?: number }) =>
    request<SignupInvite & { token: string; emailed: boolean }>("POST", "/super-admin/signup-invites", body),
  listSignupInvites: () =>
    request<{ items: SignupInvite[] }>("GET", "/super-admin/signup-invites"),
  revokeSignupInvite: (id: string) =>
    request<void>("POST", `/super-admin/signup-invites/${id}/revoke`),
  // Superadmin: vendor scan-URL resolvers — the global list (built-in + operator).
  scanResolvers: () =>
    request<{ items: ScanUrlResolverRow[] }>("GET", "/super-admin/scan-url-resolvers"),
  saveScanResolver: (manifest: unknown, position?: number) =>
    request<{ ok: true }>("POST", "/super-admin/scan-url-resolvers", { manifest, position }),
  patchScanResolver: (id: string, body: { enabled?: boolean; label?: string; manifest?: unknown }) =>
    request<{ ok: true }>("PATCH", `/super-admin/scan-url-resolvers/${encodeURIComponent(id)}`, body),
  deleteScanResolver: (id: string) =>
    request<void>("DELETE", `/super-admin/scan-url-resolvers/${encodeURIComponent(id)}`),
  testScanResolver: (url: string) =>
    request<{ matched: boolean; resolution: ScanUrlResolution | null }>(
      "POST",
      "/super-admin/scan-url-resolvers/test",
      { url },
    ),
  // Superadmin: marketing-site waitlist — list, approve (mints an invite), dismiss.
  listWaitlist: () => request<{ items: WaitlistEntry[] }>("GET", "/super-admin/waitlist"),
  approveWaitlist: (id: string, body?: { note?: string; expires_in_days?: number }) =>
    request<{ id: string; status: "invited"; invite: { token: string; invited_email: string | null; expires_at: string | null; emailed: boolean } }>(
      "POST",
      `/super-admin/waitlist/${id}/approve`,
      body ?? {},
    ),
  dismissWaitlist: (id: string) => request<void>("POST", `/super-admin/waitlist/${id}/dismiss`),
  // Raw URL for a feedback screenshot (super-admin only). Goes through useImageSrc
  // (Bearer → blob) like other authed images.
  feedbackAttachmentRawUrl: (feedbackId: string, fileId: string, variant?: "thumb" | "medium") =>
    `/api/v1/super-admin/feedback/${feedbackId}/attachments/${fileId}/raw${variant ? `?variant=${variant}` : ""}`,
  listFeedback: (status?: string, sort?: "priority" | "recent") => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (sort === "priority") qs.set("sort", "priority");
    const q = qs.toString();
    return request<{ items: FeedbackItem[] }>(
      "GET",
      `/super-admin/feedback${q ? `?${q}` : ""}`,
    );
  },
  /** Post the Discord card of a feedback item that has none. 409 when it has
   *  one, or when Discord is off for new feedback. */
  postFeedbackToDiscord: (id: string) =>
    request<{ ok: boolean; announce_message_id: string | null }>("POST", `/super-admin/feedback/${id}/announce`),
  listAnnounceSettings: () =>
    request<{ items: AnnounceSetting[] }>("GET", "/super-admin/announce-settings"),
  setAnnounceSetting: (
    category: string,
    body: { enabled?: boolean; webhook_url?: string | null },
  ) =>
    request<{ ok: boolean }>(
      "PATCH",
      `/super-admin/announce-settings/${encodeURIComponent(category)}`,
      body,
    ),
  postAnnouncement: (body: { category: string; title: string; body?: string }) =>
    request<{ ok: boolean }>("POST", "/super-admin/announce", body),
  updateFeedback: (
    id: string,
    body: {
      status?: string;
      admin_notes?: string | null;
      notify_reporter?: boolean;
      reply_message?: string;
      public_summary?: string;
    },
  ) =>
    request<{ id: string; status: string; admin_notes: string | null; updated_at: string; notified?: boolean; emailed?: boolean }>(
      "PATCH",
      `/super-admin/feedback/${id}`,
      body,
    ),
  /** Super admin → Sign-in. */
  signInSettings: () => request<SignInSettings>("GET", "/super-admin/sign-in"),
  createOidcProvider: (body: OidcProviderInput) => request<OidcProvider>("POST", "/super-admin/sign-in/providers", body),
  updateOidcProvider: (id: string, body: Partial<OidcProviderInput>) => request<OidcProvider>("PATCH", `/super-admin/sign-in/providers/${id}`, body),
  deleteOidcProvider: (id: string) => request<{ ok: true }>("DELETE", `/super-admin/sign-in/providers/${id}`),
  testOidcProvider: (id: string) =>
    request<{ ok: true; issuer: string; scopes: string[]; claims: string[]; end_session: boolean } | { ok: false; message: string }>("POST", `/super-admin/sign-in/providers/${id}/test`, {}),
  setPasswordSignIn: (on: boolean) => request<{ password_signin: boolean }>("PUT", "/super-admin/sign-in/password", { on }),

  provisionDemo: (body: { email: string; name: string; expiresInDays: number; unlock: string[]; blueprint?: unknown }) =>
    request<{ slug: string }>("POST", "/super-admin/demos", body),
  sendAccountNotice: (body: { org_ids: string[]; user_ids: string[]; subject: string; message: string; link_url?: string }) =>
    request<{ recipients: number; emailed: number }>("POST", "/super-admin/notices", body),
  resolveFeedbackBatch: (body: { items: Array<{ id: string; public_summary: string }>; reply_message: string; notify_reporter: boolean }) =>
    request<{ resolved: string[]; missing: string[]; notified_reporters: number }>("POST", "/super-admin/feedback/batch-resolve", body),
  // Super-admin: captured matchmaker eval cases (P2 of the eval harness).
  listScanEvalCases: () =>
    request<{ items: ScanEvalCase[] }>("GET", "/super-admin/scan-eval-cases"),
  deleteScanEvalCase: (orgId: string, id: string) =>
    request<void>("DELETE", `/super-admin/scan-eval-cases/${orgId}/${id}`),
  // Super-admin: cross-workspace AI log.
  superAdminAiActivity: (q: { capability?: string; org?: string; user?: string; source?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.capability) qs.set("capability", q.capability);
    if (q.org) qs.set("org", q.org);
    if (q.user) qs.set("user", q.user);
    if (q.source) qs.set("source", q.source);
    if (q.limit) qs.set("limit", String(q.limit));
    return request<{ items: SuperAdminAiActivityItem[] }>("GET", `/super-admin/ai-activity?${qs.toString()}`);
  },
  superAdminAiActivityDetail: (orgId: string, id: string) =>
    request<AiActivityDetail & SuperAdminAiActivityItem & { error: string | null; org: { id: string; name: string; slug: string } }>(
      "GET",
      `/super-admin/ai-activity/${orgId}/${id}`,
    ),
  // Super-admin: cross-workspace barcode-lookup cache (read-only viewer).
  superAdminBarcodeCache: (q: { q?: string; org?: string; source?: string; found?: boolean; limit?: number; layer?: "shared" | "workspaces" } = {}) => {
    const qs = new URLSearchParams();
    if (q.q) qs.set("q", q.q);
    if (q.org) qs.set("org", q.org);
    if (q.source) qs.set("source", q.source);
    if (q.found !== undefined) qs.set("found", String(q.found));
    if (q.limit) qs.set("limit", String(q.limit));
    if (q.layer === "shared") qs.set("layer", "shared");
    return request<{ items: SuperAdminBarcodeCacheItem[] }>("GET", `/super-admin/barcode-cache?${qs.toString()}`);
  },

  // Super-admin (platform operator) — gated by SUPERADMIN_EMAILS.
  // The web shell renders /super-admin/* only when user.is_platform_admin.
  /** The thesis dashboard (audit F2): per workspace, walls-hit 7d/30d by event
   *  + time-to-first-working-app. Operator only. */
  /** Sign-ups per source ("carry" for a sandbox brought in) per day, and who
   *  (routes/super-admin.ts GET /signups). */
  superAdminSignups: (days = 30) =>
    request<{
      since: string;
      days: number;
      totals: Array<{ source: string; count: number }>;
      by_day: Array<{ day: string; source: string; count: number }>;
      accounts?: Array<{ at: string; email: string | null; workspace: string | null; via: string | null; source: string; carried_origin: string | null }>;
    }>("GET", `/super-admin/signups?days=${days}`),
  superAdminProductMetrics: () =>
    request<{
      now: string;
      /** The activation funnel per cohort (founder / sandbox / test-pool
       *  workspaces excluded): signups → first item → first scan → back in
       *  week two. `week2_eligible` is the denominator for `returned_week2`. */
      activation: Record<"d30" | "d90" | "all", ActivationFunnel>;
      workspaces: Array<{
        org_id: string;
        name: string;
        slug: string;
        created_at: string;
        app_mode: string | null;
        first_item_at: string | null;
        ttfw_minutes: number | null;
        first_scan_at: string | null;
        active_days: number;
        last_active_day: string | null;
        returned_week2: boolean | null;
        founder: boolean;
        sandbox: boolean;
        test_pool: boolean;
        counts: boolean;
        walls: Array<{ event: string; d7: number; d30: number }>;
        walls_7d: number;
        walls_30d: number;
      }>;
    }>("GET", "/super-admin/product-metrics"),
  superAdminOverview: () =>
    request<{
      orgs_count: number;
      users_count: number;
      active_users_7d: number;
      activity_24h: number;
      capability_grants: number;
      bundles_installed: number;
      feedback_open: number;
      waitlist_pending: number;
      barcode_cache_upcs: number;
      build_sha: string | null;
    }>("GET", `/super-admin/overview`),
  superAdminDeleteWorkspace: (id: string) =>
    request<void>("DELETE", `/super-admin/workspaces/${id}`),
  /** Operator: delete an account. `deleteWorkspaces` takes the workspaces the
   *  person solely owns along; without it a sole owner is 409 sole_owner. */
  superAdminDeleteUser: (id: string, deleteWorkspaces: boolean) =>
    request<{ mode: "deleted" | "tombstoned"; workspaces_deleted: string[] }>(
      "DELETE",
      `/super-admin/users/${id}${deleteWorkspaces ? "?delete_workspaces=1" : ""}`,
    ),
  superAdminSetWorkspacePlan: (id: string, plan: "free" | "paid" | "disabled") =>
    request<{ id: string; slug: string; plan: string }>("PATCH", `/super-admin/workspaces/${id}`, { plan }),
  superAdminAiSummary: () =>
    request<{ calls_24h: number; cost_cents_24h: number }>("GET", `/super-admin/ai-summary`),
  superAdminInstanceConfig: () =>
    request<{
      node_env: string;
      build_sha: string | null;
      public_signup: boolean;
      self_serve_invites: boolean;
      ai_enabled: boolean;
      sandbox_registry_configured: boolean;
      barcode_resolver_configured: boolean;
      operator_contact_configured: boolean;
      bidb: "off" | "configured" | "url without key";
    }>("GET", `/super-admin/instance-config`),
  superAdminResolverStats: () =>
    request<{
      cached_upcs: number;
      hits: number;
      upcitemdb_today: { date: string; used: number; budget: number; blocked_until: number | null };
    }>("GET", `/super-admin/barcode-resolver-stats`),
  // Proposed barcode corrections awaiting review (the public approval queue).
  superAdminBarcodeCorrections: () =>
    request<{
      items: Array<{
        id: string;
        upc: string;
        field: string;
        proposed_value: unknown;
        reason: string | null;
        source_context: string | null;
        corrected_by: string | null;
        created_at: string;
        current: { title: string | null; brand: string | null; category: string | null; provider_found: boolean };
      }>;
    }>("GET", `/super-admin/barcode-corrections`),
  superAdminVerifyBarcodeCorrection: (id: string) =>
    request<{ ok: boolean }>("POST", `/super-admin/barcode-corrections/${id}/verify`, {}),
  superAdminRejectBarcodeCorrection: (id: string) =>
    request<{ ok: boolean }>("POST", `/super-admin/barcode-corrections/${id}/reject`, {}),
  superAdminWorkspaces: () =>
    request<{ items: SuperAdminWorkspace[] }>(
      "GET",
      `/super-admin/workspaces`,
    ),
  superAdminUsers: () =>
    request<{ items: SuperAdminUser[] }>("GET", `/super-admin/users`),
  superAdminModules: () =>
    request<{ items: SuperAdminModuleRow[] }>("GET", `/super-admin/modules`),
  superAdminActivity: (params?: { limit?: number; org?: string; user?: string; action?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.org) qs.set("org", params.org);
    if (params?.user) qs.set("user", params.user);
    if (params?.action) qs.set("action", params.action);
    const tail = qs.toString() ? `?${qs}` : "";
    return request<{ items: SuperAdminActivityRow[] }>(
      "GET",
      `/super-admin/activity${tail}`,
    );
  },
  superAdminHealth: () =>
    request<{
      db: { ok: boolean; latency_ms: number };
      activity_1h: number;
      backup: { ok: boolean | null; note: string };
      timestamp: string;
    }>("GET", `/super-admin/health`),

  // Per-(workspace, module) invocation telemetry. Process-lifetime
  // counts; latency percentiles use a rolling ring of ~200 recent
  // samples so they reflect current behaviour.
  superAdminSandboxTelemetry: () =>
    request<{
      rows: Array<{
        org_id: string;
        name: string;
        slug: string;
        module_name: string;
        invocations: number;
        errors: number;
        error_rate: number;
        p50_ms: number;
        p95_ms: number;
        recent_samples: number;
      }>;
    }>("GET", `/super-admin/sandbox-telemetry`),

  // Per-workspace + per-module sandbox CPU usage in the current
  // accounting window. `pct` is used_ms / quota_ms_per_window so
  // 1.0+ means the workspace is at or over its budget.
  // What each route costs this deployment since the api started (#5424): wall time, CPU (`cpu_ms` from
  // requests that ran alone, `cpu_ms_overlapped` an upper bound from the rest), memory growth and calls
  // per workspace per day. The heaviest by total CPU first.
  superAdminComputeStats: (limit = 60) =>
    request<{
      since: string;
      uptime_s: number;
      routes_seen: number;
      cpu_total_ms: number;
      cpu_estimated_ms: number;
      rows: Array<{
        route: string;
        calls: number;
        errors_5xx: number;
        wall_ms: { p50: number; p95: number; max: number; samples: number };
        cpu_ms: { p50: number; p95: number; max: number; samples: number };
        cpu_ms_overlapped: { p50: number; p95: number; max: number; samples: number };
        cpu_share: number | null;
        cpu_estimated_ms: number | null;
        held_open: boolean;
        rss_growth_max_mb: number;
        per_workspace_day: { workspaces: number; p50: number; p95: number; max: number };
      }>;
    }>("GET", `/super-admin/compute-stats?limit=${limit}`),

  superAdminSandboxCpu: () =>
    request<{
      window_ms: number;
      quota_ms_per_window: number;
      workspaces: Array<{
        org_id: string;
        name: string;
        slug: string;
        used_ms: number;
        samples: number;
        pct: number;
        by_module: Record<string, number>;
      }>;
    }>("GET", `/super-admin/sandbox-cpu`),
};
