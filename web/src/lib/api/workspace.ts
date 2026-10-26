import type { OrgMembership } from "./members";
import { filed, request, upload } from "./client";
import type { ShareEditItem } from "./sharing";
import type { ScanMenuEntry } from "./scan";

export interface ShareAdditionItem {
  id: string;
  entity_kind: string;
  title: string;
  by_name: string | null;
  status: "pending" | "taken" | "left";
  created_at: string;
}

export interface OrgLocalRow {
  key: string;
  value: unknown;
  updated_at: string;
}

export interface OrgLocalResponse {
  org: { id: string; name: string; slug: string };
  role: OrgMembership["role"];
  rows: OrgLocalRow[];
}

/** One line of the ending's list, and what happened to it here. */
export interface CarryLine {
  group: "bundles" | "modules" | "instances" | "fields" | "automations" | "contents" | "homes";
  words: string;
  state: "done" | "skipped" | "partly";
  note?: string;
}
export interface CarryResult {
  workspace: { name: string };
  lines: CarryLine[];
  done: number;
  skipped: number;
  partly: number;
}

/** What installing a bundle changed. See api/src/lib/bundle-install-summary.ts. */
export interface BundleInstallSummary {
  bundle: string;
  /** `skin` creates no table and no nav entry - the fact users most need told. */
  kind: "instance" | "skin";
  instance: string | null;
  /** This install found the table already there rather than creating it
   *  (#2919). Absent from an older api: read as created. */
  instance_existed?: boolean;
  module: string | null;
  fields: number;
  wires: number;
  catalogs: number;
  modules_enabled: string[];
  kinds_touched: string[];
}

export interface QuickstartMaterializeResult {
  created: number;
  module: string | null;
  instance: string | null;
  label?: string;
  /** Route under /w/:slug to land the user in the new, populated table. */
  route: string | null;
  /** Present when this call actually installed something. */
  installed?: BundleInstallSummary;
  errors?: Array<{ id: string; status: number }>;
}

export interface QueueJob {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
  created_at: string;
}

/** One row of the dashboard's "needs you" feed (api/src/routes/attention.ts). */
export interface AttentionFeedItem {
  suggestion?: { id: string; candidate: import("@cobblr/platform-contract").TidyCandidate };
  kind: "tidy" | "low_stock" | "overdue" | "due_today" | "upcoming" | "pending_scans" | "photo_wanted" | "unreadable_date" | "suggested_edits";
  label: string;
  count: number;
  sample: string[];
  route: string;
  entries?: Array<{
    id: string;
    title: string;
    action?: Record<string, string>;
    record?: { kind: string; id: string; name: string };
    when?: string;
  }>;
  /** The collection a dated row belongs to: its overdue, today and coming-up
   *  rows share it, and the dashboard shows them as one card. */
  collection?: {
    key: string;
    label: string;
    route: string;
    due: "goes-off" | "window" | "deadline";
    /** The verbs that settle a due entry, as the collection's actions declare. */
    finish?: Array<{ action_id: string; label: string; finishes: "used" | "discarded" | "still-good" }>;
  };
  /** Every record the row counts, for an action on all of them. */
  all_ids?: string[];
}

