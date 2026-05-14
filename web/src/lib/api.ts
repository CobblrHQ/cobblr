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

export interface ActivityEntry {
  id: number;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown | null;
  occurred_at: string;
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
  orgActivity: (slug: string, limit = 25) =>
    request<{ items: ActivityEntry[] }>("GET", `/orgs/${slug}/activity?limit=${limit}`),
  modules: () => request<{ items: ModuleListItem[] }>("GET", "/modules"),
};
