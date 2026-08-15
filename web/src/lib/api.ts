// Thin fetch wrapper. Reads the auth token from localStorage on every
// call so the AuthProvider can update it without rewiring the client.
// Everything goes through `request<T>` so error shape stays uniform.

import { getImpersonationToken } from "./impersonation";
import type { ResolveOutcome as RegistryResolveOutcome } from "@cobblr/platform-contract/resolvables";
import type { LiveControlPublic, FieldRole, FieldDefType } from "@cobblr/platform-contract";

const TOKEN_KEY = "cobblr.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Fetch a binary endpoint with auth → an object URL (for <img>). Caller must
 *  revokeObjectURL when done. Returns null on any error. */
export async function fetchAuthBlobUrl(path: string): Promise<string | null> {
  try {
    const token = getToken();
    const res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

// ── Connectivity signal ──────────────────────────────────────────────────
// One app-wide "can we reach the API?" flag. request() flips it: a fetch
// rejection (offline / server unreachable) or a gateway 5xx (502/503/504 =
// api/proxy down) marks us DOWN; any real HTTP response — even a 4xx — proves
// connectivity and clears it. <ConnectivityBanner> subscribes so a service
// outage shows one calm "reconnecting…" bar instead of raw per-request errors.
type ConnListener = (down: boolean) => void;
const connListeners = new Set<ConnListener>();
let apiDown = false;
function setApiDown(down: boolean): void {
  if (down === apiDown) return;
  apiDown = down;
  connListeners.forEach((l) => l(down));
}
export function subscribeConnectivity(listener: ConnListener): () => void {
  connListeners.add(listener);
  listener(apiDown);
  return () => {
    connListeners.delete(listener);
  };
}
/** Liveness ping the banner polls while down, so it auto-clears on recovery
 *  even when the user is idle (no in-flight request to flip the flag). */
export async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/healthz`, { cache: "no-store" });
    setApiDown(res.status >= 502 && res.status <= 504);
    return res.ok;
  } catch {
    setApiDown(true);
    return false;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Operator impersonation: the grant rides alongside the operator's own Bearer.
  // withTenant resolves the tenant as the target member + enforces read-only.
  const impToken = getImpersonationToken();
  if (impToken) headers["X-Impersonation"] = impToken;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch only rejects on a network-level failure (offline, server
    // unreachable, DNS) — raise the app-wide "down" banner + a clear error.
    setApiDown(true);
    throw new ApiError(0, "network_error", "Can't reach Cobblr. Check your connection and try again.");
  }
  // A gateway 5xx = proxy up but api/web down; any other response (even a 4xx)
  // proves connectivity and clears the banner.
  setApiDown(res.status >= 502 && res.status <= 504);

  // Always try to parse JSON — our error responses are always JSON.
  // 204 is no-content; some 201s also send empty bodies (e.g.
  // /role-assignments). Treat any successful empty body as void.
  if (res.status === 204) return undefined as T;
  const contentLength = res.headers.get("content-length");
  if (res.ok && contentLength === "0") return undefined as T;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    // Empty-body success → treat as void rather than failing. Some
    // POST endpoints return 201 with no body (no content-length set
    // because the server didn't write one).
    if (res.ok) return undefined as T;
    throw new ApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
  }

  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      res.status,
      err?.code ?? "unknown",
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  return parsed as T;
}

export interface ChangelogEntry {
  type: "feature" | "improvement" | "fix" | "change";
  scope: string | null;
  text: string;
}
export interface ChangelogDay {
  date: string;
  entries: ChangelogEntry[];
}

// ─────────────────────────── public api ──────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  /** Per-user theme preference — follows you across devices + workspaces.
   *  null/absent = follow the device/OS. */
  theme_pref?: "light" | "dark" | null;
  /** Desktop nav layout, follows you across devices. null/absent = this device's
   *  own default stands. Phones ignore it (the sidebar is `hidden md:block`). */
  nav_pref?: { mode: "top" | "side"; autohide: boolean; topbar: boolean } | null;
  /** True when an admin minted this account with a temp password. UI
   *  redirects to /me/force-password-reset until cleared. PATCH
   *  /me/password clears it. */
  must_reset_password: boolean;
  /** True once the user confirmed their email via a verification link.
   *  Informational — the app shows a "verify your email" banner while false.
   *  Optional for back-compat with cached responses; treat undefined as true
   *  (don't nag a session that predates the field). */
  email_verified?: boolean;
  /** True when this user's email is in the platform's
   *  SUPERADMIN_EMAILS env var. Unlocks the /super-admin/* shell. */
  is_platform_admin?: boolean;
  /** The community Discord invite (DISCORD_INVITE_URL), or null when unset.
   *  Signed-in only; rendered in the account menu + feedback modal. */
  discord_invite_url?: string | null;
}

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "editor" | "member" | "guest";
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

/** A feedback item as the REPORTER sees it (no internal triage fields). */
export interface MyFeedbackItem {
  id: string;
  type: "bug" | "confusing" | "idea" | "other";
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
  followups: Array<{ at: string; from: string; text: string; role?: "user" | "team"; images?: Array<{ url: string; name?: string }> }>;
  attachments: Array<{ file_id: string; name?: string; content_type?: string }>;
  context: Record<string, unknown>;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
  orgs: OrgMembership[];
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

export interface MeResponse {
  user: SessionUser;
  orgs: OrgMembership[];
}

export interface Healthz {
  ok: boolean;
  service: string;
  env: string;
  time: string;
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

export interface Machine {
  id: string;
  name: string;
  short_name: string | null;
  family: string | null;
  type: string | null;
  manufacturer: string | null;
  serial_number: string | null;
  state: string;
  excitement: number;
  image_path: string | null;
  notes: string | null;
  quantity: number;
  location_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Vendor {
  id: string;
  name: string;
  website: string | null;
  account_number: string | null;
  contact: string | null;
  lead_time_days: number | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface VendorSummary extends Vendor {
  order_count: number;
  total_spend: number;
}

export interface VendorDetail extends Vendor {
  orders: Array<Pick<Order, "id" | "order_number" | "status" | "ordered_at" | "expected_arrival" | "arrived_at" | "total_cost">>;
  order_count: number;
  total_spend: number;
}

/** A driver package a workspace declares for its bridges. `bridgeId` null
 *  means every bridge; a value scopes it to one. */
export interface EdgeDriverDeclaration {
  kind: string;
  version: string;
  sha256: string;
  source: string;
  bridgeId?: string | null;
}

export interface Order {
  id: string;
  vendor: string | null;
  vendor_id: string | null;
  order_number: string | null;
  url: string | null;
  ordered_at: string | null;
  expected_arrival: string | null;
  arrived_at: string | null;
  status: "planned" | "ordered" | "in-transit" | "arrived" | "cancelled";
  total_cost: string | null;
  shipping_cost: string | null;
  tracking_number: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  /** Line-item count — present on the list endpoint (GET /orders), absent on detail. */
  item_count?: number;
  created_at: string;
  updated_at: string;
}

/** A tracking number's carrier, identified from the number's own format.
 *  `trackingUrl` is null where the carrier has no single public page to send
 *  someone to (an international postal format shared by many national posts). */
export interface ShipmentCarrier {
  code: string;
  name: string;
  number: string;
  trackingUrl: string | null;
}

/** Where to send someone to look at this parcel. Always present, even when no
 *  carrier was recognised — `isCarrier` says whether it is the carrier's own
 *  page or a universal resolver standing in. */
export interface TrackingLookup {
  url: string;
  via: string;
  isCarrier: boolean;
}

/** Cobblr's own coarse parcel states, not a carrier's codes. */
export type ShipmentState =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "unknown";

export interface ShipmentStatus {
  carrier: string;
  number: string;
  state: ShipmentState;
  /** The carrier's own wording, always more specific than `state`. */
  description: string;
  location: string | null;
  estimatedDelivery: string | null;
  deliveredAt: string | null;
  events: { at: string; description: string; location: string | null }[];
  checkedAt: string;
}

/** Why there is no status, when there is no status. Each value is a different
 *  thing for the user to do, so none of them may render as silence. */
export type ShipmentStatusReason =
  | "unrecognised"
  | "no_driver"
  | "not_connected"
  | "carrier_error"
  | "quota_exhausted";

export interface OrderItem {
  id: string;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: string;
  unit_cost: string | null;
  received_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Asset {
  id: string;
  name: string;
  short_name: string | null;
  manufacturer: string | null;
  model: string | null;
  type: string | null;
  state: string;
  excitement: number;
  quantity: number;
  serial_number: string | null;
  purchased_at: string | null;
  warranty_until: string | null;
  last_service_at: string | null;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  flags: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}


/** A row in the records module — the neutral generic-record substrate.
 *  Named RecordItem (not Record) to dodge TS's builtin Record type. */
export interface RecordItem {
  id: string;
  name: string;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One purchase of one part — a line item flattened with its order's date and
 *  vendor. Mirrors purchases' PricePoint. */
export interface PurchasePricePoint {
  id: string;
  order_id: string;
  order_number: string | null;
  vendor: string | null;
  purchased_at: string | null;
  description: string | null;
  qty: number;
  unit_cost: number | null;
}

export interface PurchasePriceStats {
  purchases: number;
  priced: number;
  latest: number | null;
  previous: number | null;
  change_abs: number | null;
  change_pct: number | null;
  direction: "up" | "down" | "flat" | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  first_purchased_at: string | null;
  last_purchased_at: string | null;
  total_spent: number | null;
}

export interface PurchasePriceHistory {
  part_id: string | null;
  items: PurchasePricePoint[];
  stats: PurchasePriceStats;
}

/** A manifest-declared UI contribution (contributes.panels) — a tab on the
 *  target module's list page, or a panel in the target kind's detail modal. */
export interface ContributedPanel {
  id: string;
  surface: "module-page-tab" | "entity-detail-panel";
  target: string;
  title: string;
}

export interface OrgModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
  /** Module layer: `stock` = Cobblr's shipped first-party domains, `core-*`
   *  plumbing is `foundational`, marketplace installs / user samples differ.
   *  Used to suggest only real domain modules on the empty dashboard.
   *  Optional: real modules from the API always carry it, but synthetic nav
   *  entries (instances, lens bundles) have no module band. */
  band?: "foundational" | "stock" | "marketplace" | "user";
  /** A user-facing nav entry this module declares even though the `core-*` /
   *  foundational rule would otherwise hide it from the navbar — a page you
   *  BROWSE (locations, files, tags, saved views). Replaces the two hardcoded
   *  synthetic entries useNavModules used to carry.
   *  See docs/design-decisions/configuration-revamp.md. */
  nav?: {
    label: string;
    route: string;
    icon?: string;
    /** Presentation-override key, when the rename should follow an entity kind
     *  rather than the module name. */
    overrideKey?: string;
  };
  /** Release maturity — the UI shows an Experimental/Beta badge for non-stable
   *  modules. Absent → treat as stable. ("hidden" modules never load, so they
   *  never reach this list — listed for type-completeness with the manifest.) */
  maturity?: "hidden" | "experimental" | "beta" | "stable";
  /** "multi" → the module can host several named instances (the "+ New thing"
   *  funnel offers it). "single" / absent → one instance only. */
  instanceability?: "single" | "multi";
  /** Non-empty → an operator/capability (labels, digifab): it acts ON other
   *  modules' things and is not itself a trackable kind, so the funnel's
   *  "track a kind of thing" column excludes it. */
  operates_on?: string[];
  /** UI panels this module contributes into ANOTHER module's pages —
   *  rendered through web/src/panels/registry.tsx by the target module's
   *  host page. Present only for modules that declare contributes.panels. */
  panels?: ContributedPanel[];
  /** Icon-only quick-action pinned to the navbar's right cluster. */
  headerAction: { icon: string; label: string; route: string } | null;
  dependencies: string[];
  contributes: { fieldDefs: number; wires: number };
  enabled: boolean;
  enabled_version: string | null;
  enabled_at: string | null;
}

export interface ModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
  intents: { name: string; description: string }[];
  exposes: { events: string[]; api: string[] };
  dependencies: string[];
}

/** Primary-entity base for a host module (machines/assets/purchases).
 *  Instance-scoped when an instance slug is given (the platform's
 *  /instances/:name/items dispatches to the module's primary router);
 *  the legacy module route otherwise. `moduleRoute` is "<module>/<entity>"
 *  e.g. "machines/machines", "purchases/orders". */
function primaryBase(slug: string, moduleRoute: string, instance?: string): string {
  return instance
    ? `/orgs/${slug}/instances/${instance}/items`
    : `/orgs/${slug}/modules/${moduleRoute}`;
}

export const api = {
  /** Escape hatch for ad-hoc reads from pages that don't deserve a
   *  dedicated method (e.g. dashboard snapshot widgets that hit a
   *  module's own routes). Avoid in module code — modules go through
   *  the platform contract. */
  request: <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    request<T>(method, path, body),
  healthz: () => request<Healthz>("GET", "/healthz"),
  changelog: () => request<{ sections: ChangelogDay[] }>("GET", "/changelog"),
  authConfig: () =>
    request<{
      signup_enabled: boolean;
      self_serve_invites?: boolean;
      hosted?: boolean;
      captcha?: { provider: string; site_key: string | null } | null;
    }>("GET", "/auth/config"),
  // Mint an API token (plaintext returned ONCE). Used by the edge-bridge setup to
  // generate a least-privilege devices:edge token in-flow, and by the API Recipes
  // auto-scoper (records:* scopes + source/meta provenance) — no trip to the tokens page.
  createApiToken: (body: {
    name: string;
    scopes?: string[];
    expires_at?: string;
    source?: string;
    meta?: Record<string, unknown>;
  }) =>
    request<{ id: string; name: string; token: string; token_prefix: string }>("POST", "/me/api-tokens", body),
  signup: (body: {
    email: string;
    password: string;
    display_name: string;
    org_name?: string;
    invite_token?: string;
    /** Managed-app signup: provision the first workspace as this app. */
    app?: string;
    manifest?: unknown;
    /** Captcha token (e.g. Turnstile), required only when the server has a
     *  captcha provider configured (the trial tier). */
    captcha_token?: string;
  }) =>
    request<AuthResponse | { needs_verification: true; email: string }>("POST", "/auth/signup", body),
  // Public preview of a single-use signup invite (the /join/:token page).
  previewSignupInvite: (token: string) =>
    request<{ status: string; invited_email: string | null; note: string | null; blueprint_name?: string | null }>(
      "GET",
      `/auth/signup-invite/${encodeURIComponent(token)}`,
    ),
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
  // Any workspace OWNER: invite a friend to Cobblr who gets their OWN
  // workspace (distinct from a workspace-member invite). Reuses the
  // signup-invite machinery, attributed to the caller.
  mintMySignupInvite: (body: { email?: string; note?: string; expires_in_days?: number; from_workspace?: string }) =>
    request<SignupInvite & { token: string; emailed: boolean }>("POST", "/me/signup-invites", body),
  listMySignupInvites: () =>
    request<{ items: SignupInvite[] }>("GET", "/me/signup-invites"),
  revokeMySignupInvite: (id: string) =>
    request<void>("POST", `/me/signup-invites/${id}/revoke`),
  // Feedback: any authed user submits; super-admin lists / triages.
  /** Environment facts for a public bug report. See api/src/routes/diagnostics.ts
   *  for what is deliberately absent — this payload becomes public. */
  diagnostics: (slug: string) =>
    request<{
      build_sha: string | null;
      hosted: boolean;
      node: string;
      platform: string;
      postgres: string;
      modules: string[];
    }>("GET", `/orgs/${slug}/diagnostics`),
  submitFeedback: (body: {
    type: "bug" | "confusing" | "idea" | "other";
    message: string;
    workspace_slug?: string;
    context?: Record<string, unknown>;
    attachments?: Array<{ file_id: string; name?: string; content_type?: string }>;
  }) => request<{ id: string; created_at: string }>("POST", "/feedback", body),
  // The signed-in user's OWN feedback + their two-way threads (/me/feedback).
  listMyFeedback: () => request<{ items: MyFeedbackItem[] }>("GET", "/feedback/mine"),
  // The reporter replies to their own item (answers a clarifying question).
  replyToFeedback: (id: string, text: string) =>
    request<{ ok: boolean; reopened: boolean }>("POST", `/feedback/${encodeURIComponent(id)}/reply`, { text }),
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
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>("POST", "/auth/login", body),
  magicRequest: (body: { email: string }) =>
    request<{
      ok: boolean;
      expires_at: string;
      message: string;
      /** Dev mode only — non-prod returns the plaintext + a link. */
      dev_token?: string;
      dev_link?: string;
    }>("POST", "/auth/magic/request", body),
  magicConsume: (body: { token: string }) =>
    request<AuthResponse>("POST", "/auth/magic/consume", body),
  // QR pair-login (desktop mints a code → phone scans + claims → signed in to
  // the same workspace). See api/src/routes/auth.ts "QR pair-login".
  pairStart: (body: { org_slug: string }) =>
    request<{
      code: string;
      expires_at: string;
      /** The URL the QR encodes (= claim_options[0]). */
      claim_url: string;
      /** Candidate claim URLs (request origin + optional PUBLIC_BASE_URL). */
      claim_options: { label: string; url: string }[];
    }>("POST", "/auth/pair/start", body),
  pairStatus: (code: string) =>
    request<{ state: "pending" | "claimed" | "expired" }>(
      "POST",
      `/auth/pair/status`,
      { code },
    ),
  pairClaim: (code: string) =>
    // Unauthenticated — the phone has no session yet. Returns the normal auth
    // response PLUS the workspace slug to make active (null if membership was
    // revoked between mint and claim → client falls back to the default).
    request<AuthResponse & { target_org_slug: string | null }>(
      "POST",
      "/auth/pair/claim",
      { code },
    ),
  // Password reset (forgot → email link → set new password, auto-login).
  passwordForgot: (body: { email: string }) =>
    request<{
      ok: boolean;
      message: string;
      /** Dev mode only — non-prod with no email sender returns the link. */
      dev_token?: string;
      dev_link?: string;
    }>("POST", "/auth/password/forgot", body),
  passwordReset: (body: { token: string; password: string }) =>
    request<AuthResponse>("POST", "/auth/password/reset", body),
  // Email verification (consume link; resend for the signed-in user).
  verifyEmail: (body: { token: string }) =>
    request<{ ok: boolean; email: string }>("POST", "/auth/verify-email", body),
  resendVerification: () =>
    request<{ ok: boolean; emailed?: boolean; already_verified?: boolean; dev_link?: string }>(
      "POST",
      "/me/verify-email/resend",
    ),
  me: () => request<MeResponse>("GET", "/me"),
  orgLocal: (slug: string) => request<OrgLocalResponse>("GET", `/orgs/${slug}/local`),
  listOrgs: () => request<{ items: OrgMembership[] }>("GET", "/orgs"),
  createOrg: (name: string, opts?: { blueprint?: unknown }) =>
    request<{ org: OrgMembership; slug: string; blueprint_applied?: { name: string } }>("POST", "/orgs", {
      name,
      ...(opts?.blueprint !== undefined ? { blueprint: opts.blueprint } : {}),
    }),
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
  /** Persist the per-user desktop nav layout (follows you across devices). */
  setNavPref: (nav_pref: { mode: "top" | "side"; autohide: boolean; topbar: boolean } | null) =>
    request<{ user: { nav_pref: unknown } }>("PATCH", "/me", { nav_pref }),
  /** Owner-only rename. `name` = display name (safe). `slug` = the URL handle
   *  (risky — breaks existing links). Returns the new name + slug. */
  renameOrg: (slug: string, body: { name?: string; slug?: string }) =>
    request<{ name: string; slug: string }>("PATCH", `/orgs/${slug}`, body),

  // Per-org module enable/disable + listing
  orgModules: (slug: string) =>
    request<{ items: OrgModuleListItem[] }>("GET", `/orgs/${slug}/modules`),
  enableModule: (slug: string, name: string) =>
    request<{ module: string; already_enabled: boolean }>(
      "POST",
      `/orgs/${slug}/modules/${name}/enable`,
    ),
  disableModule: (slug: string, name: string) =>
    request<void>("POST", `/orgs/${slug}/modules/${name}/disable`),

  // machines module (instance? scopes to /instances/:name/items)
  listMachines: (slug: string, instance?: string) =>
    request<{ items: Machine[] }>("GET", primaryBase(slug, "machines/machines", instance)),
  getMachine: (slug: string, id: string, instance?: string) =>
    request<Machine>("GET", `${primaryBase(slug, "machines/machines", instance)}/${id}`),
  createMachine: (slug: string, body: Partial<Machine>, instance?: string) =>
    request<Machine>("POST", primaryBase(slug, "machines/machines", instance), body),
  /** Auto-fetch a web image for an entity (e.g. a 3D printer) and set its
   *  image_path. Pass `image_url` to store a SPECIFIC user-picked image instead
   *  of auto-searching. Returns the resolved image_path. */
  /** Fetch + store an image for an entity. OMIT `query` and the server derives
   *  the phrase from the entity itself (same derivation as the picker) — hand-
   *  built phrases are how Auto and the web search drifted apart. */
  enrichEntityImage: (slug: string, body: { entity_kind: string; entity_id: string; query?: string; instance?: string | null; image_url?: string }) =>
    request<{ image_path: string | null }>("POST", `/orgs/${slug}/modules/core-scan/entity-image`, body),
  /** Fill in the missing pictures across a whole collection in one press — the
   *  same derived auto-fetch a single record's "Auto" runs, for every record
   *  with no image. Idempotent (a record that has one is never touched) and
   *  bounded, so pressing it again continues where it stopped. */
  backfillEntityImages: (
    slug: string,
    body: { entity_kind: string; instance?: string | null; limit?: number },
  ) =>
    request<{
      missing: number;
      started: number;
      remaining: number;
      /** Resolved, but had nothing searchable (a blank/junk name). */
      unnamed: number;
      /** Couldn't be read at all — a module wiring gap, not a data problem. */
      unresolved: number;
    }>("POST", `/orgs/${slug}/modules/core-scan/entity-image/backfill`, body),
  /** Web-image candidates for the universal photo-picker strip. Prefer `entity`:
   *  the SERVER derives the search phrase from that thing's own name/brand/fields,
   *  the same derivation the scan inbox uses, so one thing searches one way
   *  everywhere. `q` is a literal override (a user-typed term). Echoes back the
   *  phrase it actually searched. */
  imageOptions: (
    slug: string,
    opts: { q?: string; brand?: string; entity?: { kind: string; id: string } | null },
  ) => {
    const p = new URLSearchParams();
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    if (opts.brand) p.set("brand", opts.brand);
    if (opts.entity) {
      p.set("entity_kind", opts.entity.kind);
      p.set("entity_id", opts.entity.id);
    }
    return request<{ items: ImageOption[]; query?: string }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/image-options?${p.toString()}`,
    );
  },
  updateMachine: (slug: string, id: string, body: Partial<Machine>, instance?: string) =>
    request<Machine>("PATCH", `${primaryBase(slug, "machines/machines", instance)}/${id}`, body),
  deleteMachine: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "machines/machines", instance)}/${id}`),

  // purchases module (instance? scopes to /instances/:name/items)
  listOrders: (slug: string, instance?: string) =>
    request<{ items: Order[] }>("GET", primaryBase(slug, "purchases/orders", instance)),
  getOrder: (slug: string, id: string, instance?: string) =>
    request<Order & { items: OrderItem[] }>("GET", `${primaryBase(slug, "purchases/orders", instance)}/${id}`),
  createOrder: (slug: string, body: Partial<Order>, instance?: string) =>
    request<Order>("POST", primaryBase(slug, "purchases/orders", instance), body),
  updateOrder: (slug: string, id: string, body: Partial<Order>, instance?: string) =>
    request<Order>("PATCH", `${primaryBase(slug, "purchases/orders", instance)}/${id}`, body),
  deleteOrder: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "purchases/orders", instance)}/${id}`),
  // Order items are keyed by orderId (their instance rides the parent
  // order), so this stays on the legacy nested route either way.
  addOrderItem: (slug: string, orderId: string, body: Partial<OrderItem>) =>
    request<OrderItem>("POST", `/orgs/${slug}/modules/purchases/orders/${orderId}/items`, body),

  // Vendors — managed entity (purchasing depth). Not the primary entity,
  // so it lives on the module-root route, not primaryBase.
  // Managed app: re-apply the latest bundle version if behind (auto-update on use).
  refreshApp: (slug: string) =>
    request<{ updated: boolean; from?: string; to?: string }>("POST", `/orgs/${slug}/refresh-app`, {}),
  // Graduation: copy a managed app's data into a full workspace (targetSlug).
  importApp: (targetSlug: string, sourceSlug: string) =>
    request<{ imported: number; instance: string }>("POST", `/orgs/${targetSlug}/import-app`, { source_slug: sourceSlug }),

  listVendors: (slug: string) =>
    request<{ items: VendorSummary[] }>("GET", `/orgs/${slug}/modules/purchases/vendors`),
  getVendor: (slug: string, id: string) =>
    request<VendorDetail>("GET", `/orgs/${slug}/modules/purchases/vendors/${id}`),
  createVendor: (slug: string, body: Partial<Vendor>) =>
    request<Vendor>("POST", `/orgs/${slug}/modules/purchases/vendors`, body),
  updateVendor: (slug: string, id: string, body: Partial<Vendor>) =>
    request<Vendor>("PATCH", `/orgs/${slug}/modules/purchases/vendors/${id}`, body),
  deleteVendor: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/purchases/vendors/${id}`),

  // inventory module — just enough to count parts by location (the
  // /locations page needs it). Module-specific UI lives inside the
  // inventory module itself.
  listInventoryParts: (slug: string) =>
    request<{ items: Array<{ id: string; name: string; location_id: string | null }> }>(
      "GET",
      `/orgs/${slug}/modules/inventory/parts`,
    ),

  // assets module (instance? scopes to /instances/:name/items)
  listAssets: (slug: string, instance?: string) =>
    request<{ items: Asset[] }>("GET", primaryBase(slug, "assets/assets", instance)),
  getAsset: (slug: string, id: string, instance?: string) =>
    request<Asset>("GET", `${primaryBase(slug, "assets/assets", instance)}/${id}`),
  createAsset: (slug: string, body: Partial<Asset>, instance?: string) =>
    request<Asset>("POST", primaryBase(slug, "assets/assets", instance), body),
  updateAsset: (slug: string, id: string, body: Partial<Asset>, instance?: string) =>
    request<Asset>("PATCH", `${primaryBase(slug, "assets/assets", instance)}/${id}`, body),
  deleteAsset: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "assets/assets", instance)}/${id}`),

  // records module (instance? scopes to /instances/:name/items)
  listRecords: (slug: string, instance?: string) =>
    request<{ items: RecordItem[] }>("GET", primaryBase(slug, "records/records", instance)),
  getRecord: (slug: string, id: string, instance?: string) =>
    request<RecordItem>("GET", `${primaryBase(slug, "records/records", instance)}/${id}`),
  createRecord: (slug: string, body: Partial<RecordItem>, instance?: string) =>
    request<RecordItem>("POST", primaryBase(slug, "records/records", instance), body),
  updateRecord: (slug: string, id: string, body: Partial<RecordItem>, instance?: string) =>
    request<RecordItem>("PATCH", `${primaryBase(slug, "records/records", instance)}/${id}`, body),
  deleteRecord: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "records/records", instance)}/${id}`),

  // Members + invites
  listMembers: (slug: string) =>
    request<{ items: WorkspaceMember[]; self: { user_id: string; role: OrgMembership["role"] } }>(
      "GET",
      `/orgs/${slug}/members`,
    ),
  updateMemberRole: (slug: string, userId: string, role: OrgMembership["role"]) =>
    request<WorkspaceMember>("PATCH", `/orgs/${slug}/members/${userId}`, { role }),
  removeMember: (slug: string, userId: string) =>
    request<void>("DELETE", `/orgs/${slug}/members/${userId}`),
  listInvites: (slug: string, includeAll = false) =>
    request<{ items: WorkspaceInvite[] }>(
      "GET",
      `/orgs/${slug}/members/invites${includeAll ? "?include=all" : ""}`,
    ),
  createInvite: (
    slug: string,
    body: { email?: string; role: OrgMembership["role"]; expires_at?: string },
  ) =>
    request<WorkspaceInvite>("POST", `/orgs/${slug}/members/invites`, body),
  revokeInvite: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/members/invites/${id}`),
  previewInvite: (token: string) =>
    request<InvitePreview>("GET", `/invites/${token}`),
  acceptInvite: (token: string) =>
    request<{ org: OrgMembership; already_member: boolean }>(
      "POST",
      `/invites/${token}/accept`,
    ),
  // New user (no account) signs up AND joins the inviting workspace.
  acceptInviteAsNewUser: (
    token: string,
    body: { email: string; password: string; display_name: string },
  ) => request<AuthResponse>("POST", `/invites/${token}/accept-signup`, body),

  // Long-lived API tokens
  listApiTokens: () =>
    request<{ items: ApiTokenListItem[] }>("GET", "/me/api-tokens"),
  apiTokenScopes: () =>
    request<{ items: { key: string; label: string; description: string }[] }>(
      "GET",
      "/me/api-token-scopes",
    ),
  mintApiToken: (body: { name: string; expires_at?: string; scopes?: string[] }) =>
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

  // Personal (user-scoped) connections — BYO AI creds routed to your workspaces.
  listConnections: () =>
    request<{ items: UserConnection[] }>("GET", "/me/connections"),
  /** Is my personal edge agent connected right now? (transit hint) */
  getMyEdgeAgent: () => request<{ connected: boolean }>("GET", "/me/edge-agent"),
  connectionCatalogue: () =>
    request<{ items: AiProviderDef[] }>("GET", "/me/connections/catalogue"),
  addConnection: (body: UserConnectionInput) =>
    request<{ id: string }>("POST", "/me/connections", body),
  updateConnection: (id: string, body: Partial<UserConnectionInput>) =>
    request<void>("PATCH", `/me/connections/${id}`, body),
  deleteConnection: (id: string) =>
    request<void>("DELETE", `/me/connections/${id}`),

  // Workspace owner: review + approve members' AI-share offers.
  listAiShares: (slug: string) =>
    request<{ items: WorkspaceAiOffer[] }>("GET", `/orgs/${slug}/ai-shares`),
  approveAiShare: (slug: string, credentialId: string, active = false) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/${credentialId}/approve`, { active }),
  rejectAiShare: (slug: string, credentialId: string) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/${credentialId}/reject`),
  setActiveAiShare: (slug: string, credentialId: string | null) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/active`, { credential_id: credentialId }),

  orgActivity: (slug: string, limit = 25) =>
    request<{ items: ActivityEntry[] }>("GET", `/orgs/${slug}/activity?limit=${limit}`),
  // Cross-workspace activity feed: every action attributed to any
  // workspace the caller belongs to. Optional ?org= narrows to one.
  meActivity: (opts: { limit?: number; org?: string; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.org) qs.set("org", opts.org);
    if (opts.cursor) qs.set("cursor", opts.cursor);
    return request<{ items: CrossOrgActivityEntry[]; next_cursor: string | null; total: number }>(
      "GET",
      `/me/activity${qs.toString() ? `?${qs.toString()}` : ""}`,
    );
  },
  modules: () => request<{ items: ModuleListItem[] }>("GET", "/modules"),

  // Pillar A — entities + kinds
  listEntityKinds: (slug: string) =>
    request<{ items: PlatformEntityKind[] }>("GET", `/orgs/${slug}/entity-kinds`),
  lookupEntity: (slug: string, kind: string, id: string) =>
    request<PlatformResolvedEntity>("GET", `/orgs/${slug}/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  /** Generic entity list — the data source for relation-field pickers and any
   *  cross-module chooser. Projected through exposableFields like lookup. */
  listEntities: (slug: string, kind: string, q?: string) =>
    request<{ items: PlatformResolvedEntity[] }>(
      "GET",
      `/orgs/${slug}/entities/${encodeURIComponent(kind)}${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ),

  // Placement — containment (core-placement). "What's inside this container?"
  // and "what is this thing installed in?"
  placementContents: (slug: string, containerKind: string, containerId: string) =>
    request<{ items: PlatformResolvedEntity[] }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/contents?container_kind=${encodeURIComponent(containerKind)}&container_id=${encodeURIComponent(containerId)}`,
    ),
  placementContainerOf: (slug: string, containeeKind: string, containeeId: string) =>
    request<{ container: PlatformResolvedEntity | null }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/of?containee_kind=${encodeURIComponent(containeeKind)}&containee_id=${encodeURIComponent(containeeId)}`,
    ),
  placementPlace: (
    slug: string,
    body: { containee: { kind: string; id: string }; container: { kind: string; id: string }; slot?: string | null },
  ) => request<void>("POST", `/orgs/${slug}/modules/core-placement/place`, body),
  placementRemove: (slug: string, containee: { kind: string; id: string }) =>
    request<void>("POST", `/orgs/${slug}/modules/core-placement/remove`, { containee }),

  // core-units vocabulary
  listUnits: (slug: string) =>
    request<UnitVocabulary>("GET", `/orgs/${slug}/modules/core-units/units`),
  addUnit: (slug: string, unit: UnitInputBody) =>
    request<UnitDef>("POST", `/orgs/${slug}/modules/core-units/units`, unit),
  deleteUnit: (slug: string, code: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-units/units/${encodeURIComponent(code)}`),
  setUnitDisplayMode: (slug: string, mode: UnitDisplayMode) =>
    request<{ display_mode: UnitDisplayMode }>(
      "PUT",
      `/orgs/${slug}/modules/core-units/units/settings`,
      { display_mode: mode },
    ),

  // workspace calendar
  calendarEvents: (slug: string, from: string, to: string) =>
    request<{ items: CalendarEvent[]; from: string; to: string }>(
      "GET",
      `/orgs/${slug}/calendar/events?from=${from}&to=${to}`,
    ),
  getCalendarFeed: (slug: string) =>
    request<CalendarFeed>("GET", `/orgs/${slug}/calendar/feed`),
  setCalendarFeed: (slug: string, enabled: boolean) =>
    request<CalendarFeed>("PUT", `/orgs/${slug}/calendar/feed`, { enabled }),
  rotateCalendarFeed: (slug: string) =>
    request<CalendarFeed>("POST", `/orgs/${slug}/calendar/feed/rotate`, {}),

  // Pillar B — actions + invocation
  listActions: (slug: string, kind: string) =>
    request<{ items: PlatformAction[]; bindings: PlatformActionBinding[] }>(
      "GET",
      `/orgs/${slug}/actions?kind=${encodeURIComponent(kind)}`,
    ),
  invokeAction: (
    slug: string,
    body: {
      actionId: string;
      entityKind: string;
      entityId: string;
      bindingId?: string;
      args?: Record<string, unknown>;
    },
  ) =>
    // The route's 200 means "the action was invoked"; whether the operation went
    // ahead is the handler's own `result.ok`. Callers reasonably treat a resolved
    // promise as success — the App Player toasted "ran." on a refusal — so a
    // refusal is raised HERE, once, with the handler's reason. Every existing
    // caller's catch then shows why instead of a false confirmation, and no
    // future caller has to remember to unwrap the envelope.
    request<{ ok: boolean; result: unknown }>("POST", `/orgs/${slug}/actions/invoke`, body).then(
      (res) => {
        const inner = res.result as { ok?: unknown; error?: unknown } | null;
        if (inner && typeof inner === "object" && inner.ok === false) {
          throw new Error(
            typeof inner.error === "string" && inner.error.trim()
              ? inner.error
              : "That action couldn't run.",
          );
        }
        return res;
      },
    ),

  // Pillar B — registered actions + per-org appliesTo overrides
  listRegisteredActions: (slug: string) =>
    request<{ items: RegisteredAction[] }>(
      "GET",
      `/orgs/${slug}/registered-actions`,
    ),
  setActionPredicate: (slug: string, actionId: string, override: ActionAppliesTo) =>
    request<RegisteredActionDetail>(
      "PUT",
      `/orgs/${slug}/registered-actions/${encodeURIComponent(actionId)}/predicate`,
      override,
    ),
  revertActionPredicate: (slug: string, actionId: string) =>
    request<RegisteredActionDetail>(
      "DELETE",
      `/orgs/${slug}/registered-actions/${encodeURIComponent(actionId)}/predicate`,
    ),

  // Pillar C — bindings (wires)
  listBindings: (slug: string) =>
    request<{ items: PlatformBinding[] }>("GET", `/orgs/${slug}/bindings`),
  // Available trigger events (enabled modules' manifest-declared events)
  // for the wire composer's typeahead.
  listWireEvents: (slug: string) =>
    request<{ items: { event: string; module: string }[] }>(
      "GET",
      `/orgs/${slug}/wire-events`,
    ),
  createBinding: (slug: string, body: Partial<PlatformBinding>) =>
    request<PlatformBinding>("POST", `/orgs/${slug}/bindings`, body),
  updateBinding: (slug: string, id: string, body: Partial<PlatformBinding>) =>
    request<PlatformBinding>("PATCH", `/orgs/${slug}/bindings/${id}`, body),
  deleteBinding: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/bindings/${id}`),

  // Field defs (Pillar D-lite)
  // `effective` applies the user override layer (relabel / hide / reorder) — forms
  // + lists pass it; config surfaces (Fields, composer) read the raw defs.
  listFieldDefs: (slug: string, kind?: string, effective?: boolean) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (effective) params.set("effective", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<{ items: PlatformFieldDef[]; sections?: FieldSection[]; scopes?: FieldScope[] }>(
      "GET",
      `/orgs/${slug}/field-defs${qs}`,
    );
  },
  /** A part's purchase history + price stats, from purchases' own full-fat
   *  /items route (the generic entities list can't carry unit_cost — costs
   *  aren't in the kind's exposableFields). Empty items = never bought. */
  purchasesPriceHistory: (slug: string, partId: string) =>
    request<PurchasePriceHistory>(
      "GET",
      `/orgs/${slug}/modules/purchases/items?part_id=${encodeURIComponent(partId)}`,
    ),
  /** Which carrier a tracking number belongs to, worked out from the number's
   *  own format + check digit. `carrier: null` means no format recognised it,
   *  which is a normal answer about a real parcel rather than an error. */
  shipmentCarrier: (slug: string, number: string) =>
    request<{ carrier: ShipmentCarrier | null; lookup: TrackingLookup }>(
      "GET",
      `/orgs/${slug}/modules/core-shipments/carrier?number=${encodeURIComponent(number)}`,
    ),
  /** Where the parcel is, asked of the carrier now. A null `status` always
   *  comes with a `reason`, because "we could not follow it" and "it has not
   *  moved" are different answers and must not both render as blank. */
  shipmentStatus: (slug: string, number: string) =>
    request<{
      carrier: ShipmentCarrier | null;
      status: ShipmentStatus | null;
      reason: ShipmentStatusReason | null;
    }>("GET", `/orgs/${slug}/modules/core-shipments/status?number=${encodeURIComponent(number)}`),
  createFieldDef: (slug: string, body: Partial<PlatformFieldDef>) =>
    request<PlatformFieldDef>("POST", `/orgs/${slug}/field-defs`, body),
  updateFieldDef: (slug: string, id: string, body: Partial<PlatformFieldDef>) =>
    request<PlatformFieldDef>("PATCH", `/orgs/${slug}/field-defs/${id}`, body),
  deleteFieldDef: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/field-defs/${id}`),
  // Form-builder sections — group a kind's fields under headings.
  listFieldSections: (slug: string, kind: string) =>
    request<{ items: FieldSection[] }>("GET", `/orgs/${slug}/field-sections?kind=${encodeURIComponent(kind)}`),
  createFieldSection: (slug: string, body: { entity_kind: string; name: string }) =>
    request<FieldSection>("POST", `/orgs/${slug}/field-sections`, body),
  updateFieldSection: (slug: string, id: string, body: { name?: string; position?: number }) =>
    request<FieldSection>("PATCH", `/orgs/${slug}/field-sections/${id}`, body),
  deleteFieldSection: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/field-sections/${id}`),
  reorderFields: (
    slug: string,
    body: { entity_kind: string; sections?: Array<{ id: string; position: number }>; fields?: Array<{ name: string; section_id: string | null; position: number }> },
  ) => request<{ ok: boolean }>("POST", `/orgs/${slug}/field-defs/reorder`, body),
  // Native-field presentation overrides (relabel / show-hide of a module's
  // own fields). Read by the entity forms; written by Configuration → Presentation.
  listNativeFieldOverrides: (slug: string, kind?: string) => {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<{ items: NativeFieldOverride[] }>("GET", `/orgs/${slug}/native-field-overrides${qs}`);
  },
  putNativeFieldOverride: (
    slug: string,
    body: { entity_kind: string; name: string; display_label?: string | null; hidden?: boolean; position?: number; choices?: string[] | null },
  ) => request<NativeFieldOverride>("PUT", `/orgs/${slug}/native-field-overrides`, body),
  deleteNativeFieldOverride: (slug: string, entityKind: string, name: string) =>
    request<void>("DELETE", `/orgs/${slug}/native-field-overrides/${encodeURIComponent(entityKind)}/${encodeURIComponent(name)}`),
  appendFieldDefChoice: async (slug: string, id: string, value: string) => {
    // Fetch current choices, append, PATCH. The server routes a bundle-owned
    // field's choices to the user override layer, so this never clobbers a bundle.
    const list = await request<{ items: PlatformFieldDef[] }>("GET", `/orgs/${slug}/field-defs`);
    const cur = list.items.find((f) => f.id === id);
    const choices = [...(cur?.choices ?? []), value];
    return request<PlatformFieldDef>("PATCH", `/orgs/${slug}/field-defs/${id}`, { choices });
  },

  // Bundles (C.2)
  listBundles: (slug: string) =>
    request<{ items: PlatformBundle[] }>("GET", `/orgs/${slug}/bundles`),
  installBundle: (
    slug: string,
    manifest: PlatformBundleManifest,
    confirm?: boolean,
    enabledFeatures?: string[],
    takeTheirs?: Array<{ entity_kind: string; name: string }>,
  ) =>
    request<{ bundle: PlatformBundle; applied: { wires: number; field_defs: number } }>(
      "POST",
      `/orgs/${slug}/bundles/install`,
      { manifest, confirm, enabled_features: enabledFeatures, take_theirs: takeTheirs },
    ),
  validateBundle: (slug: string, manifest: PlatformBundleManifest) =>
    request<BundleValidation>("POST", `/orgs/${slug}/bundles/validate`, { manifest }),
  uninstallBundle: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/bundles/${id}`),
  /** What uninstalling this bundle would tear down: its instances no other source
   *  still claims (with item counts) + modules that would be turned off. Powers
   *  the uninstall-confirm warning. */
  bundleUninstallPreview: (slug: string, id: string) =>
    request<{
      instances: { name: string; display_name: string; item_count: number }[];
      modules: string[];
    }>("GET", `/orgs/${slug}/bundles/${id}/uninstall-preview`),

  // ─── extension registry (the marketplace index — HACS-style) ───────
  // The curated cobblr-extensions index over all three lanes, merged with
  // any third-party source index URLs. Server-side fetch (token + SSRF
  // guard). Install still goes through the per-lane endpoints above.
  getRegistryIndex: (sources?: string[]) =>
    request<RegistryIndex>(
      "GET",
      `/registry/index${sources && sources.length ? `?sources=${encodeURIComponent(sources.join(","))}` : ""}`,
    ),

  // ─── installed file-preview renderers (core-file-preview, per workspace) ──
  getInstalledRenderers: (slug: string) =>
    request<{ items: InstalledRenderer[] }>("GET", `/orgs/${slug}/modules/core-file-preview/renderers`),
  installRenderer: (
    slug: string,
    body: { name: string; version?: string; exts: string[]; renderer_js: string; pubkey?: string; signature?: string },
  ) =>
    request<InstalledRenderer>("POST", `/orgs/${slug}/modules/core-file-preview/renderers`, body),
  uninstallRenderer: (slug: string, name: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-file-preview/renderers/${encodeURIComponent(name)}`),

  // ─── core-authoring (AI bundle builder, Phase 1: copy-paste) ───────
  authoringContext: (slug: string, selected_kinds?: string[]) =>
    request<AuthoringContext>("POST", `/orgs/${slug}/modules/core-authoring/context`, { selected_kinds }),
  authoringCompile: (
    slug: string,
    body: { intent: string; selected_kinds?: string[]; task?: string; base_template_id?: string },
  ) =>
    request<{ draft_id: string; prompt: string; warnings: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/compile`,
      body,
    ),
  /** Hosted build (Phase 2): the server calls AI itself + auto-repairs. ASYNC —
   *  returns { draft_id, status:"building" } immediately; poll authoringDraft
   *  until status leaves "building". Throws 409 when the workspace has no AI
   *  (caller falls back to authoringCompile). */
  authoringBuild: (
    slug: string,
    body: { intent: string; selected_kinds?: string[]; task?: string; base_template_id?: string },
  ) =>
    request<{ draft_id: string; status: string }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/build`,
      body,
    ),
  /** Poll a build draft. status: building → keep polling; validated | candidate
   *  | failed → terminal. candidate/validation/interpretation populate as the
   *  background build progresses. */
  authoringDraft: (slug: string, draftId: string) =>
    request<{
      id: string;
      status: string;
      task: string;
      intent: string;
      candidate?: unknown;
      validation?: BundleValidation | null;
      interpretation?: string | null;
      /** design-workspace: starter records that apply will create. */
      seed_plan?: { kind: string; records: Record<string, unknown>[] }[] | null;
    }>("GET", `/orgs/${slug}/modules/core-authoring/drafts/${draftId}`),
  /** Phase 3 refine: revise a draft's artifact against a change request. A NEW
   *  draft is created (parent_draft_id lineage). run:true → hosted build (202,
   *  poll authoringDraft); run:false → copy-paste prompt (201). */
  authoringRefine: (slug: string, draftId: string, body: { intent: string; run?: boolean }) =>
    request<{ draft_id: string; parent_draft_id: string; status?: string; prompt?: string; warnings?: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/refine`,
      body,
    ),
  authoringCandidate: (slug: string, draftId: string, manifest: unknown) =>
    request<BundleValidation>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/candidate`,
      { manifest },
    ),
  authoringRepairPrompt: (slug: string, draftId: string) =>
    request<{ prompt: string }>("POST", `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/repair-prompt`),
  authoringApply: (slug: string, draftId: string, confirm = true) =>
    request<{
      applied: boolean;
      bundle?: unknown;
      seeded?: { created: number; skipped: number };
      // design-app: apply created a WorkspaceApp instead of installing a bundle.
      app?: { slug: string; name: string };
    }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/apply`,
      { confirm },
    ),
  /** Version history (audit F3): every removed bundle row (update-replace /
   *  uninstall / revert) is snapshotted; list them for one external_id. */
  bundleHistory: (slug: string, externalId: string) =>
    request<{
      items: Array<{
        id: string;
        external_id: string;
        name: string;
        version: string;
        reason: string;
        enabled_features: string[];
        created_at: string;
        counts: { field_defs: number; wires: number; instances: number };
      }>;
    }>("GET", `/orgs/${slug}/bundles/history/${encodeURIComponent(externalId)}`),
  /** Re-validate + re-apply a snapshot. 409 revert_invalid when the workspace
   *  has drifted (modules/kinds changed) — nothing is half-applied. */
  bundleRevert: (slug: string, snapshotId: string) =>
    request<{ bundle: { id: string; external_id: string; name: string; version: string } }>(
      "POST",
      `/orgs/${slug}/bundles/history/${snapshotId}/revert`,
    ),
  getBundle: (slug: string, id: string) =>
    request<{
      bundle: PlatformBundle & { manifest: PlatformBundleManifest; enabled_features?: string[] };
      wires: PlatformBinding[];
      field_defs: PlatformFieldDef[];
    }>("GET", `/orgs/${slug}/bundles/${id}`),
  exportBundle: (slug: string) =>
    request<{ manifest: PlatformBundleManifest }>("GET", `/orgs/${slug}/bundles/export`),
  listActivity: (
    slug: string,
    opts: {
      actions?: string[];
      authMethods?: ("session" | "api_token" | "system")[];
      apiTokenId?: string;
      entityType?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.actions?.length) params.set("actions", opts.actions.join(","));
    if (opts.authMethods?.length) params.set("auth_methods", opts.authMethods.join(","));
    if (opts.apiTokenId) params.set("api_token_id", opts.apiTokenId);
    if (opts.entityType) params.set("entity_type", opts.entityType);
    return request<{ items: ActivityEntry[] }>(
      "GET",
      `/orgs/${slug}/activity?${params.toString()}`,
    );
  },

  // Notifications — per-org variants (still used by some pages).
  notifications: (slug: string, limit = 25) =>
    request<{ items: NotificationEntry[] }>(
      "GET",
      `/orgs/${slug}/notifications?limit=${limit}`,
    ),
  notificationsUnreadCount: (slug: string) =>
    request<{ count: number }>("GET", `/orgs/${slug}/notifications/unread-count`),
  markNotificationRead: (slug: string, id: string) =>
    request<void>("POST", `/orgs/${slug}/notifications/${id}/read`),
  markAllNotificationsRead: (slug: string) =>
    request<{ marked: number }>("POST", `/orgs/${slug}/notifications/read-all`),

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

  // /me/profile (display_name + password change).
  updateMe: (body: { display_name?: string }) =>
    request<{ user: SessionUser }>("PATCH", "/me", body),
  // Changing the password revokes all prior tokens server-side; the response
  // carries a freshly-minted one for THIS session, which we persist so the
  // user stays logged in on this device.
  changeMyPassword: async (body: { current_password: string; new_password: string }) => {
    const res = await request<{ token: string }>("POST", "/me/password", body);
    if (res?.token) setToken(res.token);
    return res;
  },

  meNotifications: (limit = 25) =>
    request<{ items: CrossOrgNotificationEntry[] }>(
      "GET",
      `/me/notifications?limit=${limit}`,
    ),
  meNotificationsUnreadCount: () =>
    request<{ count: number }>("GET", "/me/notifications/unread-count"),
  meMarkNotificationRead: (id: string) =>
    request<void>("POST", `/me/notifications/${id}/read`),
  meMarkAllNotificationsRead: () =>
    request<{ count: number }>("POST", "/me/notifications/read-all"),

  // ─── Notification channel bindings ────────────────────────────────
  meNotificationChannels: (orgId: string) =>
    request<{ items: NotificationChannelBinding[] }>(
      "GET",
      `/me/notification-channels?org_id=${encodeURIComponent(orgId)}`,
    ),
  upsertMeNotificationChannel: (body: NotificationChannelUpsert) =>
    request<NotificationChannelBinding>(
      "POST",
      `/me/notification-channels`,
      body,
    ),
  deleteMeNotificationChannel: (id: string) =>
    request<void>("DELETE", `/me/notification-channels/${id}`),
  testMeNotificationChannel: (body: { org_id: string; priority?: NotificationPriority }) =>
    request<{ notificationId: string; deliveredVia: string[] }>(
      "POST",
      `/me/notification-channels/test`,
      body,
    ),
  testOneMeNotificationChannel: (
    id: string,
    body: { priority?: NotificationPriority } = {},
  ) =>
    request<{ deliveredVia: string[] }>(
      "POST",
      `/me/notification-channels/${id}/test`,
      body,
    ),

  // ─── Discord connection (Feature 1) ───────────────────────────────
  meDiscordStatus: () =>
    request<{ configured: boolean; connected: boolean; verified: boolean; username: string | null; invite_url: string | null }>(
      "GET",
      "/me/discord",
    ),
  meDiscordOAuthStart: () =>
    request<{ url: string }>("POST", "/me/discord/oauth-start"),
  meDiscordRetryTest: () =>
    request<{ deliverable: boolean }>("POST", "/me/discord/retry-test"),
  meDiscordConfirm: () =>
    request<{ ok: boolean; verified: boolean }>("POST", "/me/discord/confirm"),
  meDiscordDisconnect: () =>
    request<void>("DELETE", "/me/discord"),

  // ─── Communication Preferences matrix (Feature 1) ─────────────────
  meCommunicationPrefs: () =>
    request<CommunicationPrefs>("GET", "/me/communication-prefs"),
  setMeCommunicationPref: (body: { notification_type: string; channel: string; enabled: boolean }) =>
    request<{ ok: boolean }>("PUT", "/me/communication-prefs", body),

  // ─── Browser driving (Feature 3) ──────────────────────────────────
  driveGrant: (slug: string) =>
    request<{ mode: "off" | "navigate" | "navigate_observe" }>("GET", `/orgs/${slug}/drive/grant`),
  setDriveGrant: (slug: string, mode: "off" | "navigate" | "navigate_observe") =>
    request<{ mode: string }>("PUT", `/orgs/${slug}/drive/grant`, { mode }),
  driveTabTicket: (slug: string) =>
    request<{ ticket: string }>("POST", `/orgs/${slug}/drive/tab/ticket`),
  driveTabAccept: (slug: string, browser_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/accept`, { browser_id }),
  driveTabRelease: (slug: string, browser_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/release`, { browser_id }),
  driveTabTelemetry: (slug: string, browser_id: string, events: unknown[]) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/drive/tab/telemetry`, { browser_id, events }),
  driveStatus: (slug: string) =>
    request<{ driver: boolean; tabs: number; active: string | null }>(
      "GET",
      `/orgs/${slug}/drive/status`,
    ),

  // ─── Live box (docs/design-decisions/live-controls.md) ────────────
  // The applicable live controls for this workspace: every enabled module's
  // exposes.live whose required capability is satisfied. Empty → the box hides.
  getLive: (slug: string) =>
    request<{ controls: LiveControlPublic[] }>("GET", `/orgs/${slug}/live`),
  // Read / write a server-scoped live control's state through its declared
  // org-relative endpoint (e.g. "/modules/labels/autoflush").
  liveState: (slug: string, endpoint: string) =>
    request<Record<string, unknown>>("GET", `/orgs/${slug}${endpoint}`),
  liveSet: (slug: string, endpoint: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>("PUT", `/orgs/${slug}${endpoint}`, body),

  // ─── scan-drives-screen (Phase 1) ─────────────────────────────────
  // A scan is a driver: a Cobblr QR navigates the designated tab to that
  // entity; a product barcode intakes it + surfaces the Scan inbox; nothing
  // designated → it lands in triage (driven:false). See
  // docs/design-decisions/scan-drives-screen.md.
  scanDrive: (
    slug: string,
    code: string,
    scan_batch_id?: string,
    disposition?: "navigate" | "print",
  ) =>
    request<{
      driven: boolean;
      kind: "qr" | "barcode";
      action?: "navigate" | "print";
      path?: string;
      item_id?: string;
      /** For action:"print" — the label was queued (auto-flush policy, if any, ran). */
      queued?: boolean;
    }>("POST", `/orgs/${slug}/scan-drive`, {
      code,
      ...(scan_batch_id ? { scan_batch_id } : {}),
      ...(disposition ? { disposition } : {}),
    }),

  // ─── core-files ───────────────────────────────────────────────────
  listFiles: (slug: string, kind?: string) =>
    request<{ items: FileRecord[] }>(
      "GET",
      `/orgs/${slug}/modules/core-files/files${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  uploadFile: async (slug: string, file: File): Promise<FileRecord> => {
    const form = new FormData();
    form.set("file", file);
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(
      `/api/v1/orgs/${slug}/modules/core-files/files`,
      { method: "POST", headers, body: form },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, "upload_failed", text);
    }
    return (await res.json()) as FileRecord;
  },
  deleteFile: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-files/files/${id}`),
  // IDEMPOTENT: image_path is stored as a FULL raw URL (uploads + web-image
  // enrich both do `fileRawUrl(id)`), so a caller that wraps an already-resolved
  // path/URL again must NOT double it (that yields `.../files//api/.../raw/raw`
  // → 404 → retry → modal flicker). A bare file id is wrapped; a full path or
  // external URL passes straight through.
  fileRawUrl: (slug: string, id: string, variant?: "medium" | "thumb" | "original") =>
    /^(https?:\/\/|\/)/.test(id)
      ? id
      : `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw${variant ? `?variant=${variant}` : ""}`,

  // ─── core-views ───────────────────────────────────────────────────
  listSavedViews: (slug: string, kind?: string) =>
    request<{ items: SavedView[] }>(
      "GET",
      `/orgs/${slug}/modules/core-views/views${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  createSavedView: (slug: string, body: Partial<SavedView> & { shared?: boolean }) =>
    request<SavedView>("POST", `/orgs/${slug}/modules/core-views/views`, body),
  updateSavedView: (
    slug: string,
    id: string,
    body: Partial<SavedView> & { shared?: boolean },
  ) =>
    request<SavedView>(
      "PATCH",
      `/orgs/${slug}/modules/core-views/views/${id}`,
      body,
    ),
  deleteSavedView: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-views/views/${id}`),
  viewData: (slug: string, id: string, params?: { q?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit) qs.set("limit", String(params.limit));
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return request<ViewDataResponse>(
      "GET",
      `/orgs/${slug}/modules/core-views/views/${id}/data${tail}`,
    );
  },

  // ─── core-apps (custom worker apps, H1) ───────────────────────────
  listApps: (slug: string) =>
    request<{ items: WorkspaceAppMeta[] }>(
      "GET",
      `/orgs/${slug}/modules/core-apps/apps`,
    ),
  getApp: (slug: string, appSlug: string) =>
    request<WorkspaceApp>(
      "GET",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}`,
    ),
  createApp: (slug: string, body: Partial<WorkspaceApp>) =>
    request<WorkspaceApp>("POST", `/orgs/${slug}/modules/core-apps/apps`, body),
  updateApp: (slug: string, appSlug: string, body: Partial<WorkspaceApp>) =>
    request<WorkspaceApp>(
      "PATCH",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}`,
      body,
    ),
  deleteApp: (slug: string, appSlug: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-apps/apps/${appSlug}`),
  /** Mint a short-lived capability-scoped token (Tier B) for the App
   *  Player to mediate a sandboxed custom frontend's reads. */
  mintAppToken: (slug: string, appSlug: string) =>
    request<{ token: string; expires_in: number }>(
      "POST",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}/token`,
    ),

  // ─── core-tags ────────────────────────────────────────────────────
  listTags: (slug: string) =>
    request<{ items: TagRecord[] }>("GET", `/orgs/${slug}/modules/core-tags/tags`),
  createTag: (
    slug: string,
    body: { name: string; color?: string | null; parent_id?: string | null; icon?: string | null },
  ) => request<TagRecord>("POST", `/orgs/${slug}/modules/core-tags/tags`, body),
  updateTag: (
    slug: string,
    id: string,
    body: { name?: string; color?: string | null; parent_id?: string | null; icon?: string | null },
  ) =>
    request<TagRecord>(
      "PATCH",
      `/orgs/${slug}/modules/core-tags/tags/${id}`,
      body,
    ),
  deleteTag: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-tags/tags/${id}`),
  mergeTag: (slug: string, id: string, intoTagId: string) =>
    request<{
      merged_into: TagRecord;
      moved_assignments: number;
      deleted_tag: { id: string; name: string };
    }>("POST", `/orgs/${slug}/modules/core-tags/tags/${id}/merge`, {
      into_tag_id: intoTagId,
    }),
  listTagAttachments: (
    slug: string,
    params:
      | { source_type: string; source_id: string; source_module?: string }
      | { tag_id: string },
  ) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ items: TagAttachment[] }>(
      "GET",
      `/orgs/${slug}/modules/core-tags/attachments?${qs}`,
    );
  },
  attachTag: (
    slug: string,
    body: {
      tag_name?: string;
      tag_id?: string;
      color?: string | null;
      source_module: string;
      source_type: string;
      source_id: string;
    },
  ) => request<TagAttachment>("POST", `/orgs/${slug}/modules/core-tags/attachments`, body),
  detachTag: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-tags/attachments/${id}`),

  // ─── core-search ──────────────────────────────────────────────────
  // Either `q` (free-text) or `tag` (D7 tag-filter) is required; both
  // can be combined to narrow tagged entities by name as well.
  search: (
    slug: string,
    args: { q?: string; kinds?: string; tag?: string } | string,
  ) => {
    const a = typeof args === "string" ? { q: args } : args;
    const qs = new URLSearchParams();
    if (a.q) qs.set("q", a.q);
    if (a.kinds) qs.set("kinds", a.kinds);
    if (a.tag) qs.set("tag", a.tag);
    return request<{ items: SearchHit[]; kinds_searched: string[] }>(
      "GET",
      `/orgs/${slug}/modules/core-search/search?${qs.toString()}`,
    );
  },

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

  // ─── digifab (print-farm connections) ──────────────────────────
  listDigifabConnections: (slug: string) =>
    request<{ items: DigifabConnection[]; types: string[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/connections`,
    ),
  // The live fleet/floor view: every enabled connection's devices + state, with
  // Cobblr's in-flight jobs overlaid. Read-only; the page polls it.
  getDigifabFleet: (slug: string) =>
    request<DigifabFleet>("GET", `/orgs/${slug}/modules/digifab/fleet`),
  // F-1: clear a printer's bed-clear flag — "cleared, ready for the next job".
  // F-13 — clear the bed + give the verdict. "good" closes the linked task;
  // "scrapped" reverses the optimistic filament/usage effects. Default "good".
  markDigifabDeviceReady: (slug: string, connectionId: string, deviceId: string, outcome: "good" | "scrapped" = "good") =>
    request<{ ok: boolean; outcome: string }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/ready`, { outcome }),
  // Cockpit: set/clear a device's camera stream URL (manual override).
  setDigifabDevicePosition: (slug: string, connId: string, deviceId: string, pos: { x: number; y: number } | null) =>
    request<{ ok: boolean }>("PUT", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/position`, pos ?? { x: null, y: null }),
  saveDigifabFleetLayout: (slug: string, items: Array<{ connection_id: string; device_id: string; row_break?: boolean }>) =>
    request<{ ok: boolean; placed: number }>("PUT", `/orgs/${slug}/modules/digifab/fleet/layout`, { items }),
  setDigifabDeviceCamera: (slug: string, connectionId: string, deviceId: string, cameraUrl: string | null) =>
    request<{ ok: boolean; camera_url: string | null }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/camera`, { camera_url: cameraUrl }),
  // Snapshot relay (opt-in, off by default): toggle whether the cloud accepts +
  // serves agent-pushed frames for remote viewing.
  setDigifabDeviceSnapshotRelay: (slug: string, connectionId: string, deviceId: string, enabled: boolean) =>
    request<{ ok: boolean; snapshot_relay: boolean }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/snapshot-relay`, { enabled }),
  digifabSnapshotPath: (slug: string, connectionId: string, deviceId: string) =>
    `/orgs/${slug}/modules/digifab/fleet/${connectionId}/${encodeURIComponent(deviceId)}/snapshot`,
  createDigifabConnection: (
    slug: string,
    body: {
      type: string;
      label: string;
      base_url: string;
      api_key?: string;
      username?: string;
      password?: string;
      /** Edge machine config (driver + host + key) — stored encrypted, ridden down
       *  the tunnel so a dynamic-config bridge configures the driver on the fly. */
      config?: Record<string, unknown>;
    },
  ) => request<DigifabConnection>("POST", `/orgs/${slug}/modules/digifab/connections`, body),
  // ── Bambu Lab cloud-login connect wizard ──────────────────────────────────
  bambuLogin: (slug: string, body: { region: string; email: string; password: string }) =>
    request<BambuLoginResponse>("POST", `/orgs/${slug}/modules/digifab/bambu/login`, body),
  bambuCode: (slug: string, body: { session: string; code: string }) =>
    request<BambuLoginResponse>("POST", `/orgs/${slug}/modules/digifab/bambu/code`, body),
  bambuCreate: (slug: string, body: { session: string; mode: BambuMode; label?: string }) =>
    request<{ connection: DigifabConnection; devices: BambuDiscoveredDevice[]; capabilities: BambuModeCapabilities }>(
      "POST",
      `/orgs/${slug}/modules/digifab/bambu/create`,
      body,
    ),
  getBambuCapabilities: (slug: string) =>
    request<{ modes: Record<BambuMode, BambuModeCapabilities> }>("GET", `/orgs/${slug}/modules/digifab/bambu/capabilities`),
  sendBambuCommand: (slug: string, body: { connection_id: string; serial: string; command: "pause" | "resume" | "stop" | "light_on" | "light_off" | "nudge" }) =>
    request<{ sent: boolean }>("POST", `/orgs/${slug}/modules/digifab/bambu/command`, body),
  // ── Generic live controls (driver-declared) ───────────────────────────────
  getDigifabControls: (slug: string, connId: string, deviceId: string) =>
    request<{ controls: DigifabControl[] }>("GET", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/controls`),
  getDigifabFiles: (slug: string, connId: string, deviceId: string, refresh = false) =>
    request<{ files: { name: string; size?: number; modified?: string }[]; cached: boolean; stale?: boolean; at: string }>(
      "GET",
      `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/files${refresh ? "?refresh=1" : ""}`,
    ),
  printDigifabFile: (slug: string, connId: string, deviceId: string, name: string) =>
    request<{ ok: boolean; ref?: string }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/print`, { name }),
  getDigifabFileInfo: (slug: string, connId: string, deviceId: string, name: string) =>
    request<{ info: DigifabFileInfo | null; cached: boolean; stale?: boolean }>(
      "GET",
      `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/fileinfo?name=${encodeURIComponent(name)}`,
    ),
  getDigifabDeviceDetail: (slug: string, connId: string, deviceId: string) =>
    request<DigifabDeviceDetail>("GET", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/detail`),
  // NB: a PATH (no /api/v1) — fetchAuthBlobUrl prepends /api/v1. Including it here
  // double-prefixed the URL → /api/v1/api/v1/… → 404 (the "camera not reachable" bug).
  digifabCameraPath: (slug: string, connId: string, deviceId: string) =>
    `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/camera`,
  setBambuLan: (slug: string, connId: string, deviceId: string, body: { host?: string; access_code?: string; mode?: "cloud" | "prefer_lan" | "lan_only" }) =>
    request<{ ok: boolean; host: string; mode: string }>("PUT", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/lan`, body),
  clearBambuLan: (slug: string, connId: string, deviceId: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/lan`),
  // ── Print-update rules: channels (destinations) + rules ──
  listDigifabChannels: (slug: string) =>
    request<{ items: DigifabChannel[] }>("GET", `/orgs/${slug}/modules/digifab/print-rules/channels`),
  createDigifabChannel: (slug: string, body: { label: string; webhook_url: string }) =>
    request<DigifabChannel>("POST", `/orgs/${slug}/modules/digifab/print-rules/channels`, body),
  patchDigifabChannel: (slug: string, id: string, body: { label?: string; webhook_url?: string; enabled?: boolean }) =>
    request<DigifabChannel>("PATCH", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}`, body),
  deleteDigifabChannel: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}`),
  testDigifabChannel: (slug: string, id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/print-rules/channels/${id}/test`, {}),
  listDigifabRules: (slug: string) =>
    request<{ items: DigifabRule[] }>("GET", `/orgs/${slug}/modules/digifab/print-rules/rules`),
  createDigifabRule: (slug: string, body: Partial<Omit<DigifabRule, "id" | "created_at">>) =>
    request<DigifabRule>("POST", `/orgs/${slug}/modules/digifab/print-rules/rules`, body),
  patchDigifabRule: (slug: string, id: string, body: Partial<Omit<DigifabRule, "id" | "created_at">>) =>
    request<DigifabRule>("PATCH", `/orgs/${slug}/modules/digifab/print-rules/rules/${id}`, body),
  deleteDigifabRule: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/print-rules/rules/${id}`),
  previewDigifabRule: (slug: string, body: { title?: string; body?: string }) =>
    request<{ title: string; body: string }>("POST", `/orgs/${slug}/modules/digifab/print-rules/preview`, body),
  testFireDigifabRule: (slug: string, body: { channel_id: string; message?: { title?: string; body?: string; photo?: boolean }; scope_type?: string; scope_value?: string | null; pre_actions?: DigifabStep[]; post_actions?: DigifabStep[] }) =>
    request<{ ok: boolean; printer: string }>("POST", `/orgs/${slug}/modules/digifab/print-rules/test-fire`, body),
  runDigifabControl: (slug: string, connId: string, deviceId: string, id: string, params?: Record<string, unknown>) =>
    request<{ ok: boolean; ref?: string }>("POST", `/orgs/${slug}/modules/digifab/fleet/${connId}/${encodeURIComponent(deviceId)}/control`, { id, params }),
  /** Edge-bridge pane of glass: workspace agents + the caller's personal agent. */
  getEdgeStatus: (slug: string) =>
    request<{
      agents: Array<{ bridge: string | null; last_seen_ms: number; queued: number; in_flight: number; parked: boolean }>;
      personal: { connected: boolean; backs?: string[] };
      stale_after_ms: number;
    }>("GET", `/orgs/${slug}/edge/status`),
  /** Driver packages this workspace has declared. Carries the source URL, so
   *  it is admin-only and deliberately NOT what a bridge is served. */
  getEdgeDriverDeclarations: (slug: string) =>
    request<{ drivers: EdgeDriverDeclaration[] }>("GET", `/orgs/${slug}/edge/driver-declarations`),
  /** Declare or re-pin a driver. Writes a row; the bridge converges on its own
   *  next poll, so this works while the bridge is offline. */
  declareEdgeDriver: (slug: string, body: EdgeDriverDeclaration) =>
    request<{ ok: boolean; kind: string }>("POST", `/orgs/${slug}/edge/drivers`, body),
  removeEdgeDriver: (slug: string, kind: string, bridgeId?: string | null) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/edge/drivers/${encodeURIComponent(kind)}${bridgeId ? `?bridge=${encodeURIComponent(bridgeId)}` : ""}`,
    ),
  /** Modules that can attach to a bridge — data-driven consumer registry. */
  getEdgeConsumers: (slug: string) =>
    request<{ consumers: Array<{ module: string; label: string; description: string; href: string; enabled: boolean }> }>(
      "GET",
      `/orgs/${slug}/edge/consumers`,
    ),
  testDigifabConnection: (slug: string, id: string) =>
    request<{ ok: boolean; detail?: string; capabilities: { routing: boolean } }>(
      "POST",
      `/orgs/${slug}/modules/digifab/connections/${id}/test`,
      {},
    ),
  listDigifabDevices: (slug: string, id: string) =>
    request<{ items: DigifabDevice[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/connections/${id}/printers`,
    ),
  updateDigifabConnection: (
    slug: string,
    id: string,
    body: { label?: string; base_url?: string; enabled?: boolean; api_key?: string | null; username?: string | null; password?: string | null; config?: Record<string, unknown> },
  ) => request<DigifabConnection>("PATCH", `/orgs/${slug}/modules/digifab/connections/${id}`, body),
  deleteDigifabConnection: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/connections/${id}`),
  // Edge tunnel: is an on-site bridge currently dialed in for this workspace?
  getDigifabEdgeStatus: (slug: string, bridge?: string) =>
    request<{ connected: boolean; last_seen: number | null }>("GET", `/orgs/${slug}/modules/digifab/edge/status${bridge ? `?bridge=${encodeURIComponent(bridge)}` : ""}`),
  // ── Edge-bridge machine sharing (owner side) ──────────────────────────────
  listEdgeShares: (slug: string) =>
    request<{ items: EdgeShare[] }>("GET", `/orgs/${slug}/modules/digifab/edge-shares`),
  createEdgeShare: (slug: string, body: { label: string; scope: "read" | "write"; instance_ids: string[]; expires_in_days?: number }) =>
    request<{ id: string; token: string; owner_org: string; scope: string; machine_count: number; expires_at: string | null }>(
      "POST",
      `/orgs/${slug}/modules/digifab/edge-shares`,
      body,
    ),
  redeemEdgeShare: (slug: string, body: { owner_org: string; token: string }) =>
    request<{ scope: string; machines: { id: string; label: string }[]; already?: boolean }>(
      "POST",
      `/orgs/${slug}/modules/digifab/edge-shares/redeem`,
      body,
    ),
  revokeEdgeShare: (slug: string, id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/edge-shares/${id}/revoke`, {}),
  getDigifabHistory: (slug: string, days = 30) =>
    request<DigifabHistory>("GET", `/orgs/${slug}/modules/digifab/history?days=${days}`),
  // ── AI print-failure detection ────────────────────────────────────────────
  getDigifabFailureConfig: (slug: string) =>
    request<DigifabFailureConfig>("GET", `/orgs/${slug}/modules/digifab/failure/config`),
  setDigifabFailureConfig: (slug: string, patch: Partial<DigifabFailureConfig>) =>
    request<DigifabFailureConfig>("PUT", `/orgs/${slug}/modules/digifab/failure/config`, patch),
  getDigifabFailureStatus: (slug: string, connId: string, deviceId: string) =>
    request<DigifabFailureStatus>("GET", `/orgs/${slug}/modules/digifab/failure/${connId}/${encodeURIComponent(deviceId)}/status`),
  checkDigifabFailure: (slug: string, connId: string, deviceId: string) =>
    request<DigifabFailureCheck>("POST", `/orgs/${slug}/modules/digifab/failure/${connId}/${encodeURIComponent(deviceId)}/check`, {}),
  // ── External detectors (Obico ML API, PrintGuard, generic LAN box) ─────────
  getDigifabDetectorCatalog: (slug: string) =>
    request<{ detectors: DigifabDetectorCatalogEntry[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/catalog`),
  listDigifabDetectors: (slug: string) =>
    request<{ detectors: DigifabDetector[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors`),
  createDigifabDetector: (slug: string, body: DigifabDetectorInput) =>
    request<DigifabDetector>("POST", `/orgs/${slug}/modules/digifab/failure/detectors`, body),
  updateDigifabDetector: (slug: string, id: string, body: Partial<DigifabDetectorInput>) =>
    request<DigifabDetector>("PATCH", `/orgs/${slug}/modules/digifab/failure/detectors/${id}`, body),
  deleteDigifabDetector: (slug: string, id: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/failure/detectors/${id}`),
  testDigifabDetector: (slug: string, id: string) =>
    request<{ ok: boolean; detail?: string; version?: string | null; compatible?: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/test`, {}),
  listDigifabDetectorCameras: (slug: string, id: string) =>
    request<{ cameras: DigifabDetectorCamera[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/cameras`),
  getDigifabDetectorProviders: (slug: string, id: string) =>
    request<{ providers: DigifabDetectorProvider[]; mappings: DigifabDetectorMapping[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/providers`),
  listDigifabDetectorPrinters: (slug: string, id: string) =>
    request<{ printers: DigifabDetectorPrinter[] }>("GET", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers`),
  registerDigifabDetectorPrinter: (slug: string, id: string, body: { name: string; provider: string; config: Record<string, unknown>; watch?: boolean }) =>
    request<{ ok: boolean; printer_id: string | null; camera_id: string | null; monitor: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers`, body),
  mirrorDigifabDetectorPrinter: (slug: string, id: string, body: { connection_id: string; device_id?: string; name?: string; watch?: boolean; disable_source?: boolean }) =>
    request<{ ok: boolean; printer_id: string | null; camera_id: string | null; monitor: boolean; source_disabled?: boolean }>("POST", `/orgs/${slug}/modules/digifab/failure/detectors/${id}/printers/from-connection`, body),
  // ── File library (stored 3MF/gcode + send-to-machine) ─────────────────────
  listDigifabLibrary: (slug: string) =>
    request<{ items: DigifabLibraryItem[] }>("GET", `/orgs/${slug}/modules/digifab/library`),
  uploadDigifabLibrary: async (slug: string, file: File, name?: string): Promise<DigifabLibraryItem> => {
    const form = new FormData();
    form.set("file", file);
    if (name) form.set("name", name);
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/orgs/${slug}/modules/digifab/library`, { method: "POST", headers, body: form });
    if (!res.ok) throw new ApiError(res.status, "upload_failed", await res.text());
    return (await res.json()) as DigifabLibraryItem;
  },
  renameDigifabLibrary: (slug: string, id: string, body: { name?: string; notes?: string | null }) =>
    request<DigifabLibraryItem>("PATCH", `/orgs/${slug}/modules/digifab/library/${id}`, body),
  deleteDigifabLibrary: (slug: string, id: string) =>
    request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/digifab/library/${id}`),
  sendDigifabLibrary: (slug: string, id: string, body: { connection_id?: string; target_device?: string | null; target_pool?: string | null }) =>
    request<{ job_id: string; status: string }>("POST", `/orgs/${slug}/modules/digifab/library/${id}/send`, body),
  // ── core-print (CUPS/IPP printers) ──────────────────────────────
  listPrinters: (slug: string) =>
    request<{ items: Printer[] }>("GET", `/orgs/${slug}/modules/core-print/printers`),
  /** POST to a module path supplied by that module's own action result (the
   *  `ui.print` directive's record callback). Constrained to /modules/ so a
   *  malformed directive cannot be pointed at an arbitrary platform route. */
  postToModulePath: (slug: string, path: string, body: unknown) => {
    if (!path.startsWith("/modules/")) {
      return Promise.reject(new Error(`refusing to POST outside /modules/: ${path}`));
    }
    return request<unknown>("POST", `/orgs/${slug}${path}`, body);
  },
  createPrinter: async (slug: string, body: PrinterInput) => {
    // core-print owns the printer registry and is opt-in. Enable it on demand the
    // first time a workspace adds a printer (idempotent), so printing infra appears
    // exactly when it is needed instead of bloating every workspace.
    await request("POST", `/orgs/${slug}/modules/core-print/enable`, {});
    return request<Printer>("POST", `/orgs/${slug}/modules/core-print/printers`, body);
  },
  updatePrinter: (slug: string, id: string, body: Partial<PrinterInput>) =>
    request<Printer>("PATCH", `/orgs/${slug}/modules/core-print/printers/${id}`, body),
  deletePrinter: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-print/printers/${id}`),
  testPrinter: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; detail?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-print/printers/${id}/test`,
      {},
    ),
  printToPrinter: (
    slug: string,
    id: string,
    body: { file_id?: string; document_base64?: string; content_type?: string; filename?: string; copies?: number; job_name?: string },
  ) =>
    request<{ printer_id: string; jobId: string; state: string }>(
      "POST",
      `/orgs/${slug}/modules/core-print/printers/${id}/print`,
      body,
    ),
  listDigifabDrivers: (slug: string) =>
    request<{ builtins: { key: string; name: string; kind: string }[]; installed: DigifabDriver[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/drivers`,
    ),
  // The "app store" shelf: ready-to-install firmware drivers that ship with
  // digifab (Duet/OctoPrint/Klipper/PrusaLink/…) — one-click install, no JSON.
  getDigifabDriverCatalog: (slug: string) =>
    request<{
      drivers: { id: string; name: string; summary: string; credentialHint: string; kind: string; manifest: unknown }[];
      edgeAdapters: { id: string; name: string; summary: string; credentialHint: string; kind: string }[];
    }>("GET", `/orgs/${slug}/modules/digifab/drivers/catalog`),
  installDigifabDriver: (slug: string, manifest: unknown) =>
    request<DigifabDriver>("POST", `/orgs/${slug}/modules/digifab/drivers`, manifest as object),
  deleteDigifabDriver: (slug: string, key: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/drivers/${encodeURIComponent(key)}`),
  listDigifabLinks: (slug: string) =>
    request<{ items: DigifabLink[] }>("GET", `/orgs/${slug}/modules/digifab/links`),
  createDigifabLink: (
    slug: string,
    body: {
      connection_id: string;
      remote_device_id: string;
      remote_device_name?: string | null;
      machine_id: string;
      machine_label?: string | null;
    },
  ) => request<DigifabLink>("POST", `/orgs/${slug}/modules/digifab/links`, body),
  deleteDigifabLink: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/links/${id}`),
  listDigifabJobs: (slug: string, opts?: { limit?: number; cursor?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.cursor) q.set("cursor", opts.cursor);
    if (opts?.status) q.set("status", opts.status);
    const qs = q.toString();
    return request<{ items: DigifabJob[]; next_cursor: string | null; total?: number }>("GET", `/orgs/${slug}/modules/digifab/jobs${qs ? `?${qs}` : ""}`);
  },
  getDigifabJob: (slug: string, id: string) =>
    request<DigifabJob>("GET", `/orgs/${slug}/modules/digifab/jobs/${id}`),
  cancelDigifabJob: (slug: string, id: string) =>
    request<{ status: string; remote_cancelled: boolean }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/cancel`, {}),
  // Explicit path back from a failed/cancelled job — re-queues + re-sends.
  retryDigifabJob: (slug: string, id: string) =>
    request<{ status: string; sent?: boolean; pooled?: boolean; remote_job_id?: string | null; reason?: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/retry`, {}),
  // "Print this again" — clones a (typically completed) job into a fresh one and sends it.
  reprintDigifabJob: (slug: string, id: string) =>
    request<{ job: DigifabJob; status: string; sent?: boolean; pooled?: boolean; reason?: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/reprint`, {}),
  // Cockpit live-control: pause / resume a running job (501 if the driver can't).
  pauseDigifabJob: (slug: string, id: string) =>
    request<{ status: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/pause`, {}),
  resumeDigifabJob: (slug: string, id: string) =>
    request<{ status: string }>("POST", `/orgs/${slug}/modules/digifab/jobs/${id}/resume`, {}),
  deleteDigifabJob: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/jobs/${id}`),
  createDigifabJob: (
    slug: string,
    body: {
      connection_id?: string;
      file_ref: string;
      target_device?: string | null;
      target_tag?: string | null;
      target_pool?: string | null;
      material_part_id?: string | null;
      material_grams?: number | null;
      material_type?: string | null;
      file_id?: string | null;
      linked_machine_id?: string | null;
      linked_task_id?: string | null;
      /** A build (BoM) this job produces — consumed from inventory on send. */
      linked_build_id?: string | null;
      build_qty?: number;
      priority?: number;
      max_attempts?: number;
    },
  ) => request<DigifabJob>("POST", `/orgs/${slug}/modules/digifab/jobs`, body),
  /** Builds the workspace has defined (for the New-Job "produces a build" picker).
   *  404s when the builds module isn't enabled — callers tolerate an empty list. */
  listDigifabBuilds: (slug: string) =>
    request<{ items: Array<{ id: string; name: string }> }>("GET", `/orgs/${slug}/modules/builds/builds`),
  updateDigifabJob: (slug: string, id: string, body: { priority?: number; max_attempts?: number }) =>
    request<DigifabJob>("PATCH", `/orgs/${slug}/modules/digifab/jobs/${id}`, body),
  // ── Pools: a Cobblr-native set of devices to queue jobs onto (auto-assigned). ──
  // ─── digifab production runs (quantity-driven scheduler on pools) ───
  listDigifabRuns: (slug: string) =>
    request<{ items: DigifabRun[] }>("GET", `/orgs/${slug}/modules/digifab/runs`),
  createDigifabRun: (
    slug: string,
    body: { name: string; pool_id: string; file_id?: string; file_ref?: string; parts_per_plate: number; target_qty: number; material_part_id?: string; material_grams?: number },
  ) => request<{ id: string; status: string }>("POST", `/orgs/${slug}/modules/digifab/runs`, body),
  patchDigifabRun: (slug: string, id: string, body: { status?: "active" | "paused" | "cancelled"; completed_qty?: number }) =>
    request<{ id: string; status: string; completed_qty: number }>("PATCH", `/orgs/${slug}/modules/digifab/runs/${id}`, body),
  listDigifabPools: (slug: string) =>
    request<{ items: DigifabPool[] }>("GET", `/orgs/${slug}/modules/digifab/pools`),
  createDigifabPool: (slug: string, name: string) =>
    request<DigifabPool>("POST", `/orgs/${slug}/modules/digifab/pools`, { name }),
  deleteDigifabPool: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/pools/${id}`),
  addDigifabPoolMember: (slug: string, poolId: string, connection_id: string, remote_device_id: string) =>
    request<{ ok: boolean }>("POST", `/orgs/${slug}/modules/digifab/pools/${poolId}/members`, {
      connection_id,
      remote_device_id,
    }),
  removeDigifabPoolMember: (slug: string, poolId: string, connectionId: string, deviceId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/digifab/pools/${poolId}/members/${connectionId}/${encodeURIComponent(deviceId)}`,
    ),
  // Migrate an FDM Monster farm in: "direct" recreates each printer as its own
  // connection (drops FDMM); "mirror" keeps FDMM + pools its printers.
  importDigifabFdmMonster: (
    slug: string,
    body: { base_url: string; api_key?: string; username?: string; password?: string; mode: "direct" | "mirror"; pool_name: string },
  ) =>
    request<{ mode: string; pool_id: string; pool_name: string; created?: number; skipped?: number; mirrored?: number }>(
      "POST",
      `/orgs/${slug}/modules/digifab/import/fdm-monster`,
      body,
    ),
  bulkAddDigifabConnections: (
    slug: string,
    body: {
      default_type: string;
      pool_name?: string;
      test?: boolean;
      printers: { name?: string; url: string; api_key?: string; username?: string; password?: string; type?: string }[];
    },
  ) =>
    request<{
      created: number;
      failed: number;
      pool_id?: string;
      pool_name?: string;
      results: { index: number; name: string; url: string; type: string; status: "created" | "failed"; connection_id?: string; reachable?: boolean; detail?: string }[];
    }>("POST", `/orgs/${slug}/modules/digifab/bulk/connections`, body),
  detectDigifabType: (slug: string, body: { url: string; api_key?: string }) =>
    request<{ type: string | null; detail: string }>("POST", `/orgs/${slug}/modules/digifab/bulk/detect`, body),
  // Slicer metadata (filament material + grams) parsed from a stored file, to
  // pre-fill the New-job form instead of asking the operator to retype it.
  getDigifabSlicerMeta: (slug: string, fileId: string) =>
    request<{ material: string | null; filament_g: number | null; estimated_sec: number | null }>(
      "GET",
      `/orgs/${slug}/modules/digifab/files/${fileId}/slicer-meta`,
    ),
  sendDigifabJob: (slug: string, id: string) =>
    request<{ status: string; remote_job_id: string | null; placement: unknown; uploaded_bytes?: number }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/send`,
      {},
    ),
  // F-14 — re-pick a printer for an awaiting-assignment job (re-submits the
  // already-uploaded file to an explicit device; no re-upload).
  assignDigifabJob: (slug: string, id: string, deviceId: string) =>
    request<{ status: string; remote_job_id: string | null; placement: unknown }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/assign`,
      { device_id: deviceId },
    ),
  pollDigifabJob: (slug: string, id: string) =>
    request<{ status: string; terminal: boolean }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/poll`,
      {},
    ),

  // ─── core-maintenance (workspace-wide service log) ────────────────
  listMaintenance: (
    slug: string,
    params?: {
      kind?: "history" | "scheduled" | "all";
      due_within_days?: number;
      limit?: number;
    },
  ) => {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set("kind", params.kind);
    if (params?.due_within_days != null)
      qs.set("due_within_days", String(params.due_within_days));
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return request<{ items: MaintenanceEntry[] }>(
      "GET",
      `/orgs/${slug}/modules/core-maintenance/entries${q ? `?${q}` : ""}`,
    );
  },
  updateMaintenance: (
    slug: string,
    id: string,
    body: Partial<{
      name: string;
      description: string | null;
      performed_at: string | null;
      scheduled_at: string | null;
      cost_cents: number | null;
      notes: string | null;
      recurrence_rule: string | null;
    }>,
  ) =>
    request<MaintenanceEntry>(
      "PATCH",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}`,
      body,
    ),
  completeMaintenance: (slug: string, id: string, performed_at?: string) =>
    request<MaintenanceEntry>(
      "POST",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}/complete`,
      performed_at ? { performed_at } : {},
    ),
  deleteMaintenance: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-maintenance/entries/${id}`,
    ),

  // ─── labels: QR scan tokens (merged from core-labels-qr) ──────────
  listQrTokens: (slug: string) =>
    request<{ items: QrToken[] }>(
      "GET",
      `/orgs/${slug}/modules/labels/qr/tokens`,
    ),
  revokeQrToken: (slug: string, id: string) =>
    request<QrToken>(
      "POST",
      `/orgs/${slug}/modules/labels/qr/tokens/${id}/revoke`,
    ),
  getQrSettings: (slug: string) =>
    request<QrSettings>(
      "GET",
      `/orgs/${slug}/modules/labels/qr/settings`,
    ),
  setQrTokenStyle: (slug: string, token_style: "descriptive" | "opaque") =>
    request<QrSettings>(
      "PUT",
      `/orgs/${slug}/modules/labels/qr/settings`,
      { token_style },
    ),
  /** Set (or clear, with "") the custom base URL printed QR codes encode. */
  setQrLabelBaseUrl: (slug: string, label_base_url: string) =>
    request<QrSettings>(
      "PUT",
      `/orgs/${slug}/modules/labels/qr/settings`,
      { label_base_url },
    ),

  // ─── core-healthcheck ─────────────────────────────────────────────
  healthSnapshot: (slug: string) =>
    request<{
      status: "ok" | "degraded" | "error";
      probes: Record<string, { status: string; message?: string; detail?: unknown }>;
    }>("GET", `/orgs/${slug}/modules/core-healthcheck/snapshot`),

  // ─── M1 cross-workspace links ─────────────────────────────────────
  listWorkspaceLinks: () =>
    request<{ items: WorkspaceLinkItem[] }>("GET", "/me/links"),
  createWorkspaceLink: (body: {
    source_org_id: string;
    target_org_id: string;
    kinds: string[];
    expires_at?: string | null;
    min_target_role?: "owner" | "admin" | "editor" | "member" | "guest" | null;
  }) => request<WorkspaceLinkItem>("POST", "/me/links", body),
  acceptWorkspaceLink: (id: string) =>
    request<WorkspaceLinkItem>("POST", `/me/links/${id}/accept`),
  revokeWorkspaceLink: (id: string) =>
    request<void>("POST", `/me/links/${id}/revoke`),
  patchWorkspaceLink: (
    id: string,
    body: {
      expires_at?: string | null;
      min_target_role?: "owner" | "admin" | "editor" | "member" | "guest" | null;
    },
  ) => request<WorkspaceLinkItem>("PATCH", `/me/links/${id}`, body),

  // ─── D4 entity pairings — polymorphic links without firing a wire ─
  listPairings: (
    slug: string,
    filter: Partial<{
      source_kind: string;
      source_id: string;
      target_kind: string;
      target_id: string;
      relationship_kind: string;
    }> = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (typeof v === "string" && v.length > 0) qs.set(k, v);
    }
    const tail = qs.toString();
    return request<{ items: PairingItem[] }>(
      "GET",
      `/orgs/${slug}/pairings${tail ? `?${tail}` : ""}`,
    );
  },
  createPairing: (
    slug: string,
    body: {
      source_kind: string;
      source_id: string;
      target_kind: string;
      target_id: string;
      relationship_kind: string;
      notes?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) => request<PairingItem>("POST", `/orgs/${slug}/pairings`, body),
  deletePairing: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/pairings/${id}`),

  // Instances (workspace_module_instances) — multi-instance modules.
  // A workspace can install one module multiple times under different
  // names. See docs/architecture/instances.md.
  listInstances: (slug: string, moduleName?: string) =>
    request<{ items: ModuleInstance[] }>(
      "GET",
      `/orgs/${slug}/instances${moduleName ? `?module=${encodeURIComponent(moduleName)}` : ""}`,
    ),
  createInstance: (
    slug: string,
    body: { module_name: string; instance_name: string; display_name: string },
  ) =>
    request<ModuleInstance>("POST", `/orgs/${slug}/instances`, body),
  deleteInstance: (slug: string, instanceName: string) =>
    request<void>("DELETE", `/orgs/${slug}/instances/${instanceName}`),

  // Nav-builder #2 — user-defined navbar headings (org-wide). Group nav
  // entries (modules + instances) under custom headings, cross-module.
  // See docs/architecture/nav-builder.md.
  listNavHeadings: (slug: string) =>
    request<{ items: NavHeading[] }>("GET", `/orgs/${slug}/nav-headings`),
  createNavHeading: (slug: string, body: { name: string; icon?: string | null }) =>
    request<{ id: string }>("POST", `/orgs/${slug}/nav-headings`, body),
  updateNavHeading: (
    slug: string,
    id: string,
    body: { name?: string; icon?: string | null; position?: number },
  ) => request<void>("PATCH", `/orgs/${slug}/nav-headings/${id}`, body),
  deleteNavHeading: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/nav-headings/${id}`),
  addNavHeadingMember: (
    slug: string,
    headingId: string,
    body: { target_kind: "module" | "instance"; target_id: string },
  ) => request<void>("POST", `/orgs/${slug}/nav-headings/${headingId}/members`, body),
  removeNavHeadingMember: (slug: string, targetKind: string, targetId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/nav-headings/members/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}`,
    ),

  // Workspace presentation overrides — rename / hide / re-icon / reorder
  // for any nav entry (entity kind, instance, bundle).
  listOverrides: (slug: string) =>
    request<{ items: EntityKindOverride[] }>(
      "GET",
      `/orgs/${slug}/entity-kind-overrides`,
    ),
  upsertOverride: (
    slug: string,
    body: {
      target_kind: "entity_kind" | "instance" | "bundle";
      target_id: string;
      display_label?: string | null;
      display_label_plural?: string | null;
      icon?: string | null;
      hidden?: boolean;
      nav_order?: number | null;
      config?: Record<string, unknown>;
    },
  ) =>
    request<EntityKindOverride>("PUT", `/orgs/${slug}/entity-kind-overrides`, body),
  deleteOverride: (slug: string, targetKind: string, targetId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/entity-kind-overrides/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}`,
    ),

  // core-integrations — outbound + inbound connectors. See
  // docs/modules/core-integrations.md.
  listConnectorCatalogue: (slug: string) =>
    request<{ items: IntegrationConnectorDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors/catalogue`,
    ),
  listConnectors: (slug: string) =>
    request<{ items: IntegrationConnector[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors`,
    ),
  createConnector: (
    slug: string,
    body: {
      connector_id: string;
      label: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
    },
  ) =>
    request<IntegrationConnector>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors`,
      body,
    ),
  updateConnector: (
    slug: string,
    id: string,
    body: {
      label?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<IntegrationConnector>(
      "PATCH",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}`,
      body,
    ),
  deleteConnector: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}`,
    ),
  testConnector: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}/test`,
    ),
  invokeConnector: (
    slug: string,
    id: string,
    body: { action_id: string; args?: Record<string, unknown>; rendered?: string },
  ) =>
    request<{ ok: boolean; ms: number; result: unknown }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/connectors/${id}/invoke`,
      body,
    ),
  listIntegrationCalls: (slug: string, limit = 50) =>
    request<{ items: IntegrationCall[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/connectors/calls?limit=${limit}`,
    ),
  listInboundHandlers: (slug: string) =>
    request<{ items: InboundHandlerDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/handlers`,
    ),
  listInboundTokens: (slug: string) =>
    request<{ items: InboundToken[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens`,
    ),
  createInboundToken: (
    slug: string,
    body: { connector_id: string; label: string; config?: Record<string, unknown> },
  ) =>
    request<InboundToken>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens`,
      body,
    ),
  revokeInboundToken: (slug: string, id: string) =>
    request<InboundToken>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/${id}/revoke`,
    ),
  deleteInboundToken: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/inbound-tokens/${id}`,
    ),

  // core-integrations sync connectors — mirror an external system's records
  // into a Cobblr entity kind (live webhook + reconcile poll).
  listSyncConnectors: (slug: string) =>
    request<{ items: SyncConnectorDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connectors`,
    ),
  // This workspace's connected edge bridges (default + named) — for the shared
  // bridge picker. Served by digifab's relay, which all edge transport rides.
  listEdgeBridges: (slug: string) =>
    request<{ bridges: EdgeBridge[]; direct?: DirectEdgeBridge[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/edge/bridges`,
    ),
  // Installed declarative sync-source manifests (the user-installable "drivers").
  listSyncSources: (slug: string) =>
    request<{ installed: SyncSourceDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync-sources`,
    ),
  installSyncSource: (slug: string, manifest: Record<string, unknown>) =>
    request<SyncSourceDef>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync-sources`,
      manifest,
    ),
  uninstallSyncSource: (slug: string, sourceId: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/sync-sources/${encodeURIComponent(sourceId)}`,
    ),
  listSyncConnections: (slug: string) =>
    request<{ items: SyncConnection[] }>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connections`,
    ),
  createSyncConnection: (
    slug: string,
    body: { connector_id: string; label: string; base_url?: string; credentials: Record<string, unknown>; transport?: "direct" | "edge"; bridge?: string | null; target_instances?: Record<string, string> },
  ) =>
    request<SyncConnection & { webhook_path: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections`,
      body,
    ),
  getSyncConnection: (slug: string, id: string) =>
    request<SyncConnectionDetail>(
      "GET",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
    ),
  updateSyncConnection: (
    slug: string,
    id: string,
    body: { label?: string; base_url?: string; credentials?: Record<string, unknown>; enabled?: boolean },
  ) =>
    request<{ ok: boolean }>(
      "PATCH",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
      body,
    ),
  deleteSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "DELETE",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}`,
    ),
  archiveSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/archive`,
    ),
  unarchiveSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/unarchive`,
    ),
  testSyncConnection: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; note?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/test`,
    ),
  configureSync: (slug: string, id: string, entityType: string, body: { enabled: boolean; cadence_min?: number }) =>
    request<{ ok: boolean }>(
      "PUT",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}`,
      body,
    ),
  runSync: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; result?: SyncRunResult; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/run`,
    ),
  previewSyncImport: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; plan?: ImportPlan; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/preview`,
    ),
  runSyncImport: (slug: string, id: string, entityType: string) =>
    request<{ ok: boolean; result?: SyncRunResult; error?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-integrations/sync/connections/${id}/syncs/${encodeURIComponent(entityType)}/import`,
    ),

  // core-scan — the identifier-decoder registry. Hand it a typed/scanned
  // identifier (a VIN today; any registered decoder tomorrow); it dispatches by
  // the code's shape, decodes against the external source, and returns a flat
  // semantic field bag to map onto a record by role. Powers the guarded-auto
  // VIN fill on the entity form. See docs/design-decisions/vin-decode.md.
  decodeIdentifier: (slug: string, code: string) =>
    request<{
      outcome: "hit" | "partial" | "miss" | "unavailable";
      fields: Record<string, string | number>;
      provenance: string | null;
      note?: string;
    }>("POST", `/orgs/${slug}/modules/core-scan/decode`, { code }),
  // core-scan — barcode + photo identification, generalized. See
  // docs/modules/core-scan.md.
  /** File a scanned code as a UNIT (serial) of a model, from the scanner's
   *  ?unitOf flow — the mint endpoint on inventory's parts router. Instance vs
   *  default picks the path (parts vs instance items). Does not touch the
   *  model's qty; see docs/design-decisions/within-instance-units.md. */
  mintScannedUnit: (
    slug: string,
    args: { modelId: string; instance?: string | null; serial: string },
  ) =>
    request<{ id: string; name: string; serial_number: string | null }>(
      "POST",
      args.instance
        ? `/orgs/${slug}/instances/${args.instance}/items/${args.modelId}/units`
        : `/orgs/${slug}/modules/inventory/parts/${args.modelId}/units`,
      { serial_number: args.serial },
    ),
  scanBarcode: (
    slug: string,
    body: {
      barcode?: string;
      source_kind?: "barcode" | "photo" | "url" | "receipt";
      source_url?: string;
      image_file_id?: string;
      scan_batch_id?: string;
      scan_area?: string;
      target_location_id?: string;
      target_container_kind?: string;
      target_container_id?: string;
      enrich_ms?: number;
    },
  ) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/scan`, body),
  // External QR resolver (the redirect table for foreign labels). The camera
  // reads the rules once to know whether to bother resolving; resolveExternal is
  // the synchronous "is this a known foreign QR? where does it go?" call on a
  // non-native scan. See docs/design-decisions/external-qr-resolver.md.
  scanQrRules: (slug: string) =>
    request<{ rules: ScanQrRule[] }>("GET", `/orgs/${slug}/modules/core-scan/qr-rules`),
  createScanQrRule: (slug: string, body: Omit<ScanQrRule, "id" | "created_at" | "updated_at">) =>
    request<{ rule: ScanQrRule }>("POST", `/orgs/${slug}/modules/core-scan/qr-rules`, body),
  updateScanQrRule: (slug: string, id: string, body: Partial<ScanQrRule>) =>
    request<{ rule: ScanQrRule }>("PATCH", `/orgs/${slug}/modules/core-scan/qr-rules/${id}`, body),
  deleteScanQrRule: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-scan/qr-rules/${id}`),
  reorderScanQrRules: (slug: string, ids: string[]) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/qr-rules/reorder`, { ids }),
  // Resolve a native /qr/<token> to its target {entity_kind, entity_id, org_slug}
  // WITHOUT navigating — lets the scanner branch (e.g. a location → set the filing
  // bin) before falling back to the normal navigate. Unauthenticated, the same
  // JSON the /qr/:token page reads.
  resolveQrToken: (token: string) =>
    // Per-segment encode so a descriptive token's slash survives the path.
    fetch(`/api/v1/qr/${token.split("/").map(encodeURIComponent).join("/")}`, { headers: { accept: "application/json" } })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              org_slug?: string;
              entity_kind?: string;
              entity_id?: string;
              detail_path?: string;
              mode?: string;
            }>)
          : null,
      )
      .catch(() => null),
  scanResolveExternal: (slug: string, value: string) =>
    request<ScanResolveOutcome>("POST", `/orgs/${slug}/modules/core-scan/resolve-external`, { value }),
  /** The resolvable registry (docs/design-decisions/resolvable-registry.md): what
   *  a value could mean on a surface. The palette uses surface:"palette" to rank
   *  an exact identifier hit above fuzzy text results. */
  resolveOnSurface: (slug: string, value: string, surface: "scan" | "palette" | "search") =>
    request<RegistryResolveOutcome>("POST", `/orgs/${slug}/resolve`, { value, surface }),
  listScanInbox: (
    slug: string,
    q: {
      status?: "pending" | "enriching" | "resolved" | "discarded";
      batch_id?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.status) params.set("status", q.status);
    if (q.batch_id) params.set("batch_id", q.batch_id);
    if (q.limit) params.set("limit", String(q.limit));
    if (q.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return request<{
      items: ScanInboxItem[];
      /** Session labels keyed by scan_batch_id — the inbox group header + the
       *  receipt's stored original (for View original / Re-parse). */
      batches?: Record<string, { label: string | null; origin: string | null; source_file_id: string | null; order_ref: string | null; tracking_number: string | null }>;
      next_cursor?: string | null;
      total?: number;
    }>("GET", `/orgs/${slug}/modules/core-scan/inbox${qs ? "?" + qs : ""}`);
  },
  getScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>("GET", `/orgs/${slug}/modules/core-scan/inbox/${id}`),
  /** Re-run the receipt parser on a session's stored original, replacing its
   *  still-pending lines with a fresh parse. */
  reparseReceipt: (slug: string, batchId: string) =>
    request<{ receipt: { item_count: number; vendor: string | null }; items: Array<{ id: string }> }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/scan/receipt/reparse`,
      { batch_id: batchId },
    ),
  /** Set/clear a receipt session's order (invoice) number — recomputes its label. */
  setReceiptOrderRef: (slug: string, batchId: string, orderRef: string | null) =>
    request<{ id: string; label: string | null; order_ref: string | null }>(
      "PATCH",
      `/orgs/${slug}/modules/core-scan/scan/receipt/${batchId}/order-ref`,
      { order_ref: orderRef },
    ),
  /** Set/clear the tracking number for the parcel a receipt session describes.
   *  Filing a receipt that carries one records the order as still in transit,
   *  so it gets followed instead of being closed on arrival at the doorstep. */
  setReceiptTracking: (slug: string, batchId: string, trackingNumber: string | null) =>
    request<{ id: string; tracking_number: string | null }>(
      "PATCH",
      `/orgs/${slug}/modules/core-scan/scan/receipt/${batchId}/tracking`,
      { tracking_number: trackingNumber },
    ),
  /** Light in-the-moment edits the camera modal makes — quantity, name. */
  updateScanItem: (
    slug: string,
    id: string,
    body: {
      quantity?: number;
      name?: string;
      target_location_id?: string | null;
      box_state?: "item-in-box" | "empty-box" | null;
      reviewed?: boolean;
      /** Answer to "this photo has N different things — keep them together, or
       *  split?" true = one record; the offer stops asking. */
      keep_grouped?: boolean;
    },
  ) => request<ScanInboxItem>("PATCH", `/orgs/${slug}/modules/core-scan/inbox/${id}`, body),
  /** Guided Organize: propose a grouped put-away plan — for a selection of
   *  inbox items, or (scope:"unplaced") for committed entities with no home. */
  organizePlan: (
    slug: string,
    body: {
      item_ids?: string[];
      scan_batch_id?: string;
      scope?: "unplaced" | "pending" | "refs";
      /** For scope:"refs" — the "<kind>::<uuid>" refs to plan (a specific pile,
       *  e.g. the parts a disassemble just spawned). */
      refs?: string[];
      /** Ground truth typed by the human — folded into the AI plan call. */
      hint?: string;
      /** Pre-compute the scope:"pending" plan (fingerprint-deduped server-side)
       *  so opening the sheet reveals a ready plan. */
      warm?: boolean;
      /** Bypass the draft cache (the explicit Re-plan button). */
      fresh?: boolean;
      /** Stop carrying the session hint forward. */
      clear_hint?: boolean;
    },
  ) => request<OrganizePlanResponse>("POST", `/orgs/${slug}/modules/core-scan/organize/plan`, body),
  /** Cheap inbox counts for the put-away front door (dashboard card / scan
   *  strip): pending captures, and how many still have no home. */
  getScanStats: (slug: string) =>
    request<{ pending: number; unfiled: number; ready: number }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/stats`,
    ),
  /** Receipt sessions imported but not yet confirmed into a purchase order. */
  getPendingReceiptGroups: (slug: string) =>
    request<{
      groups: Array<{
        groupId: string;
        vendor: string | null;
        /** Order / invoice number when the receipt stated one - what tells two
         *  receipts from the same vendor apart. */
        orderRef: string | null;
        /** The parcel's tracking number, when one has been recorded. Its
         *  presence is what files the receipt as still in transit. */
        trackingNumber: string | null;
        count: number;
      }>;
      total_items: number;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/receipt-groups/pending`,
    ),
  /** Guided Organize: accept groups (optionally overriding destinations). */
  organizeApply: (
    slug: string,
    body: {
      plan_id: string;
      group_ids: string[];
      overrides?: Array<{
        group_id: string;
        location_id?: string;
        new_location?: { name: string; parent_id?: string | null };
        /** Items split out of the group ("not related") — not filed. */
        exclude_item_ids?: string[];
      }>;
    },
  ) => request<OrganizeApplyResponse>("POST", `/orgs/${slug}/modules/core-scan/organize/apply`, body),
  /** Guided Organize: the most recent unexpired plan (put-away-walk resume). */
  getLatestOrganizePlan: (slug: string) =>
    request<{ plan: OrganizeStoredPlan | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/organize/plan/latest`,
    ),
  /** Put-away sessions (the shared execution engine): start/resume one.
   *  plan_id set = plan mode (the walk; idempotent per plan, returns the
   *  authoritative placed list). plan_id absent = LIVE mode (Live Sort;
   *  idempotent per user, returns the session's entries). */
  startPutaway: (
    slug: string,
    body: { plan_id?: string; catch_all_location_id?: string | null },
  ) =>
    request<{
      session_id: string;
      mode: "plan" | "live";
      plan_id?: string;
      catch_all_location_id?: string | null;
      placed_item_ids?: string[];
      entries?: LiveSortEntry[];
      resumed: boolean;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/start`, body),
  /** Live Sort: route an intaken inbox item → a destination directive. */
  putawayScan: (slug: string, sessionId: string, body: { inbox_item_id: string }) =>
    request<{
      entry?: LiveSortEntry;
      already_confirmed?: boolean;
      already_placed?: { location_id: string; location_name: string | null; name: string | null };
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/scan`, body),
  /** Live Sort: the one confirm gesture (override location wins). */
  putawayConfirm: (
    slug: string,
    sessionId: string,
    body: { entry_id: string; location_id?: string },
  ) =>
    request<{ entry: LiveSortEntry }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/confirm`,
      body,
    ),
  /** Live Sort: create numbered "Bin N" locations as the session's bind
   *  pool (+ optionally an "Unsorted" catch-all). Zero-hardware on-ramp. */
  setupPutawayBins: (
    slug: string,
    sessionId: string,
    body: { count: number; include_catch_all?: boolean; parent_id?: string | null },
  ) =>
    request<{
      created: Array<{ id: string; name: string }>;
      catch_all_location_id: string | null;
      bind_pool_size: number;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/setup-bins`, body),
  /** Live Sort: revert a confirm. */
  putawayUndo: (slug: string, sessionId: string, body: { entry_id: string }) =>
    request<{ entry: LiveSortEntry }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/undo`,
      body,
    ),
  /** The caller's active put-away session (resume chips). */
  getPutawayCurrent: (slug: string) =>
    request<{
      session: {
        session_id: string;
        mode: "plan" | "live";
        plan_id: string | null;
        catch_all_location_id: string | null;
        entries?: LiveSortEntry[];
        placed_item_ids?: string[];
        created_at: string;
      } | null;
    }>("GET", `/orgs/${slug}/modules/core-scan/putaway/current`),
  /** Put-away sessions: persist walk progress (idempotent replace). */
  setPutawayState: (slug: string, sessionId: string, body: { placed_item_ids: string[] }) =>
    request<{ placed_item_ids: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/state`,
      body,
    ),
  /** Put-away sessions: close one (fires the summary event; live sessions
   *  return the sorted/by-bin/straggler summary). */
  endPutaway: (slug: string, sessionId: string) =>
    request<{
      ended: boolean;
      placed_count?: number;
      sorted?: number;
      stragglers?: number;
      by_bin?: Array<{ location_id: string; location_name: string; count: number }>;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/end`),
  /** Fold one scan session into another (batch merge). */
  mergeScanBatches: (slug: string, fromBatchId: string, intoBatchId: string) =>
    request<{ moved: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/merge-batches`, {
      from_batch_id: fromBatchId,
      into_batch_id: intoBatchId,
    }),
  /** Move specific items into a batch — the Undo path for a merge. */
  reassignScanBatch: (slug: string, itemIds: string[], batchId: string) =>
    request<{ moved: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/reassign-batch`, {
      item_ids: itemIds,
      batch_id: batchId,
    }),
  /** Fill catalog images for pending items with no art (search by name), AND
   *  localize any item stuck on a catalog URL with no local file. */
  backfillScanCatalogPhotos: (slug: string) =>
    request<{ queued: number; localized: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/backfill-catalog-photos`),
  /** Bulk import (inbox-export interop + generic CSV). `file` is the picked File;
   *  mapping only matters for plain CSVs. */
  scanImportPreview: async (slug: string, file: File, mapping?: Record<string, string>) => {
    const form = new FormData();
    form.set("file", file);
    if (mapping) form.set("mapping", JSON.stringify(mapping));
    const token = getToken();
    const res = await fetch(`/api/v1/orgs/${slug}/modules/core-scan/import/preview`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new ApiError(res.status, "import_preview_failed", await res.text());
    return (await res.json()) as {
      source: string | null;
      source_instance: string | null;
      count: number;
      columns: Array<{ header: string; field: string | null }> | null;
      errors: Array<{ row: number; field: string; message: string }>;
      rows: Array<{ row: number; name: string | null; barcode: string | null; status: string; source_kind: string; quantity: number; scan_area: string | null; hint_category: unknown; has_photo: boolean }>;
    };
  },
  scanImport: async (
    slug: string,
    file: File,
    opts: { dryRun?: boolean; duplicatePolicy?: "skip" | "append" | "replace"; fetchPhotos?: boolean; mapping?: Record<string, string> },
  ) => {
    const form = new FormData();
    form.set("file", file);
    if (opts.mapping) form.set("mapping", JSON.stringify(opts.mapping));
    const qs = new URLSearchParams();
    if (opts.dryRun) qs.set("dry_run", "true");
    if (opts.duplicatePolicy) qs.set("duplicate_policy", opts.duplicatePolicy);
    if (opts.fetchPhotos === false) qs.set("fetch_photos", "false");
    const token = getToken();
    const res = await fetch(`/api/v1/orgs/${slug}/modules/core-scan/import?${qs.toString()}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) throw new ApiError(res.status, "import_failed", await res.text());
    return (await res.json()) as {
      imported_count: number;
      skipped_count: number;
      errors: Array<{ row: number; field: string; message: string }>;
      created_ids: string[];
      photos_fetched: number;
      photos_failed: number;
      dry_run?: boolean;
    };
  },
  confirmScanItem: (
    slug: string,
    id: string,
    body: {
      target_module?: string;
      target_kind?: string;
      /** Commit into a module INSTANCE (e.g. the "yarn" inventory instance)
       *  instead of the default — the backend routes the create to
       *  /instances/:name/items, scoping the new entity to that instance. */
      instance?: string;
      name?: string;
      location_id?: string;
      quantity?: number;
      /** Tags to attach to the created entity (union'd with pending_tags). */
      tags?: string[];
      extras?: Record<string, unknown>;
      /** Platform-admin only: also record this commit as a matchmaker eval
       *  case (the corrected answer = ground truth). Ignored for non-admins. */
      save_eval_case?: boolean;
      eval_note?: string;
    },
  ) =>
    request<{ item: ScanInboxItem; created: { id: string } }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm`,
      body,
    ),
  /** Paired-scan: the scanned product IS the active bin itself — write the
   *  product identity onto that core-locations record instead of creating a
   *  new entity. location_id overrides the bin the scan was filed into. */
  confirmScanIntoLocation: (slug: string, id: string, location_id?: string) =>
    request<{ item: ScanInboxItem; location_id: string }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm-into-location`,
      location_id ? { location_id } : {},
    ),
  // Super-admin: captured matchmaker eval cases (P2 of the eval harness).
  listScanEvalCases: () =>
    request<{ items: ScanEvalCase[] }>("GET", "/super-admin/scan-eval-cases"),
  deleteScanEvalCase: (orgId: string, id: string) =>
    request<void>("DELETE", `/super-admin/scan-eval-cases/${orgId}/${id}`),
  discardScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/discard`,
    ),
  /** Revert a commit: send a resolved scan back to the pending inbox
   *  (deletes the CREATED entity through its module; never touches a
   *  pre-existing entity the scan merely attached to). */
  unconfirmScanItem: (slug: string, id: string) =>
    request<{ item: ScanInboxItem; entity_deleted: boolean; note: string | null }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/unconfirm`,
    ),
  restoreScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/restore`,
    ),
  // Capture-first "write something down": free text → a note capture the
  // matchmaker identifies against the flagship bundle menu.
  scanNote: (slug: string, text: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/scan/note`, { text }),
  // The caller's per-workspace receipt-forwarding address (null/unconfigured
  // when the operator hasn't wired up the receipts@ Email Worker).
  getReceiptAddress: (slug: string) =>
    request<{ configured: boolean; address: string | null }>(
      "GET",
      `/orgs/${slug}/receipt-address`,
    ),
  // Parse an uploaded receipt (CSV / PDF / photo) into one inbox row per line
  // item — each then triages into a part via the normal confirm flow. CSV and
  // text-PDF tables parse deterministically (no AI); everything else falls to AI.
  scanReceipt: (slug: string, file_id: string, opts?: { force?: boolean; origin?: "email" | "upload" }) =>
    request<
      | {
          receipt: {
            vendor: string | null;
            date: string | null;
            currency: string | null;
            total: number | null;
            item_count: number;
            method: "csv" | "pdf-table" | "ai-chat" | "ai-vision";
          };
          items: ScanInboxItem[];
          duplicate?: undefined;
        }
      | {
          duplicate: true;
          existing: { batch_id: string; label: string | null; vendor: string | null; order_ref: string | null; item_count: number };
        }
    >("POST", `/orgs/${slug}/modules/core-scan/scan/receipt`, {
      file_id,
      ...(opts?.force ? { force: true } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
    }),
  // Collapse a receipt's pending lines into ONE purchases order (vendor + line
  // items) instead of N orphan parts. Each line is still confirmed into a part;
  // the order links them. Degrades to parts-only if purchases isn't enabled.
  confirmReceiptGroup: (slug: string, groupId: string) =>
    request<{
      order_id: string | null;
      vendor: string | null;
      confirmed: Array<{ itemId: string; partId?: string | null; error?: string }>;
    }>("POST", `/orgs/${slug}/modules/core-scan/receipt-group/${groupId}/confirm`, {}),
  // Pending captures grouped by the bundle they fit ("These look like yarn (3)").
  quickstart: (slug: string) =>
    request<QuickstartSuggestions>("GET", `/orgs/${slug}/quickstart`),
  // Install a flagship bundle + batch-commit the captures that fit it.
  materializeQuickstart: (
    slug: string,
    bundle_external_id: string,
    opts?: { item_ids?: string[]; skip_install?: boolean },
  ) =>
    request<QuickstartMaterializeResult>("POST", `/orgs/${slug}/quickstart/materialize`, {
      bundle_external_id,
      ...(opts?.item_ids ? { item_ids: opts.item_ids } : {}),
      ...(opts?.skip_install ? { skip_install: true } : {}),
    }),
  /** Re-run the scan pipeline on one inbox item.
   *
   *  `noAi` REPLAYS it instead: every model stage is served from the AI cache,
   *  and a stage with no cached reply degrades (the matchmaker drops to keyword
   *  routing) rather than calling out — free, instant, and it re-runs all our
   *  DETERMINISTIC code (reply parsers, pack-size, the split derivation, keyword
   *  routing, decoder role-fill, field mapping) against the model's previous
   *  answers. It cannot test a PROMPT change: the cache is keyed on the input
   *  (the image), not the prompt, so a cached reply answers the prompt that was
   *  live when it was bought. */
  rerunScanAi: (
    slug: string,
    id: string,
    opts: {
      hint?: string | undefined;
      wrong?: boolean | undefined;
      enrich?: boolean | undefined;
      imageFileId?: string | undefined;
      /** The corrected barcode - replaces barcode_text and re-runs the lookup. */
      barcode?: string | undefined;
      noAi?: boolean | undefined;
    } = {},
  ) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/rerun-ai`,
      {
        ...(opts.hint ? { hint: opts.hint } : {}),
        ...(opts.wrong ? { wrong: true } : {}),
        ...(opts.enrich ? { enrich: true } : {}),
        ...(opts.imageFileId ? { image_file_id: opts.imageFileId } : {}),
        ...(opts.barcode ? { barcode: opts.barcode } : {}),
        ...(opts.noAi ? { no_ai: true } : {}),
      },
    ),
  // "This listing is good — lock it in": verify the current name/brand/category/
  // photo into the shared barcode database for every future scan of this UPC.
  confirmScanBarcode: (slug: string, id: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm-barcode`),
  // "Already tracked?" — entities the workspace already has matching this scan
  // (exact barcode / name overlap), and attach-to-existing instead of duplicating.
  scanTrackedMatches: (slug: string, id: string) =>
    request<{ barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[] }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/tracked-matches`,
    ),
  /** Put back the answer the last re-run overwrote (restores metadata.pre_rerun). */
  scanUndoRerun: (slug: string, id: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/undo-rerun`),
  /** Single-SKU bin: what lives in this bin + direct qty adjust off its QR. */
  binContents: (slug: string, locationId: string) =>
    request<{ items: TrackedMatch[]; single: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/bin/${locationId}/contents`,
    ),
  binAdjust: (
    slug: string,
    locationId: string,
    body: { kind: string; entity_id: string; instance?: string; delta?: number; set?: number },
  ) =>
    request<{ entity_title: string; old_qty: number; new_qty: number }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/bin/${locationId}/adjust`,
      body,
    ),
  scanAttach: (
    slug: string,
    id: string,
    body: {
      kind: string;
      entity_id: string;
      instance?: string;
      mode: "add-qty" | "link-barcode" | "move" | "merge-fields";
      location_id?: string;
      /** Only meaningful on add-qty, the one mode that is a purchase.
       *  `context` keeps a party-sized or stock-up buy from training the rate
       *  like a normal shop; `resolution` says what became of the stock you
       *  still had, which nothing but a person can know. */
      cadence?: {
        context?: "normal" | "faster" | "bulk" | "one_off";
        resolution?: "over_buy" | "consumed" | "discarded";
      };
    },
  ) =>
    request<{
      item: ScanInboxItem;
      entity_title: string;
      new_qty: number | null;
      prev_location_id: string | null;
      merged_fields: string[];
      cadence_recorded?: string[];
    }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/attach`, body),
  /** What the ledger knows about an item: the learned rate, what is probably
   *  left, and what a purchase right now would MEAN (`repurchase_means`), which
   *  is what decides whether a re-scan needs the over-buy question. */
  cadenceState: (slug: string, kind: string, id: string, opts?: { expired?: boolean }) =>
    request<{
      /** Units per day, learned. Named cadence_rate by the engine - this type
       *  is the contract with a real response, not a guess. */
      cadence_rate: number | null;
      on_hand_estimate: number;
      days_until_runout: number | null;
      waste_ratio: number;
      confidence: string;
      reorder_suggested: boolean;
      buy_less_suggested: boolean;
      repurchase_means: "discard" | "consume" | "ask_over_buy";
      event_count: number;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-cadence/state/${encodeURIComponent(kind)}/${id}${opts?.expired ? "?expired=true" : ""}`,
    ),
  // Merge several similar pending items (same product, different barcodes) into one
  // line with the summed quantity; keepId's name/photo wins, others are discarded.
  combineScanItems: (slug: string, ids: string[], keepId?: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/combine`, {
      ids,
      ...(keepId ? { keep_id: keepId } : {}),
    }),
  /** Session theme: derive a shared tag + category across the pending inbox. */
  scanSessionTheme: (slug: string) =>
    request<{
      tag: string | null;
      tag_item_ids: string[];
      category: { value: string; item_ids: string[] } | null;
    }>("GET", `/orgs/${slug}/modules/core-scan/inbox/session-theme`),
  /** Stash the accepted theme onto the pending items (tag + category hint). */
  applyScanTheme: (
    slug: string,
    body: { tag?: string; tag_item_ids?: string[]; category?: { value: string; item_ids: string[] } },
  ) =>
    request<{ tagged: number; categorized: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/apply-theme`, body),
  // Alternative catalog photos (DDG image search on the resolved name) +
  // pick-one-as-catalog. The "OTHER PHOTO OPTIONS" strip.
  scanPhotoOptions: (slug: string, id: string, q?: string) =>
    request<{ items: ImageOption[]; query?: string; color?: string | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/photo-options${q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
    ),
  /** Apply a URL as the catalog image. Pass `aiPick` when the URL came from
   *  "✨ Pick best (AI)", so Revert can step back TO the ranker's choice instead
   *  of past it to the raw first web result. */
  setScanCatalogImage: (
    slug: string,
    id: string,
    url: string,
    opts?: { aiPick?: boolean; thumbUrl?: string },
  ) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`,
      {
        url,
        ...(opts?.aiPick ? { ai_pick: true } : {}),
        // The picture the user is actually looking at. Sent so a hotlink-blocked
        // original can fall back to it rather than refusing a visible image.
        ...(opts?.thumbUrl && opts.thumbUrl !== url ? { thumb_url: opts.thumbUrl } : {}),
      },
    ),
  /** "✨ Pick best (AI)" — a vision model ranks the photo options and picks the
   *  cleanest catalog shot (product-only, correct colour, no people). Read-only:
   *  returns the chosen URL + reason; the caller applies it via setScanCatalogImage.
   *  Pass the DISPLAYED candidates + any applied search term so the model ranks
   *  exactly what the user is looking at (the pick is always a visible tile);
   *  with none, the server searches fresh. `chosen_url` is null when nothing was
   *  rankable (no name, no options, no vision provider) — `reason` says why. */
  rankScanPhotoAi: (
    slug: string,
    id: string,
    opts?: { q?: string; candidates?: ImageOption[] },
  ) =>
    request<{ chosen_url: string | null; reason: string; color_seen?: string | null; ranked_over?: number }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/rank-photo-ai`,
      {
        ...(opts?.q?.trim() ? { q: opts.q.trim() } : {}),
        ...(opts?.candidates?.length ? { candidates: opts.candidates } : {}),
      },
    ),
  /** The workspace opt-in for ranking catalog photos automatically on every
   *  enriched scan (instead of only when someone presses ✨ Pick best). Reading
   *  is member-level; flipping it commits the workspace to per-scan AI spend, so
   *  the PUT is owner/admin. No stored row means off. */
  getScanPhotoRankConfig: (slug: string) =>
    request<{ enabled: boolean }>("GET", `/orgs/${slug}/modules/core-scan/photo-rank-config`),
  setScanPhotoRankConfig: (slug: string, enabled: boolean) =>
    request<{ enabled: boolean }>("PUT", `/orgs/${slug}/modules/core-scan/photo-rank-config`, { enabled }),
  /** Revert the catalog image to the original, or use the user's own scan photo. */
  scanCatalogAction: (slug: string, id: string, action: "revert" | "use_own_photo" | "use_screenshot_crop") =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`,
      { action },
    ),
  /** "Take a nice picture" — a fresh upload becomes the display/catalog image. */
  setScanCatalogFile: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`, {
      file_id: fileId,
    }),
  /** Crop the item's OWN photo into the catalog image. `box` is fractions of
   *  the source (0-1), the same shape the split feature's segmentation yields.
   *  Always crops the identify photo, so cropping twice starts from the
   *  original rather than compounding a crop of a crop. Revertable like any
   *  other catalog pick. */
  cropScanCatalogImage: (
    slug: string,
    id: string,
    box: { x: number; y: number; w: number; h: number },
  ) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`, {
      crop: box,
    }),
  /** Rotate the item's own photo (writes a new file; the old one is kept). */
  rotateScanPhoto: (slug: string, id: string, deg: 90 | 180 | 270) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/rotate`, { deg }),
  /** Multi-photo gallery: add / make-primary / remove an extra photo. */
  addScanPhoto: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos`, { file_id: fileId }),
  setScanPrimaryPhoto: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos/primary`, {
      file_id: fileId,
    }),
  removeScanPhoto: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("DELETE", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos/${fileId}`),
  /** Split a group photo into separate items (vision segments + crops). */
  splitScanItem: (slug: string, id: string) =>
    request<{ children: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/split`),
  createScanBatch: (slug: string) =>
    request<{ id: string }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/batches`,
      {},
    ),
  // Matchmaker — route a scanned item to the best workspace table(s) + fill
  // each table's fields. Run after identify; returns + persists ranked chips.
  matchScanItem: (slug: string, id: string) =>
    request<{ candidates: ScanCandidate[] }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/match`,
      {},
    ),
  // The workspace "scan menu" — every routable table (instances + module
  // defaults) with its field defs. The SAME menu the matchmaker prompts
  // with; drives the confirm form's target picker so the UI reflects the
  // workspace's actual tables instead of hardcoding module names.
  scanMenu: (slug: string) =>
    request<{ items: ScanMenuEntry[] }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/menu`,
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
  getAttention: (slug: string) =>
    request<{ items: Array<{ kind: "low_stock" | "overdue" | "upcoming" | "pending_scans"; label: string; count: number; sample: string[]; route: string; entries?: Array<{ id: string; title: string; action?: Record<string, string> }> }> }>(
      "GET",
      `/orgs/${slug}/attention`,
    ),
  getAiStatus: (slug: string) =>
    request<AiStatus>("GET", `/orgs/${slug}/ai-status`),
  getAiSettings: (slug: string) =>
    request<{ ai_disabled: boolean }>("GET", `/orgs/${slug}/ai-settings`),
  updateAiSettings: (slug: string, body: { ai_disabled: boolean }) =>
    request<{ ai_disabled: boolean }>("PATCH", `/orgs/${slug}/ai-settings`, body),

  // Ask Cobb "basic mode" — the no-AI floor. When AI is off, the chat asks the
  // server to match a message against the effective ruleset (no model, no cost).
  answerBasic: (slug: string, message: string) =>
    request<BasicAnswer>("POST", `/orgs/${slug}/modules/core-ai/basics/answer`, { message }),
  // The effective ruleset (built-ins overlaid with per-workspace overrides + customs).
  listBasics: (slug: string) =>
    request<{ rules: BasicRuleRow[] }>("GET", `/orgs/${slug}/modules/core-ai/basics`),
  createBasic: (slug: string, body: BasicRuleInput & { builtin_key?: string }) =>
    request<BasicRuleRaw>("POST", `/orgs/${slug}/modules/core-ai/basics`, body),
  updateBasic: (slug: string, id: string, body: Partial<BasicRuleInput> & { position?: number }) =>
    request<BasicRuleRaw>("PATCH", `/orgs/${slug}/modules/core-ai/basics/${id}`, body),
  deleteBasic: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/basics/${id}`),

  // core-ai — provider config + capability defaults + usage. See
  // docs/modules/core-ai.md.
  listAiProviderCatalogue: (slug: string) =>
    request<{ items: AiProviderDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/providers/catalogue`,
    ),
  listAiProviders: (slug: string) =>
    request<{ items: AiProvider[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/providers`,
    ),
  createAiProvider: (
    slug: string,
    body: {
      provider_id: string;
      label: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
      monthly_budget_cents?: number | null;
    },
  ) => request<AiProvider>("POST", `/orgs/${slug}/modules/core-ai/providers`, body),
  updateAiProvider: (
    slug: string,
    id: string,
    body: {
      label?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      enabled?: boolean;
      monthly_budget_cents?: number | null;
    },
  ) => request<AiProvider>("PATCH", `/orgs/${slug}/modules/core-ai/providers/${id}`, body),
  deleteAiProvider: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/providers/${id}`),
  testAiProvider: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; note?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/providers/${id}/test`,
    ),
  listAiCapabilityDefaults: (slug: string) =>
    request<{ items: AiCapabilityDefault[]; all_capabilities: string[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/capability-defaults`,
    ),
  upsertAiCapabilityDefault: (
    slug: string,
    body: {
      capability: string;
      provider_id: string;
      model: string;
      config?: Record<string, unknown>;
    },
  ) =>
    request<AiCapabilityDefault>(
      "PUT",
      `/orgs/${slug}/modules/core-ai/capability-defaults`,
      body,
    ),
  deleteAiCapabilityDefault: (slug: string, capability: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-ai/capability-defaults/${encodeURIComponent(capability)}`,
    ),
  invokeAi: (
    slug: string,
    body: {
      capability: string;
      input: Record<string, unknown>;
      provider_id?: string;
      model?: string;
      bypass_cache?: boolean;
    },
  ) =>
    request<{
      result: unknown;
      provider_id: string;
      model: string;
      cached: boolean;
      cost_cents?: number;
      duration_ms: number;
    }>("POST", `/orgs/${slug}/modules/core-ai/invoke`, body),
  /** Agentic chat: returns a plain reply OR one/many proposed writes the user
   *  confirms via aiChatExecute (the tool loop can propose several in one turn —
   *  "add it to the list AND save it as a note"). */
  aiChat: (
    slug: string,
    messages: { role: "user" | "assistant"; content: string }[],
    /** What the user is looking at right now (route + one-line summary), for
     *  Cobb's situational awareness. See web/src/lib/chat-context.ts. */
    context?: { label: string; summary?: string },
  ) =>
    request<{
      type: "reply" | "proposal" | "proposals" | "build-proposal" | "error";
      text?: string;
      summary?: string;
      proposal?: AiChatProposal;
      /** type:"proposals" — several writes from one turn, each its own confirm. */
      items?: Array<{ summary: string; proposal: AiChatProposal }>;
      /** AUTO mode: writes already applied this turn (ledgered) — render as
       *  "✓ done" cards with an Undo where undoable. */
      applied?: Array<{ summary: string; ledger_id?: string; undoable?: boolean }>;
      /** build-proposal: the build runs async — poll authoringDraft(draft_id)
       *  until the draft leaves "building", then read its validation.preview. */
      building?: boolean;
      draft_id?: string;
      /** Tier-1.5 escorts: screens Cobb walked the user to this turn (the
       *  widget navigates; prefill.* params fill the form; the page's own
       *  submit stays the user's). */
      escorts?: Array<{ path: string; label: string }>;
    }>("POST", `/orgs/${slug}/modules/core-ai/chat`, { messages, ...(context ? { context } : {}) }),
  aiChatExecute: (slug: string, proposal: AiChatProposal) =>
    request<{
      ok: boolean;
      message: string;
      entity?: { kind: string; id?: string };
      /** The AI change-ledger row for this write — undo handle. */
      ledger_id?: string;
      undoable?: boolean;
    }>("POST", `/orgs/${slug}/modules/core-ai/chat/execute`, { proposal }),
  /** Ask Cobb tool consent (per-user, per-workspace): may the chat read your
   *  workspace data into prompts, and the write mode (off / ask / auto)?
   *  Enforced server-side; auto still asks for ACTIONS (irreversible). */
  aiChatPrefs: (slug: string) =>
    request<{ read_tools: boolean; write_mode: "off" | "ask" | "auto" }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/chat/prefs`,
    ),
  aiChatSetPrefs: (slug: string, prefs: { read_tools: boolean; write_mode: "off" | "ask" | "auto" }) =>
    request<{ read_tools: boolean; write_mode: "off" | "ask" | "auto" }>(
      "PUT",
      `/orgs/${slug}/modules/core-ai/chat/prefs`,
      prefs,
    ),
  /** The AI change ledger: what Cobb wrote (confirmed or auto), what's undoable. */
  aiChatWrites: (slug: string) =>
    request<{
      items: Array<{
        id: string;
        tool: "create" | "update" | "delete" | "action";
        entity_kind: string;
        entity_id: string | null;
        entity_label: string;
        auto_applied: boolean;
        undone_at: string | null;
        undo_of: string | null;
        created_at: string;
        undoable: boolean;
      }>;
    }>("GET", `/orgs/${slug}/modules/core-ai/chat/writes`),
  aiChatUndo: (slug: string, writeId: string) =>
    request<{ ok: boolean; message: string }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/chat/writes/${writeId}/undo`,
    ),
  listAiCalls: (slug: string, limit = 50) =>
    request<{ items: AiCall[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/calls?limit=${limit}`,
    ),
  // AI activity log (full prompt/response). Per-user within a workspace.
  aiActivity: (slug: string, scope: "mine" | "workspace" = "mine", limit = 100) =>
    request<{ items: AiActivityItem[]; scope: string }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/activity?scope=${scope}&limit=${limit}`,
    ),
  aiActivityDetail: (slug: string, id: string) =>
    request<AiActivityDetail>("GET", `/orgs/${slug}/modules/core-ai/activity/${id}`),
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
  getAiUsageSummary: (slug: string) =>
    request<{ since: string; items: AiUsageSummaryRow[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/summary`,
    ),

  // core-catalogs — imported reference datasets (Rebrickable parts,
  // Open Library books, Open Food Facts groceries, etc.). User entities
  // point at rows here via `entity_pairings` with `relationship_kind: "matches"`.
  listCatalogs: (slug: string) =>
    request<{ items: Catalog[] }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs`,
    ),
  getCatalog: (slug: string, id: string) =>
    request<Catalog>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
    ),
  createCatalog: (slug: string, body: Partial<Catalog>) =>
    request<Catalog>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs`,
      body,
    ),
  updateCatalog: (slug: string, id: string, body: Partial<Catalog>) =>
    request<Catalog>(
      "PATCH",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
      body,
    ),
  deleteCatalog: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
    ),

  // core-templates — per-workspace entity templates. See
  // docs/product/homebox-parity-report.md punch-list item #2.
  listTemplates: (slug: string, targetKind?: string) => {
    const qs = targetKind ? `?target_kind=${encodeURIComponent(targetKind)}` : "";
    return request<{ items: EntityTemplate[] }>(
      "GET",
      `/orgs/${slug}/modules/core-templates/templates${qs}`,
    );
  },
  getTemplate: (slug: string, id: string) =>
    request<EntityTemplate>(
      "GET",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
    ),
  createTemplate: (
    slug: string,
    body: {
      target_kind: string;
      name: string;
      description?: string | null;
      defaults?: Record<string, unknown>;
      default_tags?: string[];
      position?: number;
    },
  ) =>
    request<EntityTemplate>(
      "POST",
      `/orgs/${slug}/modules/core-templates/templates`,
      body,
    ),
  updateTemplate: (slug: string, id: string, body: Partial<EntityTemplate>) =>
    request<EntityTemplate>(
      "PATCH",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
      body,
    ),
  deleteTemplate: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-templates/templates/${id}`,
    ),
  instantiateTemplate: <T = { id: string }>(
    slug: string,
    id: string,
    overrides?: Record<string, unknown>,
  ) =>
    request<T>(
      "POST",
      `/orgs/${slug}/modules/core-templates/templates/${id}/instantiate`,
      { overrides },
    ),
  importCatalogCsv: (
    slug: string,
    id: string,
    body: { csv: string; schema?: CatalogSchema },
  ) =>
    request<{ imported: number; total: number; schema_used: CatalogSchema }>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}/import-csv`,
      body,
    ),
  /** Pull a catalog's rows from its source_url (the built-in puller — fetches +
   *  gunzips the CSV). One-tap import for a bundle-shipped catalog shell (e.g.
   *  Rebrickable), replacing the hand-run seeder. */
  pullCatalog: (slug: string, id: string) =>
    request<{ imported: number; total: number; source_url: string }>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}/pull`,
      {},
    ),
  listCatalogEntries: (
    slug: string,
    catalogId: string,
    params: { q?: string; limit?: number; offset?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const trailing = qs.toString() ? `?${qs}` : "";
    return request<{
      items: CatalogEntry[];
      title_column: string;
      /** Present for hosted catalogs: whether this catalog's rows can be
       *  browsed/searched via the shared service (false for the BOM). */
      hosted?: boolean;
      browsable?: boolean;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${catalogId}/entries${trailing}`,
    );
  },
  /** Cross-catalog search — single call, results from every installed
   *  catalog in the workspace (except those with
   *  `schema.exclude_from_global_search: true`). Used by the catalog-
   *  aware quick-add typeahead on entity create forms. */
  searchCatalogs: (
    slug: string,
    params: { q: string; limit?: number; catalog_ids?: string[] },
  ) => {
    const qs = new URLSearchParams({ q: params.q });
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.catalog_ids?.length) qs.set("catalog_ids", params.catalog_ids.join(","));
    return request<{ items: CatalogSearchHit[] }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/search?${qs}`,
    );
  },

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
  getDashboardLayout: (slug: string) =>
    request<{ layout: DashboardLayout }>(
      "GET",
      `/orgs/${slug}/dashboard-layout`,
    ),
  setDashboardLayout: (slug: string, body: DashboardLayout) =>
    request<{ layout: DashboardLayout }>(
      "PUT",
      `/orgs/${slug}/dashboard-layout`,
      body,
    ),
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
  // H2 admin-configurable field read-scope (per-workspace gated fields).
  listFieldScopes: (slug: string) =>
    request<{ items: { kind: string; field: string; capability: string }[] }>(
      "GET",
      `/orgs/${slug}/field-scopes`,
    ),
  setFieldScope: (
    slug: string,
    body: { kind: string; field: string; capability: string },
  ) => request<void>("PUT", `/orgs/${slug}/field-scopes`, body),
  deleteFieldScope: (slug: string, kind: string, field: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/field-scopes?kind=${encodeURIComponent(
        kind,
      )}&field=${encodeURIComponent(field)}`,
    ),
  getMyCapabilities: (slug: string) =>
    request<{ role: string; grants: string[] }>(
      "GET",
      `/orgs/${slug}/me/capabilities`,
    ),

  // Admin-creates-user — see api/src/routes/admin-users.ts. Returns
  // the temp password ONCE; the UI has to capture it now or call
  // regen later.
  adminCreateUser: (
    slug: string,
    body: { email: string; display_name: string; role: "owner" | "admin" | "editor" | "member" | "guest" },
  ) =>
    request<{
      user: { id: string; email: string; display_name: string; role: string; must_reset_password: boolean };
      temp_password: string;
      instructions: string;
    }>("POST", `/orgs/${slug}/admin/users`, body),
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

  // Super-admin (platform operator) — gated by SUPERADMIN_EMAILS.
  // The web shell renders /super-admin/* only when user.is_platform_admin.
  /** The thesis dashboard (audit F2): per workspace, walls-hit 7d/30d by event
   *  + time-to-first-working-app. Operator only. */
  superAdminProductMetrics: () =>
    request<{
      workspaces: Array<{
        org_id: string;
        name: string;
        slug: string;
        created_at: string;
        first_item_at: string | null;
        ttfw_minutes: number | null;
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

  // Marketplace v0.3.x — operator browses the cobblr registry +
  // installs sandboxed modules at runtime.
  sandboxRegistry: (url?: string) => {
    const qs = url ? `?url=${encodeURIComponent(url)}` : "";
    return request<{
      items: Array<{
        name: string;
        display_name?: string;
        description?: string;
        band: string;
        author?: string;
        homepage?: string;
        public_key_ed25519: string | null;
        versions: Array<{
          version: string;
          released_at?: string;
          source_url: string;
          sha256: string | null;
          signature: string | null;
          notes?: string;
        }>;
        installed: { name: string; version: string; source: string } | null;
      }>;
    }>("GET", `/sandbox/registry${qs}`);
  },
  sandboxInstall: (body: { name: string; version: string; registry_url?: string }) =>
    request<{ ok: boolean; name: string; version: string; routes: Array<{ method: string; path: string }> }>(
      "POST",
      `/sandbox/install`,
      body,
    ),
  sandboxUninstall: (name: string) =>
    request<{
      ok: boolean;
      name: string;
      removed_from_registry: boolean;
      removed_dir: string | null;
    }>("DELETE", `/sandbox/install/${encodeURIComponent(name)}`),

  // core-locations — workspace-wide tree of physical places. Anything
  // with a `location_id` field (machines, assets, parts) points at
  // rows from this endpoint.
  listLocations: (slug: string) =>
    request<{ items: Location[] }>(
      "GET",
      `/orgs/${slug}/modules/core-locations/locations`,
    ),
  getLocation: (slug: string, id: string) =>
    request<Location>(
      "GET",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
    ),
  createLocation: (slug: string, body: Partial<Location>) =>
    request<Location>(
      "POST",
      `/orgs/${slug}/modules/core-locations/locations`,
      body,
    ),
  updateLocation: (slug: string, id: string, body: Partial<Location>) =>
    request<Location>(
      "PATCH",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
      body,
    ),
  deleteLocation: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
    ),
  importLocations: (slug: string, body: { csv: string; match_on?: string; dry_run?: boolean }) =>
    request<LocationImportResponse>("POST", `/orgs/${slug}/modules/core-locations/locations/import`, body),
  exportLocationsPath: (slug: string) => `/orgs/${slug}/modules/core-locations/locations/export`,
  // Persist a sibling group's display order: `ids` in the desired order → each
  // row's `position` set to its index. Siblings render by (position, name).
  reorderLocations: (slug: string, ids: string[]) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-locations/locations/reorder`, { ids }),
  /** Describe-to-plan: an AI drafts room dims + walls (+ door openings) +
   *  zone regions from prose. dry_run returns the validated draft without
   *  writing (the preview + eval path). */
  seedFloorplan: (slug: string, id: string, description: string, dry_run?: boolean) =>
    request<{
      draft: {
        room: {
          w_mm: number;
          d_mm: number;
          unit?: string;
          view?: string;
          walls?: Array<{
            x1: number; y1: number; x2: number; y2: number;
            openings?: Array<{ at_mm: number; w_mm: number }>;
          }>;
        };
        zones: Array<{ name: string; rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number } }>;
      };
      applied: boolean;
      zones?: Array<{ name: string; id: string; created: boolean }>;
    }>("POST", `/orgs/${slug}/modules/core-locations/locations/${id}/floorplan/seed`, {
      description,
      ...(dry_run ? { dry_run } : {}),
    }),
};

