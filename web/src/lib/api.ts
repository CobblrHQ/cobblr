// Thin fetch wrapper. Reads the auth token from localStorage on every
// call so the AuthProvider can update it without rewiring the client.
// Everything goes through `request<T>` so error shape stays uniform.

const TOKEN_KEY = "cobblr.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

// ─────────────────────────── public api ──────────────────────────

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  /** True when an admin minted this account with a temp password. UI
   *  redirects to /me/force-password-reset until cleared. PATCH
   *  /me/password clears it. */
  must_reset_password: boolean;
  /** True when this user's email is in the platform's
   *  SUPERADMIN_EMAILS env var. Unlocks the /super-admin/* shell. */
  is_platform_admin?: boolean;
}

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "guest";
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
  orgs: OrgMembership[];
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

export interface Order {
  id: string;
  vendor: string | null;
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
  created_at: string;
  updated_at: string;
}

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

export interface OrgModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
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
  authConfig: () =>
    request<{ signup_enabled: boolean }>("GET", "/auth/config"),
  signup: (body: {
    email: string;
    password: string;
    display_name: string;
    org_name: string;
  }) => request<AuthResponse>("POST", "/auth/signup", body),
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
  me: () => request<MeResponse>("GET", "/me"),
  orgLocal: (slug: string) => request<OrgLocalResponse>("GET", `/orgs/${slug}/local`),
  listOrgs: () => request<{ items: OrgMembership[] }>("GET", "/orgs"),
  createOrg: (name: string) =>
    request<{ org: OrgMembership; slug: string }>("POST", "/orgs", { name }),

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

  // inventory module — just enough to count parts by location (the
  // configuration/locations page needs it). Module-specific UI lives
  // inside the inventory module itself.
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

  // Long-lived API tokens
  listApiTokens: () =>
    request<{ items: ApiTokenListItem[] }>("GET", "/me/api-tokens"),
  mintApiToken: (body: { name: string; expires_at?: string }) =>
    request<{
      id: string;
      name: string;
      token_prefix: string;
      expires_at: string | null;
      created_at: string;
      token: string;
    }>("POST", "/me/api-tokens", body),
  revokeApiToken: (id: string) =>
    request<void>("DELETE", `/me/api-tokens/${id}`),
  orgActivity: (slug: string, limit = 25) =>
    request<{ items: ActivityEntry[] }>("GET", `/orgs/${slug}/activity?limit=${limit}`),
  // Cross-workspace activity feed: every action attributed to any
  // workspace the caller belongs to. Optional ?org= narrows to one.
  meActivity: (opts: { limit?: number; org?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.org) qs.set("org", opts.org);
    return request<{ items: CrossOrgActivityEntry[] }>(
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
  ) => request<{ ok: boolean; result: unknown }>("POST", `/orgs/${slug}/actions/invoke`, body),

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
  listFieldDefs: (slug: string, kind?: string) => {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<{ items: PlatformFieldDef[] }>("GET", `/orgs/${slug}/field-defs${qs}`);
  },
  createFieldDef: (slug: string, body: Partial<PlatformFieldDef>) =>
    request<PlatformFieldDef>("POST", `/orgs/${slug}/field-defs`, body),
  updateFieldDef: (slug: string, id: string, body: Partial<PlatformFieldDef>) =>
    request<PlatformFieldDef>("PATCH", `/orgs/${slug}/field-defs/${id}`, body),
  deleteFieldDef: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/field-defs/${id}`),
  appendFieldDefChoice: async (slug: string, id: string, value: string) => {
    // Fetch current choices, append, PATCH.
    const list = await request<{ items: PlatformFieldDef[] }>("GET", `/orgs/${slug}/field-defs`);
    const cur = list.items.find((f) => f.id === id);
    const choices = [...(cur?.choices ?? []), value];
    return request<PlatformFieldDef>("PATCH", `/orgs/${slug}/field-defs/${id}`, { choices });
  },

  // Bundles (C.2)
  listBundles: (slug: string) =>
    request<{ items: PlatformBundle[] }>("GET", `/orgs/${slug}/bundles`),
  installBundle: (slug: string, manifest: PlatformBundleManifest) =>
    request<{ bundle: PlatformBundle; applied: { wires: number; field_defs: number } }>(
      "POST",
      `/orgs/${slug}/bundles/install`,
      { manifest },
    ),
  uninstallBundle: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/bundles/${id}`),

  // ─── core-authoring (AI bundle builder, Phase 1: copy-paste) ───────
  authoringContext: (slug: string, selected_kinds?: string[]) =>
    request<AuthoringContext>("POST", `/orgs/${slug}/modules/core-authoring/context`, { selected_kinds }),
  authoringCompile: (slug: string, body: { intent: string; selected_kinds?: string[] }) =>
    request<{ draft_id: string; prompt: string; warnings: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/compile`,
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
    request<{ applied: boolean; bundle: unknown }>(
      "POST",
      `/orgs/${slug}/modules/core-authoring/drafts/${draftId}/apply`,
      { confirm },
    ),
  getBundle: (slug: string, id: string) =>
    request<{
      bundle: PlatformBundle & { manifest: unknown };
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
  changeMyPassword: (body: { current_password: string; new_password: string }) =>
    request<void>("POST", "/me/password", body),

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
  fileRawUrl: (slug: string, id: string, variant?: "medium" | "thumb" | "original") =>
    `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw${variant ? `?variant=${variant}` : ""}`,

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
  createTag: (slug: string, body: { name: string; color?: string | null }) =>
    request<TagRecord>("POST", `/orgs/${slug}/modules/core-tags/tags`, body),
  updateTag: (
    slug: string,
    id: string,
    body: { name?: string; color?: string | null },
  ) =>
    request<TagRecord>(
      "PATCH",
      `/orgs/${slug}/modules/core-tags/tags/${id}`,
      body,
    ),
  deleteTag: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-tags/tags/${id}`),
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
  createDigifabConnection: (
    slug: string,
    body: {
      type: string;
      label: string;
      base_url: string;
      api_key?: string;
      username?: string;
      password?: string;
    },
  ) => request<DigifabConnection>("POST", `/orgs/${slug}/modules/digifab/connections`, body),
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
  deleteDigifabConnection: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/digifab/connections/${id}`),
  listDigifabDrivers: (slug: string) =>
    request<{ builtins: { key: string; name: string; kind: string }[]; installed: DigifabDriver[] }>(
      "GET",
      `/orgs/${slug}/modules/digifab/drivers`,
    ),
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
  listDigifabJobs: (slug: string) =>
    request<{ items: DigifabJob[] }>("GET", `/orgs/${slug}/modules/digifab/jobs`),
  createDigifabJob: (
    slug: string,
    body: {
      connection_id: string;
      file_ref: string;
      target_device?: string | null;
      target_tag?: string | null;
      file_id?: string | null;
      linked_machine_id?: string | null;
      linked_task_id?: string | null;
    },
  ) => request<DigifabJob>("POST", `/orgs/${slug}/modules/digifab/jobs`, body),
  sendDigifabJob: (slug: string, id: string) =>
    request<{ status: string; remote_job_id: string | null; placement: unknown; uploaded_bytes?: number }>(
      "POST",
      `/orgs/${slug}/modules/digifab/jobs/${id}/send`,
      {},
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

  // ─── core-labels-qr (minted QR tokens) ────────────────────────────
  listQrTokens: (slug: string) =>
    request<{ items: QrToken[] }>(
      "GET",
      `/orgs/${slug}/modules/core-labels-qr/tokens`,
    ),
  revokeQrToken: (slug: string, id: string) =>
    request<QrToken>(
      "POST",
      `/orgs/${slug}/modules/core-labels-qr/tokens/${id}/revoke`,
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
    min_target_role?: "owner" | "admin" | "member" | "guest" | null;
  }) => request<WorkspaceLinkItem>("POST", "/me/links", body),
  acceptWorkspaceLink: (id: string) =>
    request<WorkspaceLinkItem>("POST", `/me/links/${id}/accept`),
  revokeWorkspaceLink: (id: string) =>
    request<void>("POST", `/me/links/${id}/revoke`),
  patchWorkspaceLink: (
    id: string,
    body: {
      expires_at?: string | null;
      min_target_role?: "owner" | "admin" | "member" | "guest" | null;
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
  // names. See docs/design-decisions/instances.md.
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
  // See docs/design-decisions/nav-builder.md.
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
  // docs/design-decisions/core-integrations.md.
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

  // core-scan — barcode + photo identification, generalized. See
  // docs/design-decisions/core-scan.md.
  scanBarcode: (
    slug: string,
    body: {
      barcode?: string;
      source_kind?: "barcode" | "photo" | "url" | "receipt";
      source_url?: string;
      image_file_id?: string;
      scan_batch_id?: string;
      scan_area?: string;
      enrich_ms?: number;
    },
  ) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/scan`, body),
  listScanInbox: (
    slug: string,
    q: { status?: "pending" | "enriching" | "resolved" | "discarded"; batch_id?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.status) params.set("status", q.status);
    if (q.batch_id) params.set("batch_id", q.batch_id);
    const qs = params.toString();
    return request<{ items: ScanInboxItem[] }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox${qs ? "?" + qs : ""}`,
    );
  },
  getScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>("GET", `/orgs/${slug}/modules/core-scan/inbox/${id}`),
  confirmScanItem: (
    slug: string,
    id: string,
    body: {
      target_module?: string;
      target_kind?: string;
      name?: string;
      location_id?: string;
      quantity?: number;
      extras?: Record<string, unknown>;
    },
  ) =>
    request<{ item: ScanInboxItem; created: { id: string } }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm`,
      body,
    ),
  discardScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/discard`,
    ),
  rerunScanAi: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/rerun-ai`,
    ),
  createScanBatch: (slug: string) =>
    request<{ id: string }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/batches`,
      {},
    ),

  // core-ai — provider config + capability defaults + usage. See
  // docs/design-decisions/core-ai.md.
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
  listAiCalls: (slug: string, limit = 50) =>
    request<{ items: AiCall[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/calls?limit=${limit}`,
    ),
  getAiUsageSummary: (slug: string) =>
    request<{ since: string; items: AiUsageSummaryRow[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/summary`,
    ),

  // core-catalogs — imported reference datasets (Rebrickable parts,
  // McMaster catalog, ISBN, etc.). User entities point at rows here
  // via `entity_pairings` with `relationship_kind: "matches"`.
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
  // docs/homebox-parity-report.md punch-list item #2.
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
    return request<{ items: CatalogEntry[]; title_column: string }>(
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
  // capability grants. See docs/design-decisions/member-portal-and-
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
    body: { email: string; display_name: string; role: "owner" | "admin" | "member" | "guest" },
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
  superAdminOverview: () =>
    request<{
      orgs_count: number;
      users_count: number;
      active_users_7d: number;
      activity_24h: number;
      capability_grants: number;
      bundles_installed: number;
    }>("GET", `/super-admin/overview`),
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
};

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
  credentials: Record<string, { label: string; secret: boolean }>;
  capabilities: Record<string, { models: string[]; defaultModel?: string }>;
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
  credentials: Record<string, { label: string; secret: boolean }>;
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

export interface Location {
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: number;
  kind: "area" | "container";
  metadata: Record<string, unknown>;
  description: string | null;
  notes: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanInboxItem {
  id: string;
  status: "pending" | "enriching" | "resolved" | "discarded";
  source_kind: "barcode" | "photo" | "url" | "receipt";
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  suggested_metadata: Record<string, unknown>;
  ai_notes: string | null;
  ai_confidence: string | null;
  ai_suggested_at: string | null;
  target_module: string | null;
  target_kind: string | null;
  target_entity_id: string | null;
  target_location_id: string | null;
  scan_batch_id: string | null;
  scan_area: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
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
  | "code";       // monospace + bg, for SKUs / model numbers

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
  role: "owner" | "admin" | "member" | "guest";
  grants: string[];
  /** Custom-role assignments — array of workspace_roles.id values. */
  custom_role_ids: string[];
}

export interface GrantableAction {
  action_id: string;
  label: string;
  description: string;
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
  min_target_role: "owner" | "admin" | "member" | "guest" | null;
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

export interface DigifabConnection {
  id: string;
  type: string;
  label: string;
  base_url: string;
  enabled: boolean;
  capabilities: { routing?: boolean } & Record<string, unknown>;
  last_sync_at: string | null;
  last_sync_status: string | null;
  created_at: string;
  updated_at: string;
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

export interface DigifabJob {
  id: string;
  connection_id: string;
  file_ref: string;
  target_device: string | null;
  target_tag: string | null;
  remote_file_id: string | null;
  remote_job_id: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  file_id: string | null;
  linked_machine_id: string | null;
  linked_task_id: string | null;
  created_at: string;
  updated_at: string;
  last_polled_at: string | null;
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
  endpoints: { get?: string } | null;
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
export interface BundleValidationPreview {
  fields_added: { entity_kind: string; name: string; type: string; display_label: string }[];
  wires_added: { source_kind: string; action_id: string; trigger_type: string }[];
  modules_required: string[];
  modules_to_enable: string[];
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

export interface PlatformAction {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: unknown;
  invoke_route: string | null;
  invoke_handler: string | null;
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
  trigger_type: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete";
  trigger_event: string | null;
  template: string | null;
  filter: unknown | null;
  args: unknown | null;
  enabled: boolean;
  bundle_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformFieldDef {
  id: string;
  org_id: string;
  entity_kind: string;
  name: string;
  display_label: string;
  type: "text" | "number" | "boolean" | "date" | "url";
  required: boolean;
  position: number;
  bundle_id: string | null;
  source_module: string | null;
  choices: string[] | null;
  renderer: CatalogFieldRenderer | null;
  created_at: string;
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
}

export interface PlatformBundleManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
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
  }[];
  field_defs?: {
    entity_kind: string;
    name: string;
    display_label: string;
    type: "text" | "number" | "boolean" | "date" | "url";
    required?: boolean;
    position?: number;
    /** When type='text', renders as a dropdown of these choices. */
    choices?: string[];
  }[];
  /** Optional lens contribution — turns this bundle into a Pillar-E
   *  specialisation. The nav reads installed bundles with
   *  provides_lens to render lens chips under the parent module. */
  provides_lens?: {
    entity_kind: string;
    name: string;
    display_name: string;
  };
}
