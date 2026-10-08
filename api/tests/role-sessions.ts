// A session in the same workspace for each role, and the assistant's door
// (the MCP endpoint) for a session, so a test can ask "can an editor do this
// through the API and through Cobb?" without each file re-deriving it.
//
// Every test that writes as the owner proves nothing about the other four
// roles: an editor once could read the whole workspace and write nothing in
// it, and nothing noticed because every test ran as the owner
// (@cobblr/platform-contract/org-roles).

import { ORG_ROLES, type InvitableOrgRole, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { BASE, http, org, type TestSession } from "./helpers.js";

export type OtherRole = InvitableOrgRole;
/** Every role that writes: all but the read-only guest. */
export const WRITING_ROLES = ORG_ROLES.filter((r): r is Exclude<OrgRoleName, "guest"> => r !== "guest");

/** A person with `role` in the owner's workspace, signed in. */
export async function sessionAs(owner: TestSession, role: OtherRole): Promise<TestSession> {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cobblr-test.local`;
  const made = await http<{ temp_password: string; user: { id: string } }>(owner, org(owner, "/admin/users"), {
    method: "POST",
    body: { email, display_name: `A ${role}`, role },
  });
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: made.temp_password }),
  });
  const first = (await login.json()) as { token: string };
  if (!first.token) throw new Error(`could not sign in the ${role}`);
  // A made account starts on a temporary password and may read but not
  // write until it picks its own, as a person would on first sign-in.
  const reset = await fetch(`${BASE}/api/v1/me/password`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` },
    body: JSON.stringify({ current_password: made.temp_password, new_password: `${role}-own-password-9` }),
  });
  const after = (await reset.json()) as { token?: string };
  return { token: after.token ?? first.token, slug: owner.slug, orgId: owner.orgId, userId: made.user.id };
}

/** A status and the body, for a request that may be refused. */
export async function attempt<T = unknown>(s: TestSession, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${s.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a refusal page can be plain text */
  }
  return { status: res.status, body: body as T };
}

/** One call through the assistant's door: ok with the tool's answer, or the
 *  refusal it gave. */
export async function cobb(s: TestSession, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${BASE}/api/v1/hooks/mcp?workspace=${s.slug}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) return { ok: false, data: null, text: `HTTP ${res.status}` };
  const body = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  if (!body.result) return { ok: false, data: null, text: body.error?.message ?? "no result" };
  const text = body.result.content[0]?.text ?? "";
  if (body.result.isError) return { ok: false, data: null, text };
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { ok: true, data, text };
}

/** An action through the API's door, as `s`: ok with its answer, or refused. */
export async function invokeAs(s: TestSession, actionId: string, args: Record<string, unknown>, entity?: { kind: string; id: string }): Promise<{ ok: boolean; status: number; result: Record<string, unknown> | null }> {
  const r = await attempt<{ result?: Record<string, unknown> & { ok?: boolean } }>(s, org(s, "/actions/invoke"), {
    method: "POST",
    body: { actionId, args, ...(entity ? { entityKind: entity.kind, entityId: entity.id } : {}) },
  });
  const result = (r.body && typeof r.body === "object" ? r.body.result : null) ?? null;
  return { ok: r.status < 300 && result?.ok !== false, status: r.status, result };
}

/** What Cobb is offered of `ids`, and whether each can be undone: the action
 *  index first (every id offered), then each one's own entry, which carries
 *  `undoable`. An id missing from the index maps to nothing. */
export async function offeredToCobb(s: TestSession, ids: readonly string[]): Promise<Map<string, { undoable: boolean }>> {
  const index = await cobb(s, "cobblr_list_actions", {});
  if (!index.ok) throw new Error(`cobblr_list_actions: ${index.text}`);
  const names = (index.data as { index?: Record<string, string> } | null)?.index ?? {};
  const out = new Map<string, { undoable: boolean }>();
  for (const id of ids) {
    if (!(id in names)) continue;
    const one = await cobb(s, "cobblr_list_actions", { action_id: id });
    const entry = (Array.isArray(one.data) ? (one.data as Array<{ id: string; undoable?: boolean }>) : []).find((a) => a.id === id);
    out.set(id, { undoable: entry?.undoable === true });
  }
  return out;
}