export interface LocationImportRow {
  row_number: number;
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  match_value: string | null;
  action: "create" | "update";
  parent: { key: string; resolved: boolean } | null;
  metadata: Record<string, string>;
}
export interface LocationImportResponse {
  match_on?: string;
  detected_headers?: string[];
  rows?: LocationImportRow[];
  errors: { row_number: number; message: string }[];
  summary?: { create: number; update: number; unresolved_parents: number };
  committed: number;
  created?: number;
  updated?: number;
}

export interface AiStatus {
  available: boolean;
  reason: "ok" | "operator_disabled" | "not_entitled" | "no_provider" | "workspace_disabled";
  /** When available, where the call would be served from — drives honest copy. */
  source?: "personal" | "workspace" | "managed";
}

/** Result of the no-AI basic-mode matcher (POST …/core-ai/basics/answer). */
export interface BasicAnswer {
  matched: boolean;
  reply: string;
  intent: string | null;
  key: string | null;
  score: number;
  candidates: Array<{ key: string; intent: string; score: number }>;
}

/** One rule in the effective ruleset (GET …/core-ai/basics). */
export interface BasicRuleRow {
  /** row id, or null for a pristine built-in with no override row yet */
  id: string | null;
  /** built-in key, or the custom row id — stable per rule */
  key: string;
  builtin: boolean;
  intent: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  position: number;
}