export const workspaceApi = {
  workspaceCurrency: (slug: string) => request<{ currency: string }>("GET", `/orgs/${slug}/currency`),
  setWorkspaceCurrency: (slug: string, currency: string) => request<{ currency: string }>("PUT", `/orgs/${slug}/currency`, { currency }),
  /** `headers`: a record's save carries editOf's (#7925). */
  request: <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(method, path, body, headers),
  // Feedback: any authed user submits; super-admin lists / triages.
  /** Environment facts for a public bug report. See api/src/routes/diagnostics.ts
   *  for what is deliberately absent — this payload becomes public. */
  diagnostics: (slug: string) =>
    request<{
      build_sha: string | null;
      version: string | null;
      hosted: boolean;
      node: string;
      platform: string;
      postgres: string;
      modules: string[];
    }>("GET", `/orgs/${slug}/diagnostics`),
  orgLocal: (slug: string) => request<OrgLocalResponse>("GET", `/orgs/${slug}/local`),
  listOrgs: () => request<{ items: OrgMembership[] }>("GET", "/orgs"),
  /** Bring a backup file in (the .zip a backup or a sandbox's email gave). */
  restoreBackupFile: async (slug: string, file: File, opts: { replace?: boolean } = {}) => {
    const form = new FormData();
    form.set("file", file);
    if (opts.replace) form.set("confirm", "replace");
    return upload<{ restored?: { rows: number; files: number } }>(`/api/v1/orgs/${slug}/backup/restore`, form, file);
  },
  /** Bring a backup in from a link another Cobblr made (a sandbox's file). */
  restoreFromLink: (slug: string, url: string, opts: { replace?: boolean } = {}) =>
    request<{ restored: { rows: number; files: number }; name: string | null }>("POST", `/orgs/${slug}/backup/restore-from-link`, {
      url,
      ...(opts.replace ? { confirm: "replace" } : {}),
    }),
  createOrg: (name: string, opts?: { blueprint?: unknown }) =>
    request<{ org: OrgMembership; slug: string; blueprint_applied?: { name: string } }>("POST", "/orgs", {
      name,
      ...(opts?.blueprint !== undefined ? { blueprint: opts.blueprint } : {}),
    }),
  /** Owner-only rename. `name` = display name (safe). `slug` = the URL handle
   *  (risky — breaks existing links). Returns the new name + slug. */
  renameOrg: (slug: string, body: { name?: string; slug?: string }) =>
    request<{ name: string; slug: string }>("PATCH", `/orgs/${slug}`, body),
  tidySuggestions: (slug: string) => request<{ available: boolean; enabled: boolean; items: Array<{ id: string; candidate: import("@cobblr/platform-contract").TidyCandidate }> }>("GET", `/orgs/${slug}/tidy-suggestions`),
  setTidySuggestions: (slug: string, enabled: boolean) => request<{ enabled: boolean }>("PATCH", `/orgs/${slug}/tidy-suggestions`, { enabled }),
  decideTidySuggestion: (slug: string, id: string, decision: "later" | "never" | "done") => request<{ ok: boolean }>("POST", `/orgs/${slug}/tidy-suggestions/${id}/decision`, { decision }),

  // Notifications — cross-workspace inbox for the header bell.
  // core-queue admin: list jobs for the workspace.
  listQueueJobs: (
    slug: string,
    opts: { limit?: number; status?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.status) qs.set("status", opts.status);
    return request<{ items: QueueJob[] }>(
      "GET",
      `/orgs/${slug}/queue/jobs${qs.toString() ? `?${qs}` : ""}`,
    );
  },
  // Read / write a server-scoped live control's state through its declared
  // org-relative endpoint (e.g. "/modules/labels/autoflush").
  liveState: (slug: string, endpoint: string) =>
    request<Record<string, unknown>>("GET", `/orgs/${slug}${endpoint}`),
  liveSet: (slug: string, endpoint: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>("PUT", `/orgs/${slug}${endpoint}`, body),

  // ─── core-healthcheck ─────────────────────────────────────────────
  healthSnapshot: (slug: string) =>
    request<{
      status: "ok" | "degraded" | "error";
      probes: Record<string, { status: string; message?: string; detail?: unknown }>;
    }>("GET", `/orgs/${slug}/modules/core-healthcheck/snapshot`),
  /** Edits suggested through shares, waiting for a decision: the whole
   *  workspace's, or one record's (all: decided ones too). */
  listSuggestions: (slug: string, q: { kind?: string; id?: string; all?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.kind && q.id) {
      p.set("kind", q.kind);
      p.set("id", q.id);
    }
    if (q.all) p.set("all", "1");
    const qs = p.toString();
    return request<{ items: ShareEditItem[]; additions: ShareAdditionItem[] }>("GET", `/orgs/${slug}/suggestions${qs ? `?${qs}` : ""}`);
  },
  /** Replay the trial into a workspace, as the signed-in person. */
  carryInto: (slug: string, from: string, token: string) =>
    request<CarryResult>("POST", `/orgs/${slug}/carry`, { from, token }),

  /** What kind of workspace this is, for the strip at the foot of the page.
   *  `link_open` is true while a kept sandbox's owner has no real door yet
   *  (no password chosen, emailed link unused): the strip then offers both. */
  workspaceTrial: (slug: string) =>
    request<{
      kind: "sandbox" | "trial" | "none";
      expires_at: string | null;
      email: string | null;
      link_open: boolean;
      /** Set when an owner asked for the workspace to be deleted: the day it goes. */
      deletion_due_at?: string | null;
    }>("GET", `/orgs/${slug}/trial`),

  /** Owner only: delete this workspace after the grace period. `confirmName`
   *  is the workspace's name, typed. Resolves to the day it goes. */
  /** Finish a workspace whose database was never made (#5146). Any member. */
  finishWorkspaceSetup: (slug: string) => request<{ finished: boolean; already: boolean }>("POST", `/orgs/${slug}/finish-setup`, {}),

  scheduleWorkspaceDeletion: (slug: string, confirmName: string) =>
    request<{ deletion_due_at: string }>("POST", `/orgs/${slug}/deletion`, { confirm_name: confirmName }),

  /** Owner only: keep a workspace that was set to be deleted. */
  keepWorkspace: (slug: string) => request<void>("DELETE", `/orgs/${slug}/deletion`),
  /** File every pending line of a receipt at once. `into` names one instance
   *  for all of them (the grocery app's "all of this goes in the pantry");
   *  absent, each line goes to its own best match. */
  // Install a flagship bundle + batch-commit the captures that fit it.
  materializeQuickstart: (
    slug: string,
    bundle_external_id: string,
    opts?: { item_ids?: string[]; skip_install?: boolean },
  ) =>
    filed(
      slug,
      request<QuickstartMaterializeResult>("POST", `/orgs/${slug}/quickstart/materialize`, {
        bundle_external_id,
        ...(opts?.item_ids ? { item_ids: opts.item_ids } : {}),
        ...(opts?.skip_install ? { skip_install: true } : {}),
      }),
    ),
  // Not-yet-installed flagship bundles as scan destinations (carries each
  // bundle's field DEFS + `bundle_external_id`) — so the confirm form can offer
  // "Vehicles (installs on confirm)" with its real, editable fields.
  scanBundleMenu: (slug: string) =>
    request<{ items: Array<ScanMenuEntry & { bundle_external_id?: string }> }>(
      "GET",
      `/orgs/${slug}/quickstart/bundle-menu`,
    ),
  // Would an AI call work right now (kill-switch → personal connection →
  // workspace/managed provider → entitlement)? Member-accessible, so
  // AI-consuming UI can warn about the degraded no-AI experience up front.
  /** The dashboard "what needs me" feed (attention.ts) — derived from field
   *  semantics: low stock, overdue/upcoming dates, pending captures. */
  getAttention: (slug: string, today?: string) =>
    request<{ items: AttentionFeedItem[] }>(
      "GET",
      // The client's calendar day, so "overdue" and "due today" are read the
      // way the schedule beside the feed reads them, not by the server clock.
      `/orgs/${slug}/attention${today ? `?today=${today}` : ""}`,
    ),
};
