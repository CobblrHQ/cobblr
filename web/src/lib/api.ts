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
  // 204s have no body; handle that explicitly.
  if (res.status === 204) return undefined as T;

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
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

export const api = {
  /** Escape hatch for ad-hoc reads from pages that don't deserve a
   *  dedicated method (e.g. dashboard snapshot widgets that hit a
   *  module's own routes). Avoid in module code — modules go through
   *  the platform contract. */
  request: <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    request<T>(method, path, body),
  healthz: () => request<Healthz>("GET", "/healthz"),
  signup: (body: {
    email: string;
    password: string;
    display_name: string;
    org_name: string;
  }) => request<AuthResponse>("POST", "/auth/signup", body),
  login: (body: { email: string; password: string }) =>
    request<AuthResponse>("POST", "/auth/login", body),
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

  // machines module
  listMachines: (slug: string) =>
    request<{ items: Machine[] }>("GET", `/orgs/${slug}/modules/machines/machines`),
  getMachine: (slug: string, id: string) =>
    request<Machine>("GET", `/orgs/${slug}/modules/machines/machines/${id}`),
  createMachine: (slug: string, body: Partial<Machine>) =>
    request<Machine>("POST", `/orgs/${slug}/modules/machines/machines`, body),
  updateMachine: (slug: string, id: string, body: Partial<Machine>) =>
    request<Machine>("PATCH", `/orgs/${slug}/modules/machines/machines/${id}`, body),
  deleteMachine: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/machines/machines/${id}`),

  // purchases module
  listOrders: (slug: string) =>
    request<{ items: Order[] }>("GET", `/orgs/${slug}/modules/purchases/orders`),
  getOrder: (slug: string, id: string) =>
    request<Order & { items: OrderItem[] }>("GET", `/orgs/${slug}/modules/purchases/orders/${id}`),
  createOrder: (slug: string, body: Partial<Order>) =>
    request<Order>("POST", `/orgs/${slug}/modules/purchases/orders`, body),
  updateOrder: (slug: string, id: string, body: Partial<Order>) =>
    request<Order>("PATCH", `/orgs/${slug}/modules/purchases/orders/${id}`, body),
  deleteOrder: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/purchases/orders/${id}`),
  addOrderItem: (slug: string, orderId: string, body: Partial<OrderItem>) =>
    request<OrderItem>("POST", `/orgs/${slug}/modules/purchases/orders/${orderId}/items`, body),

  // assets module
  listAssets: (slug: string) =>
    request<{ items: Asset[] }>("GET", `/orgs/${slug}/modules/assets/assets`),
  getAsset: (slug: string, id: string) =>
    request<Asset>("GET", `/orgs/${slug}/modules/assets/assets/${id}`),
  createAsset: (slug: string, body: Partial<Asset>) =>
    request<Asset>("POST", `/orgs/${slug}/modules/assets/assets`, body),
  updateAsset: (slug: string, id: string, body: Partial<Asset>) =>
    request<Asset>("PATCH", `/orgs/${slug}/modules/assets/assets/${id}`, body),
  deleteAsset: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/assets/assets/${id}`),

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

  // Notifications
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
};

export interface NotificationEntry {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  read_at: string | null;
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
}

export interface PlatformBundleManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
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
  }[];
}