/** Editable fields when creating/updating a rule. */
export interface BasicRuleInput {
  intent: string;
  keywords: string[];
  reply: string;
  enabled?: boolean;
}

/** A raw core_ai_basics row (returned by create/update). */
export interface BasicRuleRaw {
  id: string;
  builtin_key: string | null;
  intent: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface AiProvider {
  id: string;
  provider_id: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  monthly_budget_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface AiProviderDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; choices?: Array<{ value: string; label: string }> }>;
  capabilities: Record<string, { models: string[]; defaultModel?: string }>;
  /** What this provider is FOR. Absent on the per-workspace AI catalogue, which
   *  is AI by definition; the personal catalogue at /me/connections carries
   *  every kind and always sets it. */
  kind?: string;
  /** One line under the picker, for a kind whose purpose isn't self-evident. */
  blurb?: string;
}

/** How the personal-connections page introduces each kind. An unlisted kind
 *  still works — it just gets its raw id as a heading instead of prose. */
export const CONNECTION_KIND_LABELS: Record<string, { title: string; blurb: string }> = {
  "ai-provider": {
    title: "AI",
    blurb: "Your own key, or the local-AI edge bridge.",
  },
  "parcel-tracking": {
    title: "Parcel tracking",
    blurb: "Follow your own deliveries with your own tracking account.",
  },
};

export type ConnRouteMode = "my-calls" | "workspace-default";
export type ConnRouteScope = "sole_member" | "owner" | "all_mine" | "explicit";

/** Per-workspace routing for a connection: which workspace + its mode. A
 *  workspace with no route is "Off". */
export interface ConnRoute {
  org_id: string;
  mode: ConnRouteMode;
}

/** A personal credential the user configured once + routed to workspaces. */
export interface UserConnection {
  id: string;
  provider_id: string;
  /** Which catalogue this came from ('ai-provider', 'tracking', …), so the
   *  page groups a user's connections by what they are for. */
  kind: string;
  label: string;
  route_mode: ConnRouteMode;
  route_scope: ConnRouteScope;
  auto_enable_new: boolean;
  org_ids: string[];
  /** Per-workspace routing (workspace + mode). */
  routes: ConnRoute[];
  /** For 'workspace-default' (Share) routes: owner-approval state per org_id —
   *  'pending' | 'approved' | 'active'. Lets the sharer see whether an offer is
   *  live yet. Absent org_id = a 'my-calls' route. */
  share_status: Record<string, "pending" | "approved" | "active">;
  /** Which credential keys are set (names only — never the secret values). */
  credential_keys: string[];
  /** Values of the NON-SECRET credential fields (base_url, choices, model …), so
   *  the edit form can pre-fill them. Secret fields are never included. */
  credential_values: Record<string, string>;
  /** Depends on the user's personal edge agent (the edge-bridge provider, or a
   *  URL provider with bridge transit) — drives the live status indicators. */
  uses_edge: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserConnectionInput {
  provider_id: string;
  label?: string;
  credentials?: Record<string, unknown>;
  route_mode?: ConnRouteMode;
  route_scope?: ConnRouteScope;
  auto_enable_new?: boolean;
  org_ids?: string[];
  /** Per-workspace routing (preferred over org_ids). */
  routes?: ConnRoute[];
}

/** An AI-share offer as the workspace OWNER sees it. */
export interface WorkspaceAiOffer {
  credential_id: string;
  provider_id: string;
  label: string;
  offered_by_user_id: string;
  offered_by_name: string;
  status: "pending" | "approved";
  active: boolean;
  is_own: boolean;
}

export interface AiCapabilityDefault {
  capability: string;
  provider_id: string;
  model: string;
  config: Record<string, unknown>;
}

export interface AiCall {
  id: string;
  provider_id: string;
  capability: string;
  model: string | null;
  input_summary: string | null;
  output_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  error: string | null;
  cached: boolean;
  invoked_at: string;
}

export interface AiUsageSummaryRow {
  capability: string;
  provider_id: string;
  calls: number;
  cached_calls: number;
  total_cost_cents: number | null;
  total_duration_ms: number | null;
  failed: number;
}

export interface IntegrationConnector {
  id: string;
  connector_id: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntegrationConnectorDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; choices?: Array<{ value: string; label: string }> }>;
  actions: Array<{
    id: string;
    label: string;
    description?: string;
    argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" }>;
  }>;
}

export interface InboundHandlerDef {
  id: string;
  label: string;
  config: Record<string, { label: string; secret: boolean }>;
  emits: string[];
}

export interface InboundToken {
  id: string;
  connector_id: string;
  token: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  last_hit_at: string | null;
  hit_count: number;
  created_at: string;
}

// Sync connectors (mirror an external system into a Cobblr entity kind).
// A connected edge bridge for the workspace. `bridge: null` = the default
// (no-id) bridge; a string = a named bridge.
export interface EdgeBridge {
  bridge: string | null;
  connected: boolean;
  last_seen: number | null;
}

/** A bridge Cobblr reaches DIRECTLY (LAN, tailnet, same machine), derived from
 *  the connections pointing at it — there is no bridge table, because a
 *  connection's base_url already carries the address. */
export interface DirectEdgeBridge {
  origin: string;
  label: string;
  instances: number;
  auth: "token" | "none" | "mixed";
  /** Last success FROM COBBLR'S SERVER. Whether YOUR BROWSER can reach it is a
   *  different question with a different answer, and the UI must not conflate
   *  them: a bench on a tailnet host is reachable by a self-hosted Cobblr and
   *  not by a laptop elsewhere. */
  last_ok_at: string | null;
  last_status: string | null;
  connection_ids: string[];
}

export interface SyncConnectorDef {
  id: string;
  label: string;
  credentials: Record<string, { label: string; secret: boolean; choices?: Array<{ value: string; label: string }> }>;
  config: Record<string, { label: string; placeholder?: string }>;
  entityTypes: Array<{ key: string; label: string; targetKind: string }>;
}

// An installed declarative sync-source manifest (a row in sync_source_defs).
export interface SyncSourceDef {
  id: string;
  source_id: string;
  name: string;
  manifest: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SyncStateRow {
  connector_row_id: string;
  entity_type: string;
  enabled: boolean;
  cadence_min: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_synced_count: number | null;
  next_run_at: string | null;
  /** Null until the first import is approved (then live sync is active). */
  import_approved_at: string | null;
}

export interface SyncRunResult {
  created: number;
  updated: number;
  linked: number;
  tombstoned: number;
  total: number;
}

// An import preview — what a reconcile WOULD do, computed without writing.
export interface ImportPlanItem {
  externalId: string;
  name: string;
  action: "create" | "update" | "link" | "unchanged" | "delete";
  cobblrId?: string | null;
  /** The mapped source fields this row would write (what data comes over). */
  fields?: Record<string, unknown>;
  /** For link/update/delete: the existing Cobblr entity (name + current fields). */
  match?: { id: string; name: string; fields?: Record<string, unknown> | null } | null;
}
export interface ImportPlan {
  entityType: string;
  targetKind: string;
  counts: { create: number; update: number; link: number; unchanged: number; delete: number; total: number };
  items: ImportPlanItem[];
}

export interface SyncConnection {
  id: string;
  connector_id: string;
  label: string;
  config: { base_url: string; transport?: "direct" | "edge"; bridge?: string | null };
  enabled: boolean;
  /** Set = in the Archived history section (not deleted); null = in the list. */
  archived_at?: string | null;
  created_at: string;
  syncs?: SyncStateRow[];
}

export interface SyncConnectionDetail extends SyncConnection {
  entity_types: Array<{ key: string; label: string; targetKind: string }>;
  syncs: SyncStateRow[];
  webhook_path: string | null;
}

export interface IntegrationCall {
  id: string;
  direction: "outbound" | "inbound";
  connector_id: string;
  action_or_event: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  request_meta: Record<string, unknown> | null;
  ms: number | null;
  occurred_at: string;
}

export interface ModuleInstance {
  id: string;
  org_id: string;
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  config: Record<string, unknown>;
  created_at: string;
  /** Primary-item count for this instance; null if the module reports none. */
  item_count?: number | null;
}

export interface NavHeadingMember {
  target_kind: "module" | "instance";
  target_id: string;
  position: number;
}
export interface NavHeading {
  id: string;
  name: string;
  icon: string | null;
  position: number;
  members: NavHeadingMember[];
}

export interface EntityKindOverride {
  id: string;
  org_id: string;
  target_kind: "entity_kind" | "instance" | "bundle";
  target_id: string;
  display_label: string | null;
  display_label_plural: string | null;
  icon: string | null;
  hidden: boolean;
  nav_order: number | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One web-image candidate (the universal photo-picker strip). */
export interface ImageOption {
  url: string;
  thumb: string;
  title: string;
  source: string;
}

export interface Location {
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: number;
  position: number;
  kind: "area" | "container";
  metadata: Record<string, unknown>;
  description: string | null;
  notes: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanCandidate {
  module: string;
  instance: string | null;
  kind: string;
  label: string;
  confidence: number;
  name: string;
  fields: Record<string, string | number | boolean>;
  /** The grouping-axis value, snapped onto the table's existing vocabulary when
   *  one matched. `category_is_new` means the model proposed a label the table
   *  does not have yet - nothing is created until the item is filed. */
  category?: string;
  category_is_new?: boolean;
  /** Top candidate only: terse reconciliation of all the item data. */
  notes?: string;
  /** Unit count when the item data implies one ("1 Pack Of 9 Skein"). */
  quantity?: number;
  /** Field names in `fields` completed from the model's knowledge of a confident
   *  known entity (a book's ISBN/publisher/year), not read off the photo — so the
   *  UI can flag them for a double-check. */
  inferred?: string[];
  /** Capture-first: set when this routes to a not-yet-installed flagship
   *  bundle — the bundle to materialize. */
  bundle_external_id?: string;
  /** Produced without a model call (the keyword floor) — rendered honestly. */
  heuristic?: true;
  /** How a non-AI candidate earned its route: "noun" (names what the item is),
   *  "keywords" (corroborating hits only — tentative, no one-tap Add, skipped
   *  by File all), "fallback" (the honest catch-all + category). */
  basis?: "noun" | "keywords" | "fallback";
}

/** One field on a scan-menu table (a trimmed field def). */
export interface ScanMenuField {
  name: string;
  label: string;
  type: string;
  help?: string;
  choices?: string[];
}

/** One routable destination in the workspace scan menu — an enabled
 *  instance ("Yarn") or a module's default table. Mirrors core-scan's
 *  ScanMenuEntry (services/matchmaker.ts). */
export interface ScanMenuEntry {
  module: string;
  instance: string | null;
  kind: string;
  noun: string;
  label: string;
  fields: ScanMenuField[];
  /** This table's declared GROUPING AXIS (`field_role: "category"`) and the
   *  workspace's existing vocabulary for it. Declared, so the UI never has to
   *  guess which field is the category by matching values. */
  category_field?: { name: string; label: string; values: string[] };
  /** Domain routing terms a bundle declared for this table. */
  scan_keywords?: string[];
  /** This kind is tracked ONE BY ONE (its declared traits include `unique` — a
   *  vehicle, a machine). Two captures of it combine as a detail-merge, never a
   *  quantity sum. */
  unique?: boolean;
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

/** A rule in the external-QR resolver redirect table. See
 *  docs/design-decisions/external-qr-resolver.md. */
export interface ScanQrRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match: { type: "url_prefix" | "url_base" | "regex" | "bare"; value?: string };
  extract: {
    source?: "path_segment_after_prefix" | "capture_group" | "whole_value";
    group?: string | number;
    type_from?: string | number;
    transform?: Array<"trim" | "strip_leading_zeros" | "lowercase">;
  };
  resolve: { target_kind?: string; type_map?: Record<string, string>; key_field: string };
  created_at: string;
  updated_at: string;
}

/** Outcome of resolving a foreign scan against the redirect table. */
export interface ScanResolveCandidate {
  entity_kind: string;
  entity_id: string;
  entity_label: string;
  detail_path: string;
  rule_id: string;
  rule_name: string;
}

export type ScanResolveOutcome =
  | {
      outcome: "resolved";
      rule_id: string;
      rule_name: string;
      entity_kind: string;
      entity_id: string;
      entity_label: string;
      detail_path: string;
    }
  | {
      /** The key names several entities; the resolver refuses to pick. */
      outcome: "ambiguous";
      key: string;
      candidates: ScanResolveCandidate[];
      truncated: boolean;
    }
  | {
      outcome: "recognized_no_match";
      rule_id: string;
      rule_name: string;
      key: string;
      target_kind: string | null;
    }
  | { outcome: "no_rule" };

export interface ScanInboxItem {
  id: string;
  status: "pending" | "enriching" | "resolved" | "discarded";
  source_kind: "barcode" | "photo" | "url" | "receipt" | "note";
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  suggested_metadata: Record<string, unknown>;
  /** Ranked matchmaker routing candidates (which table + filled fields). */
  suggested_candidates: ScanCandidate[];
  ai_notes: string | null;
  ai_confidence: string | null;
  ai_suggested_at: string | null;
  target_module: string | null;
  target_kind: string | null;
  target_entity_id: string | null;
  target_location_id: string | null;
  /** Suggested home from where similar items live; the review UI offers a one-tap accept. */
  suggested_location_id: string | null;
  suggested_location_note: string | null;
  scan_batch_id: string | null;
  scan_area: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

/** Guided Organize (docs/product/guided-organize.md): a batch put-away plan. */
export type OrganizeDestination =
  | { kind: "existing"; location_id: string; location_name: string; location_path: string }
  | { kind: "new"; name: string; parent_id: string | null; parent_name: string | null }
  | { kind: "unassigned" };

export interface OrganizeGroup {
  id: string;
  label: string;
  rationale: string;
  item_ids: string[];
  destination: OrganizeDestination;
  evidence?: { sibling_count: number; sample_names: string[] };
  /** Size check (declared dims only): a member's longest declared dimension
   *  exceeds the destination's max interior axis. A warning — never a
   *  silent reroute. */
  size_warning?: string;
  /** AI picked this existing bin with NO computed evidence — render as the
   *  model's suggestion (amber), never as a finding. */
  ai_guess?: boolean;
  /** Pre-filed items ("already set — just put them away"): born applied,
   *  walkable immediately, no Accept needed. */
  ready?: boolean;
}

export interface OrganizePlanResponse {
  plan_id: string;
  expires_at: string;
  /** This plan was produced with a user hint (provenance for the plan line). */
  draft_hinted?: boolean;
  /** The carried session hint's text (visible + clearable on the plan line). */
  hint_text?: string;
  /** Groups pre-accepted at plan time (ready groups). */
  applied_group_ids?: string[];
  groups: OrganizeGroup[];
  already_filed_item_ids: string[];
  needs_review_item_ids: string[];
  census_truncated: boolean;
  source: "ai" | "heuristic";
  /** "inbox" (pending scans) or "entities" (Phase 3: unplaced committed things). */
  subject?: "inbox" | "entities";
  /** Display names by item id — the render fallback when the inbox no longer
   *  holds the item (entity plans, or a scan committed mid-walk). */
  item_names?: Record<string, string>;
  /** Barcodes by item id (entity plans) — powers scan-to-confirm in the walk. */
  item_barcodes?: Record<string, string>;
}

/** The stored plan as GET /organize/plan/latest returns it (walk resume). */
export type LiveSortDirective =
  | {
      kind: "bin";
      location_id: string;
      location_name: string;
      location_path: string;
      sibling_count: number;
      sample_names: string[];
      via: "census" | "session" | "sticky";
    }
  | { kind: "catch-all"; location_id: string | null; location_name: string | null }
  | { kind: "bind-offer"; location_id: string; location_name: string; proposed_name: string };

export interface LiveSortEntry {
  id: string;
  inbox_item_id: string;
  name: string | null;
  quantity: number;
  directive: LiveSortDirective;
  status: "proposed" | "confirmed";
  confirmed_location_id?: string;
  confirmed_location_name?: string;
  bind?: { prior_name: string };
}

export interface OrganizeStoredPlan {
  plan_id: string;
  groups: OrganizeGroup[];
  already_filed_item_ids: string[];
  needs_review_item_ids: string[];
  census_truncated: boolean;
  source: "ai" | "heuristic";
  subject?: "inbox" | "entities";
  item_names?: Record<string, string>;
  item_barcodes?: Record<string, string>;
  applied_group_ids: string[];
  walk_state: { placed_item_ids?: string[] };
  /** The active put-away session backing walk_state (null = none started). */
  putaway_session_id?: string | null;
  expires_at: string;
}

export interface OrganizeApplyResponse {
  applied_group_ids: string[];
  filed_item_ids: string[];
  created_locations: Array<{ id: string; name: string; group_id: string }>;
  skipped: Array<{ group_id: string; reason: string }>;
}

/** "Already tracked" — an existing entity matching a scan (by barcode or name). */
export interface TrackedMatch {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  image_path: string | null;
  detail_url: string | null;
  instance: string | null;
  noun: string;
  qty: number | null;
  location_id: string | null;
  /** The stock you already have is past its expiry date, per this kind's
   *  expiry-role field. Lets a re-purchase be recorded as waste instead of
   *  consumption without asking. */
  expired: boolean;
  matched_by: "barcode" | "name" | "bin";
}

/** Capture-first: pending captures grouped by the flagship bundle they fit. */
export interface QuickstartSuggestion {
  bundle_external_id: string;
  bundle_name: string;
  noun: string;
  count: number;
  sample_names: string[];
}
export interface QuickstartSuggestions {
  pending_total: number;
  suggestions: QuickstartSuggestion[];
}
export interface QuickstartMaterializeResult {
  created: number;
  module: string | null;
  instance: string | null;
  label?: string;
  /** Route under /w/:slug to land the user in the new, populated table. */
  route: string | null;
  errors?: Array<{ id: string; status: number }>;
}

export interface EntityTemplate {
  id: string;
  target_kind: string;
  name: string;
  description: string | null;
  defaults: Record<string, unknown>;
  default_tags: string[];
  position: number;
  created_at: string;
  updated_at: string;
}

/** Built-in renderers Cobblr's web UI knows how to draw against a
 *  catalog entry's `payload[fieldName]`. Catalogs (and later: entity
 *  kinds + bundle presentation overrides) declare which renderer to
 *  use per field via CatalogSchema.field_renderers. */
export type CatalogFieldRenderer =
  | "text"        // default — String(value)
  | "color-hex"   // "0033B2" → swatch + uppercase hex
  | "image-url"   // URL → thumbnail
  | "url-link"    // URL → clickable link
  | "year"        // 1965 → "1965"
  | "boolean"     // "True"/"true"/1/0 → ✓ / ✕
  | "code"        // monospace + bg, for SKUs / model numbers
  | "markdown"    // rich text — rendered Markdown (block) / stripped (inline)
  | "qr";         // a scannable QR of the value (owned codes: UPC, tag, URL)

export interface CatalogSchema {
  id_column?: string;
  title_column?: string;
  image_column?: string;
  subtitle_column?: string;
  description_column?: string;
  field_renderers?: Record<string, CatalogFieldRenderer>;
  /** Pretty labels for payload keys — `{ is_trans: "Transparent" }`.
   *  Falls back to the raw key when not set. */
  field_labels?: Record<string, string>;
  /** Catalog-match prefill: `{ catalogPayloadKey: instanceFieldName }` — picking
   *  an entry fills those instance fields from its payload. */
  field_map?: Record<string, string>;
  /** Which entity kinds this catalog is meaningful to match against.
   *  Omitted ⇒ catalog appears in the picker for every source kind
   *  the action applies to. */
  bindable_to_kinds?: string[];
  /** Stable semantic identifier — e.g. "lego.set", "mcmaster.part".
   *  Lets other modules look up "the canonical sets catalog" without
   *  hardcoding a bundle id. See 2026-05-25-audit.md S5. */
  semantic_type?: string;
  /** Replaces the card's image slot with a renderer drawing
   *  `payload[hero_field]`. E.g. Rebrickable colors set
   *  hero_field=rgb + hero_renderer=color-hex → cards show big
   *  color swatches where the photo would be. */
  hero_field?: string;
  hero_renderer?: CatalogFieldRenderer;
}

export interface Catalog {
  id: string;
  name: string;
  description: string | null;
  source_url: string | null;
  puller_id: string | null;
  schema: CatalogSchema;
  last_sync_at: string | null;
  entry_count: number;
  /** `hosted` — rows live in Cobblr's shared reference-catalog service, not
   *  this workspace's DB, so `entry_count` is 0 by design; the catalog is
   *  still fully usable (matches resolve against the service). `local` — rows
   *  imported into this workspace. Absent on older installs → treat as local. */
  source?: "local" | "hosted";
  created_at: string;
  updated_at: string;
}

export interface CatalogEntry {
  id: string;
  catalog_id: string;
  external_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Result row from /catalogs/search — denormalised so the typeahead
 *  can render `<title> · <catalog_name>` without a second lookup. */
export interface CatalogSearchHit {
  id: string;
  catalog_id: string;
  catalog_name: string;
  external_id: string;
  payload: Record<string, unknown>;
  title: string;
  title_column: string;
  /** `{ catalogPayloadKey: instanceFieldName }` from the catalog's schema —
   *  picking a hit prefills those instance fields from the payload. */
  field_map?: Record<string, string>;
}

export interface PairingItem {
  id: string;
  org_id: string;
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relationship_kind: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

/** Admin dashboard arrangement. `widgets` orders the "at a glance" tiles (ids
 *  owned by the platform-web registry) with a hidden flag and an optional
 *  column-span (tile width). `sections` orders the whole dashboard sections
 *  (at_a_glance / pinned_views / recent_activity) with a hidden flag. The
 *  server persists order + visibility only. */
export interface DashboardLayout {
  widgets: { id: string; hidden: boolean; span?: number }[];
  sections?: { id: string; hidden: boolean }[];
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

export interface PermissionsMember {
  id: string;
  email: string;
  display_name: string;
  role: "owner" | "admin" | "editor" | "member" | "guest";
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

export interface WorkspaceLinkItem {
  id: string;
  kinds: string[];
  status: "pending" | "active" | "revoked";
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  min_target_role: "owner" | "admin" | "editor" | "member" | "guest" | null;
  source_org_id: string;
  source_org_name: string;
  source_org_slug: string;
  target_org_id: string;
  target_org_name: string;
  target_org_slug: string;
  source_role: string | null;
  target_role: string | null;
}

// ─── Types for the methods above ────────────────────────────────────
export interface FileRecord {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: "image" | "document" | "video" | "other";
  width: number | null;
  height: number | null;
  variants: {
    original: { path: string; bytes: number };
    medium?: { path: string; bytes: number; width: number; height: number };
    thumb?: { path: string; bytes: number; width: number; height: number };
  };
  created_at: string;
}

export interface SavedView {
  id: string;
  entity_kind: string;
  name: string;
  view_type: string;
  config: Record<string, unknown>;
  is_default: boolean;
  /** v0.3: when true the dashboard renders this view's data inline. */
  pinned: boolean;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── core-apps (custom worker apps, H1) ──────────────────────────
/** A block is a structured, capability-gated unit on an app page. */
export type AppBlock =
  | { type: "view"; view_id: string; title?: string }
  | { type: "record"; kind: string; id_from: string }
  | { type: "action"; action_id: string; label?: string; kind?: string }
  | { type: "form"; kind: string; mode: "create" | "edit"; fields?: string[] }
  | { type: "stat"; view_id: string; agg: "count" | "sum"; field?: string; label?: string }
  | { type: "markdown"; body: string }
  | { type: "scan" }
  | { type: "custom"; html: string; height?: number };
export interface AppPage {
  slug: string;
  title: string;
  blocks: AppBlock[];
}
/** Per-app theme tokens. All optional; unset → Cobblr defaults. Colors
 *  are hex; `font` is a keyword the Player maps to a real family;
 *  `radius` is card-corner px. Stored + validated server-side (no raw
 *  CSS — can't inject a stylesheet). */
export interface AppTheme {
  bg?: string;
  surface?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accent_text?: string;
  border?: string;
  font?: "sans" | "serif" | "mono" | "rounded" | "slab";
  radius?: number;
  /** Wordmark image for the app's top bar — an http(s) or inline `data:` URL. */
  logo?: string;
  /** A custom font: an uploaded font stored as a `data:` URL, or a hosted
   *  font/CSS URL. Player injects an @font-face and uses `font_name`. */
  font_url?: string;
  font_name?: string;
}
/** List/nav metadata for an app (no page bodies). */
export interface WorkspaceAppMeta {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  visible_capability: string | null;
  /** Carried on the list so the portal launcher can inherit a skin. */
  theme?: AppTheme | null;
}
/** Full app definition returned by getApp. */
export interface WorkspaceApp extends WorkspaceAppMeta {
  pages: AppPage[];
  theme?: AppTheme | null;
  created_at?: string;
  updated_at?: string;
}

export interface ViewDataResponse {
  view: { id: string; entity_kind: string; view_type: string };
  items: Array<{
    kind: string;
    id: string;
    title: string;
    subtitle?: string;
    image_path?: string;
    detailUrl?: string;
    fields: Record<string, unknown>;
  }>;
}

export interface TagRecord {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
  icon: string | null;
  created_at: string;
}

export interface TagAttachment {
  id: string;
  tag_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role: string | null;
  created_at: string;
  // Joined on list:
  tag_name?: string;
  tag_color?: string | null;
}

export interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  fields: Record<string, unknown>;
}

/** One AI call in the activity log (list view). */
export interface AiActivityItem {
  id: string;
  user_id: string | null;
  capability: string;
  provider_id: string;
  model: string | null;
  input_summary: string | null;
  output_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  error?: string | null;
  source_kind: string | null;
  cached: boolean;
  invoked_at: string;
}
export interface AiActivityDetail extends AiActivityItem {
  input_full: string | null;
  output_full: string | null;
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

/** A write the agentic chat proposes; the user confirms before it runs. */
export type AiChatProposal =
  | { kind: "create"; entity_kind: string; fields: Record<string, unknown> }
  | { kind: "update"; entity_kind: string; entity_id: string; fields: Record<string, unknown>; entity_label?: string }
  | { kind: "delete"; entity_kind: string; entity_id: string; entity_label?: string }
  | {
      kind: "action";
      action_id: string;
      entity_kind: string;
      entity_id: string;
      entity_label?: string;
      args?: Record<string, unknown>;
    }
  | { kind: "build"; draft_id: string };

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

export interface DigifabFailureConfig {
  enabled: boolean;
  threshold: number;
  sample_interval_sec: number;
  auto_pause: boolean;
  backend: "auto" | "edge" | "llm" | "detector";
  detector_id: string | null;
}
export interface DigifabFailureStatus {
  watching: boolean; score: number; samples: number;
  last_probability: number | null; last_source: "edge" | "llm" | "detector" | null;
  paused: boolean; paused_at: string | null; last_sample_at: string | null;
}
export interface DigifabFailureCheck {
  available: boolean; reason?: string;
  probability?: number; source?: "edge" | "llm" | "detector"; would_trip?: boolean; projected_score?: number;
}

/** An external detection service the operator can point at a base URL. */
export interface DigifabDetectorCatalogEntry {
  key: string; name: string; summary?: string; shape: "frame-scorer" | "camera-watcher";
}
/** A configured detector connection (credentials never returned). */
export interface DigifabDetector {
  id: string; key: string; label: string; base_url: string;
  config: { camera_map?: Record<string, string> } & Record<string, unknown>;
  enabled: boolean; has_credentials: boolean;
  created_at?: string; updated_at?: string;
}
export interface DigifabDetectorInput {
  key: string; label: string; base_url: string;
  api_key?: string | null; config?: Record<string, unknown>; enabled?: boolean;
}
/** A camera the detector service reports (the import list, for the link picker). */
export interface DigifabDetectorCamera { id: string; name?: string; online?: boolean; printerId?: string; }
/** A provider a printer can be registered under, + its config form (JSON Schema). */
export interface DigifabDetectorProvider { id: string; label?: string; schema?: { properties?: Record<string, { title?: string; secret?: boolean; placeholder?: string; format?: string }>; required?: string[] } | null; }
/** A generic mirror mapping: a Cobblr connection type → a detector provider. */
export interface DigifabDetectorMapping { from: string; provider: string; perDevice: boolean; }
/** A printer the detector owns, with live print state (for consumption). */
export interface DigifabDetectorPrinter { id: string; name?: string; status?: string; progress?: number | null; }

export interface DigifabHistory {
  days: number;
  /** Dense daily trend over the window (zero-filled) — jobs + Bambu cloud tasks. */
  series?: { date: string; completed: number; failed: number; filament_g: number }[];
  summary: { total: number; completed: number; failed: number; cancelled: number; filament_g: number; hours: number };
  by_device: { name: string; total: number; completed: number; failed: number; filament_g: number }[];
  recent: { id: string; file_ref: string; sub_label?: string | null; cover?: string | null; device: string; connection_id?: string | null; device_id?: string | null; status: string; filament_g: number | null; at: string; duration_s?: number }[];
}

export interface DigifabLibraryItem {
  id: string;
  name: string;
  file_id: string;
  thumbnail_file_id: string | null;
  kind: string;
  size_bytes: number;
  plate_count: number;
  notes: string | null;
  /** Slicer metadata parsed at upload: est time / material / layer / ppp. */
  metadata?: {
    estimated_sec?: number;
    material?: string;
    layer_height_mm?: number;
    nozzle_mm?: number;
    filament_g?: number;
    parts_per_plate?: number;
    slicer?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface DigifabAmsSlot { id: string; type: string | null; color: string | null; remain: number | null; brand: string | null }
export interface DigifabDeviceDetail {
  live: boolean;
  updated_at?: string;
  lan?: { applicable: boolean; configured: boolean; host?: string; mode?: "cloud" | "prefer_lan" | "lan_only"; camera?: boolean };
  telemetry: {
    nozzle: number | null; nozzle_target: number | null;
    bed: number | null; bed_target: number | null;
    chamber: number | null;
    light: string | null;
    speed_level: number | null;
    nozzle_diameter: string | null; nozzle_type: string | null;
    wifi: string | null; gcode_state: string | null;
    firmware_update: boolean; hms_count: number;
    ams: DigifabAmsSlot[];
  } | null;
  job?: { fractionPrinted?: number; currentLayer?: number; timeLeftSec?: number; durationSec?: number } | null;
}

export interface DigifabFileInfo {
  name: string;
  size?: number;
  printTimeSec?: number;
  filamentMm?: number;
  height?: number;
  layerHeight?: number;
  numLayers?: number;
  generatedBy?: string;
  thumbnail?: string;
}

export interface DigifabControl {
  id: string;
  label: string;
  kind: "action" | "toggle" | "jog" | "number";
  group?: "print" | "motion" | "temperature" | "accessory";
  destructive?: boolean;
  axes?: string[];
  steps?: number[];
  unit?: string;
  min?: number;
  max?: number;
}

export interface EdgeShare {
  id: string;
  label: string;
  scope: "read" | "write";
  status: "pending" | "active" | "revoked" | "expired";
  machines: { id: string; label: string }[];
  grantees: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface DigifabConnection {
  id: string;
  type: string;
  label: string;
  base_url: string;
  /** Non-secret display config (e.g. a Bambu connection's `mode`). */
  config?: Record<string, unknown>;
  enabled: boolean;
  capabilities: { routing?: boolean } & Record<string, unknown>;
  last_sync_at: string | null;
  last_sync_status: string | null;
  created_at: string;
  updated_at: string;
}

export type DigifabDeviceClass = "printing" | "idle" | "paused" | "complete" | "offline" | "error" | "unknown";

export interface DigifabDeviceTemp {
  actual: number;
  target?: number;
}
export type BambuMode = "cloud" | "lan" | "hybrid";
export interface BambuModeCapabilities { monitor: boolean; control: boolean; available: boolean; note: string }
export interface BambuDiscoveredDevice { dev_id: string; name: string; model?: string; online: boolean; print_status?: string }
export type BambuLoginResponse =
  | { status: "need_email_code"; session: string }
  | { status: "need_tfa"; session: string }
  | { status: "ready"; session: string; devices: BambuDiscoveredDevice[] };

export interface DigifabFleetDevice {
  id: string;
  name: string;
  state: string;
  klass: DigifabDeviceClass;
  enabled: boolean;
  tags: string[];
  linked_machine_id: string | null;
  /** The linked machine's own identity (name/photo/lifecycle state) — when
   *  present the tile wears it, so fleet and registry are one identity. */
  linked_machine?: { id: string; name: string; image_path: string | null; state: string | null; detail_url?: string | null } | null;
  pool_id: string | null;
  pool_name: string | null;
  /** Cockpit: live temps the manager reports (°C), if any. */
  temps: { nozzle?: DigifabDeviceTemp | null; bed?: DigifabDeviceTemp | null; chamber?: DigifabDeviceTemp | null } | null;
  /** Cockpit: current job sub-stage (preheating/leveling/…) when reported — the
   *  "why isn't it printing yet" signal. */
  stage: string | null;
  /** Cockpit: a webcam/MJPEG stream URL (manual override or driver-reported). */
  camera_url: string | null;
  /** Snapshot relay (opt-in, off by default) + whether a fresh relayed frame is
   *  available right now (the web prefers it over camera_url for remote viewing). */
  snapshot_relay: boolean;
  snapshot_fresh: boolean;
  /** The bridge can grab this printer's own camera (the cockpit /camera route) —
   *  the camera wall shows it with no manual URL and no relay. */
  lan_camera?: boolean;
  /** AI failure-watch: live rolling score while printing + whether it auto-paused. */
  failure?: { score: number; watching: boolean; paused: boolean } | null;
  /** An external detector owns this printer's detection + camera — Cobblr stands
   *  down its own watch/assignment/camera pull for it. */
  managed_by_detector?: boolean;
  /** F-1: finished/failed a print — needs a human bed-clear before it's assignable. */
  needs_attention: { reason: string; since: string } | null;
  active_job: { id: string; file_ref: string; status: string; progress: number | null; priority: number; attempts: number; max_attempts: number; eta_sec: number | null } | null;
  /** What this machine will do next — the top queued job aimed at it (or its pool). */
  next_job: { id: string; file_ref: string; pooled: boolean } | null;
  /** Spatial floor-grid cell (arrange mode); null = unplaced. */
  position: { x: number; y: number } | null;
  /** Free-form layout: order in the flow (null = unplaced, trails in its own
   *  row) + whether this machine starts a new row. */
  sort_order?: number | null;
  row_break?: boolean;
  /** Real-time print telemetry from the printer itself (e.g. Bambu cloud MQTT) —
   *  for a print Cobblr didn't start, so there's no active_job to carry it. */
  live: { progress: number | null; remaining_min: number | null; layer_num: number | null; total_layers: number | null } | null;
}

export interface DigifabFleetConnection {
  connection_id: string;
  label: string;
  type: string;
  error: string | null;
  /** When this connection's device list was last fetched from its manager (F-11
   *  cache); null when the connection errored. May be up to ~10s stale. */
  fetched_at: string | null;
  /** Served from the last-good cache while a live refresh runs server-side. */
  stale?: boolean;
  devices: DigifabFleetDevice[];
}

export interface DigifabFleet {
  /** Any connection served stale — a quick follow-up refetch will be fresher. */
  stale?: boolean;
  connections: DigifabFleetConnection[];
  summary: {
    devices: number;
    printing: number;
    idle: number;
    offline: number;
    error: number;
    connections: number;
    connections_down: number;
    needs_attention: number;
  };
}

export interface Printer {
  id: string;
  name: string;
  /** "cups" | "edge" | "browser-bluetooth" | "mock" */
  driver: string;
  base_url: string;
  queue: string;
  is_default: boolean;
  notes: string | null;
  has_credentials: boolean;
  /** Driver-specific settings. For browser-bluetooth: dialect, width, calibration. */
  settings?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PrinterInput {
  name: string;
  driver: string;
  base_url: string;
  queue: string;
  credentials?: { username?: string; password?: string; apiKey?: string };
  is_default?: boolean;
  notes?: string;
  settings?: Record<string, unknown>;
}

export interface DigifabDevice {
  id: string;
  name: string;
  enabled: boolean;
  state?: string | null;
  tags?: string[];
}

export interface DigifabDriver {
  id: string;
  key: string;
  name: string;
  kind: string;
  spec: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface DigifabLink {
  id: string;
  connection_id: string;
  remote_device_id: string;
  remote_device_name: string | null;
  machine_id: string;
  machine_label: string | null;
  created_at: string;
}

// Print-update rules — channels (destinations) + rules (scope→cadence→message).
export interface DigifabChannel {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  created_at: string;
}
export type DigifabCadence = { type: "percent" | "minutes" | "layers"; every: number };
export type DigifabStep = { control: string; params?: Record<string, unknown> } | { wait_ms: number };
export interface DigifabRule {
  id: string;
  label: string;
  scope_type: "all" | "printer" | "tag" | "family";
  scope_value: string | null;
  channel_id: string;
  events: { started?: boolean; progress?: boolean; completed?: boolean; failed?: boolean };
  cadence: DigifabCadence[];
  cap_minutes: number | null;
  message: { title?: string; body?: string; photo?: boolean };
  pre_actions: DigifabStep[];
  post_actions: DigifabStep[];
  enabled: boolean;
  created_at: string;
}

export interface DigifabJob {
  id: string;
  connection_id: string | null;
  file_ref: string;
  target_device: string | null;
  target_tag: string | null;
  target_pool: string | null;
  material_part_id: string | null;
  material_grams: string | null;
  remote_file_id: string | null;
  remote_job_id: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  progress: number | null;
  error: string | null;
  file_id: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  /** A build (BoM) this job produces — consumed from inventory on send; reversed
   *  on scrap/cancel/fail. */
  linked_build_id: string | null;
  build_qty: number;
  build_consumed_at: string | null;
  build_reversed_at: string | null;
  created_at: string;
  updated_at: string;
  last_polled_at: string | null;
  /** True for a print started ON the machine (observed), not sent via Cobblr —
   *  read-only in the queue (no send/delete). */
  external?: boolean;
}

export interface DigifabPoolMember {
  connection_id: string;
  remote_device_id: string;
  loaded_material: string | null;
}

export interface DigifabRun {
  id: string;
  name: string;
  pool_id: string;
  file_id: string | null;
  file_ref: string;
  parts_per_plate: number;
  target_qty: number;
  completed_qty: number;
  status: "active" | "paused" | "completed" | "cancelled";
  jobs_queued: number;
  jobs_printing: number;
  jobs_awaiting_verdict: number;
  jobs_scrapped: number;
  created_at: string;
  updated_at: string;
}

export interface DigifabPool {
  id: string;
  name: string;
  config: Record<string, unknown>;
  members: DigifabPoolMember[];
}

export interface MaintenanceEntry {
  id: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  description: string | null;
  performed_at: string | null;
  scheduled_at: string | null;
  cost_cents: number | null;
  performed_by: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  created_at: string;
  updated_at: string;
}

export interface QrToken {
  id: string;
  token: string;
  entity_kind: string;
  entity_id: string;
  mode: "navigate" | "action";
  action_id: string | null;
  auth: "public" | "session";
  config: Record<string, unknown>;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  /** Ready-to-print scan URL the server built from the workspace's effective
   *  base (custom label base URL, else the serving origin) + /qr/<token>. */
  scan_url: string;
}

export interface QrSettings {
  token_style: "descriptive" | "opaque";
  /** Custom base URL printed codes encode, or null to use the serving origin. */
  label_base_url: string | null;
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

export interface NotificationEntry {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  read_at: string | null;
  created_at: string;
}

export interface CrossOrgNotificationEntry extends NotificationEntry {
  org_id: string;
  org_name: string;
  org_slug: string;
}

export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export type NotificationChannelName =
  | "in_app"
  | "browser_push"
  | "email"
  | "discord"
  | "webhook"
  | "slack"
  | "sms";

/** A row from notification_subscriptions, as returned by GET
 *  /me/notification-channels. `config` may contain `<set>` strings
 *  in place of secret values (webhook URLs, SMTP passwords, Twilio
 *  auth tokens) — the API redacts those on read. */
export interface NotificationChannelBinding {
  id: string;
  event_type: string;
  channel: NotificationChannelName;
  enabled: boolean;
  min_priority: NotificationPriority;
  config: Record<string, unknown> | null;
}

export interface NotificationChannelUpsert {
  org_id: string;
  event_type: string;
  channel: NotificationChannelName;
  enabled?: boolean;
  min_priority?: NotificationPriority;
  config?: Record<string, unknown>;
}

/** The account-level Communication Preferences matrix (Feature 1), as returned
 *  by GET /me/communication-prefs. `prefs[type][channel]` is the effective
 *  enablement (defaults already applied). Tier-1 types are shown locked. */
export interface CommunicationPrefs {
  channels: Array<"in_app" | "discord_dm" | "email">;
  discord_verified: boolean;
  types: Array<{ key: string; label: string; description: string; tier: 1 | 2 }>;
  prefs: Record<string, Record<string, boolean>>;
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

export interface ActivityEntry {
  id: number;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown | null;
  auth_method: "session" | "api_token" | "system";
  api_token_id: string | null;
  occurred_at: string;
  actor: { id: string; display_name: string | null; email: string | null } | null;
  token: { id: string; name: string; prefix: string | null } | null;
  /** The entity's display title resolved from its live record (server-side), so
   *  updates/creates show a name instead of the bare entity_type. Null when the
   *  record is gone (deleted) or the kind isn't resolvable. */
  entity_title?: string | null;
}

/** Shape of /me/activity rows — every workspace activity attributed
 *  to the caller, joined with the org's slug + name. */
export interface CrossOrgActivityEntry {
  id: string;
  action: string;
  module: string | null;
  entity_type: string | null;
  entity_id: string | null;
  diff: unknown | null;
  occurred_at: string;
  org_id: string;
  org_name: string;
  org_slug: string;
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
}

export interface InvitePreview {
  id: string;
  role: OrgMembership["role"];
  invited_email: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  org_name: string;
  org_slug: string;
  invited_by_name: string;
  status: "open" | "consumed" | "revoked" | "expired";
}

// ──────────── platform types (consumed by shared web components) ───

export interface PlatformEntityKind {
  id: string;
  module_name: string;
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: { name: string; type: string; role?: string }[];
  detail_route: string | null;
  endpoints: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** Set on registry records synthesized for a workspace's named instances
   *  (`<instance>:item`): endpoints are then relative to
   *  /instances/<instance_name>, not /modules/<module_name>. */
  instance_name?: string;
  version: string;
  /** Resolved 6-axis trait fingerprint (null if the kind declared none). */
  traits: Record<string, string | null | { trait: string; uncertain: true }> | null;
  /** Preset name if declared via shorthand. */
  profile: string | null;
}

// core-authoring — context assembler + validation result shapes.
export interface AuthoringContextKind {
  id: string;
  displayName: string;
  fields: { name: string; type: string; role?: string; required?: boolean }[];
}
export interface AuthoringContextAction {
  id: string;
  label: string;
  description: string;
}
export interface AuthoringContext {
  kinds: AuthoringContextKind[];
  actions: AuthoringContextAction[];
  output_contract: string;
  warnings: string[];
}
export interface BundleValidationError {
  path: string;
  code: string;
  message: string;
}
export interface BundleUpgradeConflict {
  entity_kind: string;
  name: string;
  field_label: string;
  attr: "label" | "choices" | "removed";
  yours: string | string[] | null;
  theirs: string | string[] | null;
}
export interface BundleValidationPreview {
  fields_added: { entity_kind: string; name: string; type: string; display_label: string }[];
  wires_added: { source_kind: string; action_id: string; trigger_type: string }[];
  modules_required: string[];
  modules_to_enable: string[];
  instances_created?: {
    module: string;
    instance_name: string;
    display_name: string;
    item_noun: string | null;
    fields: { name: string; type: string; display_label: string }[];
    wires: number;
  }[];
  nav_headings?: { name: string; members: { target_kind: string; target_id: string }[] }[];
  /** Phase 2 — on a self-upgrade, fields the user customized that this version
   *  changes. Empty on a fresh install. */
  upgrade_conflicts?: BundleUpgradeConflict[];
}
export interface BundleValidation {
  valid: boolean;
  errors: BundleValidationError[];
  preview: BundleValidationPreview | null;
}

export interface PlatformResolvedEntity {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  fields: Record<string, unknown>;
}

// core-units vocabulary (shapes match @cobblr/platform-web's types).
export type UnitDisplayMode = "symbol" | "name" | "both";
export interface UnitDef {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
}
export interface UnitInputBody {
  code: string;
  symbol: string;
  name: string;
  plural?: string;
  category?: string;
}
export interface UnitVocabulary {
  builtins: UnitDef[];
  custom: UnitDef[];
  display_mode: UnitDisplayMode;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  allDay?: boolean;
  source: string;
  category?: string;
  entityModule?: string;
  entityType?: string;
  entityId?: string;
  detailUrl?: string;
}
export interface CalendarFeed {
  enabled: boolean;
  token: string | null;
  url: string | null;
}

export interface PlatformAction {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: unknown;
  invoke_route: string | null;
  invoke_handler: string | null;
  /** Per-arg shape for the wire composer's structured "With" form; null if none. */
  args_schema: Record<string, { label: string; type: "text" | "number" | "boolean" }> | null;
  version: string;
}

/** appliesTo predicate — mirrors the platform-contract shape. */
export type ActionAppliesTo =
  | { any: true }
  | { kinds?: string[]; traits?: string[]; hasFieldRole?: string };

export interface RegisteredAction {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  default_applies_to: ActionAppliesTo;
  effective_applies_to: ActionAppliesTo;
  overridden: boolean;
  overridden_at: string | null;
  /** Entity-kind IDs the action currently matches, given the
   *  effective predicate. */
  matched_kinds: string[];
}

export interface RegisteredActionDetail {
  id: string;
  default_applies_to: ActionAppliesTo;
  effective_applies_to: ActionAppliesTo;
  overridden: boolean;
}

export interface PlatformActionBinding {
  binding_id: string;
  action_id: string;
  template: string | null;
  label: string;
  icon: string | null;
  invoke_route: string | null;
  invoke_handler: string | null;
}

export interface PlatformBinding {
  id: string;
  org_id: string;
  source_kind: string;
  action_id: string;
  trigger_type: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete" | "schedule";
  trigger_event: string | null;
  /** iCal RRULE for schedule-triggered wires; null otherwise. */
  trigger_schedule: string | null;
  template: string | null;
  filter: unknown | null;
  args: unknown | null;
  /** "self" (run on the source) or { rel, dir?, kind? } (run on linked entities). */
  target: "self" | { rel: string; dir?: "out" | "in"; kind?: string } | null;
  enabled: boolean;
  bundle_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NativeFieldOverride {
  id: string;
  org_id: string;
  entity_kind: string;
  name: string;
  display_label: string | null;
  hidden: boolean;
  position: number;
  bundle_id: string | null;
  source_module: string | null;
  /** 1b — open-ended presentation overrides; `choices` overrides the dropdown. */
  overrides: { choices?: string[] };
  created_at: string;
  updated_at: string;
}

/** A field SCOPE — a class of entity kinds a field def can be attached to
 *  instead of one kind ("all physical items"). The vocabulary is closed and
 *  owned by the server (it matches on each kind's declared traits); the client
 *  only ever names a scope by `key`, never describes one. Served on the
 *  no-kind field-defs read. */
export interface FieldScope {
  /** The canonical sentinel, e.g. "@physical" / "@physical+unique". */
  key: string;
  label: string;
  hint: string;
  /** The trait words this preset selects — what the picker ticks. */
  traits?: string[];
  /** "broad" = a loose one/two-axis scope ("anything physical").
   *  "profile" = a full 6-axis fingerprint, the named shapes modules declare
   *  their own kinds as ("owned-thing"). Rendered as two separate groups. */
  group?: "broad" | "profile";
}

export interface PlatformFieldDef {
  /** Owning bundle's identity when bundle-shipped — powers the manage-the-bundle link. */
  bundle_external_id?: string | null;
  bundle_name?: string | null;
  id: string;
  org_id: string;
  /** The kind this def applies to. When it came from a SCOPE, the server has
   *  already normalized this onto the kind you asked for — see `scope`. */
  entity_kind: string;
  /** Set when this def isn't keyed to one kind but to a CLASS of them (the scope
   *  sentinel it was created under, e.g. "@physical+unique" — a field on every
   *  physical, individually-tracked thing). Null for an ordinary per-kind def.
   *  Editing or deleting it reaches every kind it applies to. */
  scope?: string | null;
  /** That scope in words ("Things tracked one by one"). Render THIS, never the
   *  raw sentinel. Null for a per-kind def. */
  scope_label?: string | null;
  /** Trait scope to create this def under — ANY combination of the 12 traits (OR
   *  within an axis, AND across axes). When set on create, the server derives
   *  `entity_kind` from it, so the two can't disagree. */
  applies_to?: { traits: string[] };
  name: string;
  display_label: string;
  type: FieldDefType;
  required: boolean;
  position: number;
  bundle_id: string | null;
  source_module: string | null;
  choices: string[] | null;
  renderer: CatalogFieldRenderer | null;
  /** type='computed' only: the {{ }} template rendered read-only at
   *  resolve time. Null for stored value fields. */
  template: string | null;
  /** Plain-language one-line hint shown under the input. */
  help: string | null;
  /** The unit a type='number' value is measured in ("mm", "g") — free text,
   *  resolved against the units vocabulary at render time. Declares physical
   *  semantics; consumers never derive them from the field's name. */
  unit?: string | null;
  /** Form-builder section (field_sections.id) or null = ungrouped. */
  section_id?: string | null;
  /** Server-managed: the value is computed/stamped server-side and a client
   *  write is never accepted — render read-only, never as an input. */
  server_managed?: boolean | null;
  /** type='relation' only: the referenced entity-kind id (e.g.
   *  "core-locations:location"). Stored value = the target entity's id. */
  ref_kind?: string | null;
  /** Semantic DECODE role (P3): `identifier:<decoderId>` (holds a decodable
   *  code) or `decode:<key>` (a fill target for the decoder's <key> output).
   *  Lets the guarded-auto VIN fill target fields by declared role. */
  decode_role?: string | null;
  created_at: string;
}

/** A named form-builder section grouping a kind's fields under a heading. */
export interface FieldSection {
  id: string;
  entity_kind?: string;
  name: string;
  position: number;
}

export interface PlatformBundle {
  id: string;
  external_id: string;
  name: string;
  version: string;
  author: string | null;
  description: string | null;
  source_url: string | null;
  installed_at: string;
  /** The full manifest persisted at install time. Used by the nav
   *  to read `provides_lens` so lens-contributing bundles render
   *  under their parent module's popover. */
  manifest?: PlatformBundleManifest;
  /** Which opt-in features are enabled on this installed bundle. */
  enabled_features?: string[];
}

export interface PlatformBundleManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
  /** Catalog tier (default `core`): `core` = suggested per-scan + browsable;
   *  `extended` = browsable but not suggested per-scan; `disabled` = hidden
   *  everywhere (existing installs keep working). See api lib/flagship-bundles.ts. */
  catalog?: "core" | "extended" | "disabled";
  /** Release date of THIS version (ISO date), shown on the update prompt. */
  released_at?: string;
  /** Plain-language "what changed in this version" — shown prominently when
   *  the user is updating an installed bundle. The technical detail (new
   *  modules / wires / fields) stays in the requires/details accordion. */
  changelog?: string;
  /** v1.5: markdown walkthrough rendered on the bundle detail page. */
  readme_md?: string;
  /** v1.5: image URLs displayed as a screenshot strip. */
  screenshots?: string[];
  requires?: { module: string; version?: string }[];
  wires?: {
    source_kind: string;
    action_id: string;
    trigger_type?: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete";
    trigger_event?: string;
    template?: string;
    filter?: Record<string, unknown>;
    args?: Record<string, unknown>;
    /** Where the action lands: "self" (default), "none", or a routed target —
     *  the server stores it verbatim (see the bundle-install contract). */
    target?: unknown;
  }[];
  field_defs?: {
    entity_kind: string;
    name: string;
    display_label: string;
    // Was a second hand-written copy, and it was missing "relation" - so a
    // relation field read back as a type this client did not believe existed.
    type: FieldDefType;
    required?: boolean;
    position?: number;
    /** When type='text', renders as a dropdown of these choices. */
    choices?: string[];
    /** When type='computed', the {{ }} template rendered read-only. */
    template?: string;
    /** Built-in display renderer (color-hex swatch, url-link, …). */
    renderer?: "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code";
    /** Plain-language one-line hint shown under the input ("the maker's named
     *  shade — e.g. 'Peacock Heather'") so jargon fields explain themselves. */
    help?: string;
    /** The unit a type='number' value is measured in ("mm", "g") — free text,
     *  resolved against the units vocabulary; declares physical semantics. */
    unit?: string;
    /** Semantic RECORD role: `category` (this table's grouping axis) or `pack`
     *  (the packaging-count field, filled from the scanned package). */
    // The shared list, not a copy: this union had already drifted (it was
    // missing "identifier") and a stale copy silently rejects a valid role.
    field_role?: FieldRole;
    /** Scan-decode role: `identifier:<kind>` (this field carries the scanned
     *  identifier, e.g. a VIN) or `decode:<key>` (fill from the decoder's
     *  output). Mirrors the server contract's FieldDefEntry. */
    decode_role?: string;
  }[];
  /** Presentation overrides for a kind's native fields (relabel / hide). */
  field_overrides?: {
    entity_kind: string;
    name: string;
    display_label?: string;
    hidden?: boolean;
    position?: number;
    /** Override-layer decode role — wins over the field-def's own. */
    decode_role?: string;
  }[];
  /** Saved views the bundle installs (optionally pinned to the dashboard). */
  saved_views?: {
    entity_kind: string;
    name: string;
    view_type?: string;
    config?: Record<string, unknown>;
    pinned?: boolean;
    is_default?: boolean;
  }[];
  /** Optional lens contribution — turns this bundle into a Pillar-E
   *  specialisation. The nav reads installed bundles with
   *  provides_lens to render lens chips under the parent module. */
  provides_lens?: {
    entity_kind: string;
    name: string;
    display_name: string;
  };
  /** Phase 2: opt-in features (checkboxes in the install modal). The arrays
   *  above are the always-on BASE; each enabled feature merges its same-shaped
   *  arrays in. Toggleable later via re-install with a new enabled set. */
  features?: PlatformBundleFeature[];
  /** Module instances this bundle creates on install (skinned copies of a
   *  multi-instance module — e.g. an "inventory" instance named "Yarn"). Each
   *  instance's fields/views/wires apply scoped to `<instance_name>:item`. */
  provides_instances?: PlatformBundleInstance[];
  /** Catalog shells this bundle installs (name + schema config, no rows). Rows
   *  load separately via CSV import or a puller. A feature can carry its own. */
  catalogs?: PlatformBundleCatalog[];
  /** WorkspaceApps this bundle seeds on install (e.g. the Outfit Planner). */
  provides_apps?: PlatformBundleApp[];
  /** Data migrations the bundle owns — run automatically + idempotently when the
   *  user upgrades from a version below `to_version`. Each invokes a registered
   *  generic action (e.g. inventory:lift-to-type) against their data. */
  migrations?: Array<{ to_version: string; action: string; args?: Record<string, unknown> }>;
}

/** A WorkspaceApp a bundle seeds — pages → blocks (a custom block carries its
 *  own HTML). Validated structurally on install, deeply by core-apps. */
export interface PlatformBundleApp {
  slug: string;
  name: string;
  icon?: string;
  visible_capability?: string | null;
  pages: { slug: string; title: string; blocks: Record<string, unknown>[] }[];
  theme?: Record<string, unknown> | null;
}

/** A module instance a bundle creates — its own nav entry, fields, views, and
 *  add flow, isolated to the instance kind `<instance_name>:item`. */
export interface PlatformBundleInstance {
  module: string;
  instance_name: string;
  display_name: string;
  glyph?: string;
  /** Singular noun for the add button + modal title ("yarn" → "New yarn"). */
  item_noun?: string;
  /** Default unit for new items (e.g. "skein"). */
  qty_unit?: string;
  /** When items belong to a parent "type" in another instance (Spool →
   *  Filament type), the forms show a parent picker + write an `instance-of`
   *  pairing. `instance` is the parent instance name. */
  parent?: {
    instance: string;
    label?: string;
    relationship_kind?: string;
    // Auto-lift keys: a created item carrying these find-or-creates its parent
    // type (scan path); copy_fields carry the type-defining attrs up.
    key_fields?: string[];
    copy_fields?: string[];
  };
  /** Visually group this instance with siblings sharing the same `key` into
   *  one connected navbar element (a quiet `label` stem + each member's name
   *  as a segment). Presentational + generic. */
  nav_group?: {
    key: string;
    label: string;
  };
  /** Domain terms that sharpen scan ROUTING to this instance (yarn →
   *  ["yarn","skein","wool","ball-band"]). Additive — routing works off noun +
   *  fields when absent. */
  scan_keywords?: string[];
  field_defs?: PlatformBundleManifest["field_defs"];
  field_overrides?: PlatformBundleManifest["field_overrides"];
  saved_views?: PlatformBundleManifest["saved_views"];
  wires?: PlatformBundleManifest["wires"];
}

/** A catalog SHELL a bundle installs — schema config only, no rows. Mirrors the
 *  server-side CatalogEntry (bundles.ts). Rows load via CSV import or a puller. */
export interface PlatformBundleCatalog {
  external_id: string;
  name: string;
  description?: string;
  source_url?: string;
  puller_id?: string;
  schema?: {
    id_column?: string;
    title_column?: string;
    image_column?: string;
    subtitle_column?: string;
    description_column?: string;
    field_renderers?: Record<
      string,
      "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code"
    >;
    field_labels?: Record<string, string>;
    /** Catalog-match prefill: `{ catalogPayloadKey: instanceFieldName }`. */
    field_map?: Record<string, string>;
    bindable_to_kinds?: string[];
    semantic_type?: string;
    hero_field?: string;
    hero_renderer?: "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code";
    exclude_from_global_search?: boolean;
  };
}

/** An opt-in capability of a bundle — its contributions merge into the
 *  manifest when its key is enabled. */
export interface PlatformBundleFeature {
  key: string;
  name: string;
  description?: string;
  /** The question form of the feature, shown in the install modal
   *  ("Want to track your designs too?"). Falls back to `name`. Display-only. */
  question?: string;
  /** Pre-checked in the install modal. Default false → installs "basic". */
  default?: boolean;
  requires?: PlatformBundleManifest["requires"];
  wires?: PlatformBundleManifest["wires"];
  field_defs?: PlatformBundleManifest["field_defs"];
  field_overrides?: PlatformBundleManifest["field_overrides"];
  saved_views?: PlatformBundleManifest["saved_views"];
  /** Instances this feature creates when enabled (e.g. the "hooks" feature
   *  creates a Hooks inventory instance). */
  provides_instances?: PlatformBundleManifest["provides_instances"];
  /** WorkspaceApps this feature seeds when enabled (e.g. the Outfit Planner). */
  provides_apps?: PlatformBundleManifest["provides_apps"];
  /** Catalog shells this feature installs when enabled (e.g. the Rebrickable
   *  catalogs behind "Link to Rebrickable"). */
  catalogs?: PlatformBundleCatalog[];
  /** Post-install guided steps (web nav only; stripped server-side). */
  next_steps?: { label: string; module: string; path?: string; hint?: string }[];
}

/** A bundle entry in the extension registry index — the manifest plus the
 *  card metadata. `source` = "official" or the third-party source URL. */
export interface RegistryBundleEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  glyph?: string;
  blurb?: string;
  requires?: string[];
  manifest: PlatformBundleManifest;
  source: string;
}
/** A declarative-HTTP driver entry (digifab). `manifest` is the full
 *  DriverManifest posted to the driver install endpoint. */
export interface RegistryDriverEntry {
  id: string;
  name: string;
  version?: string;
  glyph?: string;
  blurb?: string;
  /** "Authored from the API; verify against your hardware" style note. */
  caveat?: string;
  manifest: Record<string, unknown>;
  source: string;
}
/** A signed WASM module entry — installed via the super-admin sandbox path. */
export interface RegistryModuleEntry {
  name: string;
  version: string;
  description?: string;
  glyph?: string;
  blurb?: string;
  release_url?: string;
  pubkey?: string;
  source: string;
  /** Trust tier (Phase D): "official" = signed by a Cobblr-vouched key on
   *  a root-verified index; "unverified" = install behind a consent gate. */
  trust?: "official" | "unverified";
}
/** A sandboxed file-preview renderer (core-file-preview). `renderer_js` is
 *  untrusted code that runs only in an opaque-origin iframe. */
export interface RegistryRendererEntry {
  name: string;
  version?: string;
  exts: string[];
  description?: string;
  glyph?: string;
  blurb?: string;
  renderer_js: string;
  pubkey?: string;
  signature?: string;
  source: string;
  trust?: "official" | "unverified";
}
/** A renderer the workspace has installed (GET .../core-file-preview/renderers). */
export interface InstalledRenderer {
  id: string;
  name: string;
  version: string | null;
  exts: string[];
  renderer_js: string;
  signed_by: string | null;
}
/** The merged extension catalog returned by GET /registry/index. */
export interface RegistryIndex {
  schema: number;
  bundles: RegistryBundleEntry[];
  drivers: RegistryDriverEntry[];
  modules: RegistryModuleEntry[];
  renderers: RegistryRendererEntry[];
  sources: Array<{ url: string; label: string; ok: boolean; error?: string }>;
  /** Whether the official index's detached sig verified against the baked
   *  root key. null = no root anchor configured (status-quo trust). */
  official_root_verified: boolean | null;
}
