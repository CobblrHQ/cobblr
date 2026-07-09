// Personal (user-scoped) connections — the data layer + the resolver that
// projects a user's BYO credential into a workspace's AI provider resolution.
//
// A user configures a provider ONCE (e.g. their Ollama key, or the local-AI
// edge bridge) and routes it to chosen workspaces, so it follows them instead
// of being re-added per workspace. Stored in cobblr_meta (keyed by user),
// encrypted with the global creds key. The resolver is DEFAULT-OFF: with no
// route matching, it returns null and AI resolution is byte-for-byte as today.
//
// Routing (see migration 053):
//   mode  'my-calls'          → used only for calls the OWNER personally makes
//         'workspace-default'  → used for any caller / automation in scope
//   scope 'sole_member' | 'owner' | 'all_mine'  → dynamic vs live membership
//         'explicit'           → the workspaces in user_credential_orgs

import { meta } from "../db/meta.js";
import { encryptCreds, decryptCreds } from "../db/crypto.js";

export type RouteMode = "my-calls" | "workspace-default";
export type RouteScope = "sole_member" | "owner" | "all_mine" | "explicit";

/** One workspace's routing for a credential: which org + its per-workspace mode
 *  (Just me / Share with members). The set of routes IS the per-workspace
 *  config — an org with no route is "Off". */
export interface CredentialRoute {
  org_id: string;
  mode: RouteMode;
}

export interface UserCredentialInput {
  provider_id: string;
  label?: string;
  credentials: Record<string, unknown>;
  route_mode?: RouteMode;
  route_scope?: RouteScope;
  auto_enable_new?: boolean;
  /** Legacy: explicit workspaces (each gets `route_mode`). Prefer `routes`. */
  org_ids?: string[];
  /** Per-workspace routing (preferred). When provided, the credential is
   *  'explicit'-scoped and each workspace uses its own mode. */
  routes?: CredentialRoute[];
}

export interface UserCredentialView {
  id: string;
  provider_id: string;
  label: string;
  route_mode: RouteMode;
  route_scope: RouteScope;
  auto_enable_new: boolean;
  org_ids: string[];
  /** Per-workspace routing: the workspaces this credential reaches + each one's
   *  mode (Just me / Share). Empty when the scope is dynamic. */
  routes: CredentialRoute[];
  /** For 'workspace-default' (Share) routes only: the owner-approval state per
   *  org_id, so the sharer sees whether their offer is doing anything yet —
   *  'pending' (owner hasn't approved), 'approved' (accepted, not the active
   *  pick), or 'active' (the workspace's live AI). A share the sharer owns is
   *  auto-approved. Absent org_id = a 'my-calls' route (always works for them). */
  share_status: Record<string, "pending" | "approved" | "active">;
  /** Which credential keys are set (names only — never the secret values). */
  credential_keys: string[];
  /** Depends on the user's personal edge agent (the edge-bridge provider, or a
   *  URL provider with bridge transit) — drives the live status indicators. */
  uses_edge: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Normalise an input's routing into per-workspace routes. Prefers `routes`;
 *  falls back to legacy `org_ids` (each inherits the global route_mode). */
function routesOf(input: Partial<UserCredentialInput>): CredentialRoute[] | undefined {
  if (input.routes !== undefined) return input.routes;
  if (input.org_ids !== undefined) {
    const mode = input.route_mode ?? "my-calls";
    return input.org_ids.map((org_id) => ({ org_id, mode }));
  }
  return undefined;
}

/** Replace the per-workspace routing rows for a credential.
 *  Approval rules for a 'workspace-default' (Share) route:
 *   - if the cred owner OWNS that workspace → self-approved immediately;
 *   - if this org was already approved on a prior save → keep the approval
 *     (re-saving routing must not silently un-approve a live share);
 *   - otherwise it's a PENDING offer (approved_at null) the owner must accept.
 *  'my-calls' routes never need approval. */
async function setExplicitRoutes(
  credentialId: string,
  credOwnerId: string,
  routes: CredentialRoute[],
): Promise<void> {
  const existing = await meta
    .selectFrom("user_credential_orgs")
    .selectAll()
    .where("credential_id", "=", credentialId)
    .execute();
  const prevByOrg = new Map(existing.map((e) => [e.org_id, e]));
  await meta.deleteFrom("user_credential_orgs").where("credential_id", "=", credentialId).execute();
  if (routes.length === 0) return;

  // Which of these workspaces does the cred owner actually OWN? (self-share
  // auto-approves; a non-owner offering to share stays pending.)
  const ownerRows = await meta
    .selectFrom("org_memberships")
    .select("org_id")
    .where("org_id", "in", routes.map((r) => r.org_id))
    .where("user_id", "=", credOwnerId)
    .where("role", "=", "owner")
    .execute();
  const ownsOrg = new Set(ownerRows.map((o) => o.org_id));
  const now = new Date();

  const values = routes.map((r) => {
    if (r.mode === "my-calls") {
      return { credential_id: credentialId, org_id: r.org_id, mode: r.mode, approved_at: null, approved_by: null, active: false };
    }
    const prev = prevByOrg.get(r.org_id);
    if (prev?.mode === "workspace-default" && prev.approved_at) {
      return { credential_id: credentialId, org_id: r.org_id, mode: r.mode, approved_at: prev.approved_at, approved_by: prev.approved_by, active: prev.active };
    }
    const isOwner = ownsOrg.has(r.org_id);
    return { credential_id: credentialId, org_id: r.org_id, mode: r.mode, approved_at: isOwner ? now : null, approved_by: isOwner ? credOwnerId : null, active: false };
  });
  await meta.insertInto("user_credential_orgs").values(values).execute();
}

export async function addUserCredential(
  userId: string,
  input: UserCredentialInput,
): Promise<string> {
  // Per-workspace routing implies 'explicit' scope; otherwise honour the
  // dynamic scope (sole_member/owner/all_mine) for back-compat.
  const routes = routesOf(input);
  const scope: RouteScope = routes !== undefined ? "explicit" : (input.route_scope ?? "sole_member");
  const row = await meta
    .insertInto("user_credentials")
    .values({
      user_id: userId,
      kind: "ai-provider",
      provider_id: input.provider_id,
      label: input.label ?? "",
      credentials_encrypted: encryptCreds(JSON.stringify(input.credentials ?? {})),
      route_mode: input.route_mode ?? "my-calls",
      route_scope: scope,
      auto_enable_new: input.auto_enable_new ?? false,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (scope === "explicit" && routes?.length) {
    await setExplicitRoutes(row.id, userId, routes);
  }
  return row.id;
}

/** Update routing (and/or rotate the secret) on a credential the user owns. */
export async function updateUserCredential(
  userId: string,
  credentialId: string,
  patch: Partial<UserCredentialInput>,
): Promise<boolean> {
  const owned = await meta
    .selectFrom("user_credentials")
    .select(["id"])
    .where("id", "=", credentialId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!owned) return false;
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.route_mode !== undefined) set.route_mode = patch.route_mode;
  if (patch.auto_enable_new !== undefined) set.auto_enable_new = patch.auto_enable_new;
  if (patch.credentials !== undefined) {
    set.credentials_encrypted = encryptCreds(JSON.stringify(patch.credentials));
  }
  // Per-workspace routing wins: providing routes forces 'explicit' scope. Only
  // honour an explicit route_scope patch when no routes are given.
  const routes = routesOf(patch);
  if (routes !== undefined) set.route_scope = "explicit";
  else if (patch.route_scope !== undefined) set.route_scope = patch.route_scope;
  await meta.updateTable("user_credentials").set(set).where("id", "=", credentialId).execute();
  if (routes !== undefined) await setExplicitRoutes(credentialId, userId, routes);
  return true;
}

export async function deleteUserCredential(userId: string, credentialId: string): Promise<boolean> {
  const res = await meta
    .deleteFrom("user_credentials")
    .where("id", "=", credentialId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function listUserCredentials(userId: string): Promise<UserCredentialView[]> {
  const rows = await meta
    .selectFrom("user_credentials")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
  if (rows.length === 0) return [];
  const orgRows = await meta
    .selectFrom("user_credential_orgs")
    .selectAll()
    .where(
      "credential_id",
      "in",
      rows.map((r) => r.id),
    )
    .execute();
  const routesByCred = new Map<string, CredentialRoute[]>();
  const statusByCred = new Map<string, Record<string, "pending" | "approved" | "active">>();
  for (const o of orgRows) {
    const list = routesByCred.get(o.credential_id) ?? [];
    list.push({ org_id: o.org_id, mode: o.mode });
    routesByCred.set(o.credential_id, list);
    if (o.mode === "workspace-default") {
      const status = statusByCred.get(o.credential_id) ?? {};
      status[o.org_id] = o.active ? "active" : o.approved_at ? "approved" : "pending";
      statusByCred.set(o.credential_id, status);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    provider_id: r.provider_id,
    label: r.label,
    route_mode: r.route_mode,
    route_scope: r.route_scope,
    auto_enable_new: r.auto_enable_new,
    org_ids: (routesByCred.get(r.id) ?? []).map((x) => x.org_id),
    routes: routesByCred.get(r.id) ?? [],
    share_status: statusByCred.get(r.id) ?? {},
    credential_keys: keysOf(r.credentials_encrypted),
    uses_edge: usesEdge(r.provider_id, r.credentials_encrypted),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function keysOf(encrypted: string): string[] {
  try {
    const obj = JSON.parse(decryptCreds(encrypted)) as Record<string, unknown>;
    return Object.keys(obj);
  } catch {
    return [];
  }
}

/** Does this connection depend on the user's personal edge agent? True for the
 *  dedicated edge-bridge provider AND for any URL provider whose transit rides
 *  the bridge (credentials.transit = "bridge…"). Computed server-side so the
 *  client gets a boolean, never the credential values — it drives the "Edge
 *  bridge ● online/offline" indicators. */
function usesEdge(providerId: string, encrypted: string): boolean {
  if (providerId === "edge-bridge") return true;
  try {
    const obj = JSON.parse(decryptCreds(encrypted)) as Record<string, unknown>;
    return typeof obj.transit === "string" && obj.transit.startsWith("bridge");
  } catch {
    return false;
  }
}

// ─────────────────── Owner-side: AI-share offers ───────────────────
// A member offering their AI to a workspace ('workspace-default') becomes an
// OFFER the workspace owner approves. These power the owner's review UI.

export interface WorkspaceAiOffer {
  credential_id: string;
  provider_id: string;
  label: string;
  offered_by_user_id: string;
  offered_by_name: string;
  status: "pending" | "approved";
  active: boolean;
  /** The offerer is the owner themselves (self-share — no approval was needed). */
  is_own: boolean;
}

async function isOrgOwner(orgId: string, userId: string): Promise<boolean> {
  const row = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .where("role", "=", "owner")
    .executeTakeFirst();
  return !!row;
}

/** Every AI-share offer routed to a workspace (pending + approved), for the
 *  owner's review. */
export async function listWorkspaceAiOffers(orgId: string): Promise<WorkspaceAiOffer[]> {
  const rows = await meta
    .selectFrom("user_credential_orgs as uco")
    .innerJoin("user_credentials as uc", "uc.id", "uco.credential_id")
    .innerJoin("users as u", "u.id", "uc.user_id")
    .select([
      "uco.credential_id",
      "uco.approved_at",
      "uco.active",
      "uc.provider_id",
      "uc.label",
      "uc.user_id as offered_by_user_id",
      "u.display_name as offered_by_name",
    ])
    .where("uco.org_id", "=", orgId)
    .where("uco.mode", "=", "workspace-default")
    .execute();
  const owners = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .execute();
  const ownerIds = new Set(owners.map((o) => o.user_id));
  return rows.map((r) => {
    const isOwn = ownerIds.has(r.offered_by_user_id);
    // The connection's label ("Claude bridge (example-user)") and provider
    // ("edge-bridge") are the SHARER's private naming — how they set up their own
    // AI is not the recipient workspace's business. Only surface them when the
    // viewer owns the credential (their own share); otherwise the owner sees just
    // "<name>'s AI". The person (offered_by_name) still distinguishes offers.
    return {
      credential_id: r.credential_id,
      provider_id: isOwn ? r.provider_id : "",
      label: isOwn ? r.label : "",
      offered_by_user_id: r.offered_by_user_id,
      offered_by_name: r.offered_by_name ?? "A member",
      status: r.approved_at ? ("approved" as const) : ("pending" as const),
      active: r.active,
      is_own: isOwn,
    };
  });
}

/** Owner sets which approved AI is THE active workspace default (or none). */
export async function setActiveWorkspaceAi(
  ownerUserId: string,
  orgId: string,
  credentialId: string | null,
): Promise<boolean> {
  if (!(await isOrgOwner(orgId, ownerUserId))) return false;
  await meta
    .updateTable("user_credential_orgs")
    .set({ active: false })
    .where("org_id", "=", orgId)
    .where("mode", "=", "workspace-default")
    .execute();
  if (credentialId) {
    await meta
      .updateTable("user_credential_orgs")
      .set({ active: true })
      .where("org_id", "=", orgId)
      .where("credential_id", "=", credentialId)
      .where("mode", "=", "workspace-default")
      .where("approved_at", "is not", null)
      .execute();
  }
  return true;
}

/** Owner approves a pending AI-share offer. Auto-activates it when the
 *  workspace has no active AI yet (or when `makeActive` is set); otherwise it
 *  stays approved-but-inactive for the owner to switch to. */
export async function approveWorkspaceAiOffer(
  ownerUserId: string,
  orgId: string,
  credentialId: string,
  makeActive = false,
): Promise<boolean> {
  if (!(await isOrgOwner(orgId, ownerUserId))) return false;
  await meta
    .updateTable("user_credential_orgs")
    .set({ approved_at: new Date(), approved_by: ownerUserId })
    .where("org_id", "=", orgId)
    .where("credential_id", "=", credentialId)
    .where("mode", "=", "workspace-default")
    .execute();
  const activeExists = await meta
    .selectFrom("user_credential_orgs")
    .select("credential_id")
    .where("org_id", "=", orgId)
    .where("mode", "=", "workspace-default")
    .where("active", "=", true)
    .executeTakeFirst();
  if (makeActive || !activeExists) {
    await setActiveWorkspaceAi(ownerUserId, orgId, credentialId);
  }
  return true;
}

/** Owner declines an offer — removes the share route entirely. */
export async function rejectWorkspaceAiOffer(
  ownerUserId: string,
  orgId: string,
  credentialId: string,
): Promise<boolean> {
  if (!(await isOrgOwner(orgId, ownerUserId))) return false;
  await meta
    .deleteFrom("user_credential_orgs")
    .where("org_id", "=", orgId)
    .where("credential_id", "=", credentialId)
    .where("mode", "=", "workspace-default")
    .execute();
  return true;
}

/** The owners of a workspace (for notifying them of a new offer). */
export async function workspaceOwnerIds(orgId: string): Promise<string[]> {
  const rows = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .execute();
  return rows.map((r) => r.user_id);
}

export interface ResolvedPersonalProvider {
  credentialId: string;
  providerId: string;
  credentials: Record<string, unknown>;
  label: string;
}

/**
 * Find a personal credential that applies to (orgId, callerUserId) for a
 * provider that supports the capability. DEFAULT-OFF: returns null when nothing
 * is routed, so the caller falls through to the workspace's own provider.
 *
 * Precedence: the caller's OWN routed credential wins (their own AI for their
 * own calls — works immediately, even a Share offer that's still pending). Else
 * the workspace's chosen shared AI: an APPROVED 'workspace-default' offer,
 * preferring the owner-activated one, then most-recent. `supportsCapability` is
 * supplied by the AI layer (the provider map).
 */
export async function resolvePersonalProvider(
  orgId: string,
  callerUserId: string | null,
  supportsCapability: (providerId: string) => boolean,
): Promise<ResolvedPersonalProvider | null> {
  // FAIL-SAFE: this layer is opt-in + default-off, so if its tables are missing
  // (e.g. a meta DB without migration 053) or any query throws, it must NEVER
  // break core AI resolution — return null and the caller falls through to the
  // workspace provider. (Regression guard: a thrown query here surfaced as a
  // generic ai_error instead of the clean no_ai_provider the degrade path wants.)
  try {
    return await resolvePersonalProviderUnsafe(orgId, callerUserId, supportsCapability);
  } catch {
    return null;
  }
}

async function resolvePersonalProviderUnsafe(
  orgId: string,
  callerUserId: string | null,
  supportsCapability: (providerId: string) => boolean,
): Promise<ResolvedPersonalProvider | null> {
  const members = await meta
    .selectFrom("org_memberships")
    .select(["user_id", "role"])
    .where("org_id", "=", orgId)
    .execute();
  const memberIds = new Set(members.map((m) => m.user_id));
  const ownerIds = new Set(members.filter((m) => m.role === "owner").map((m) => m.user_id));
  const memberCount = members.length;

  const explicitRows = await meta
    .selectFrom("user_credential_orgs")
    .select(["credential_id", "mode", "approved_at", "active"])
    .where("org_id", "=", orgId)
    .execute();
  const explicitCredIds = new Set(explicitRows.map((e) => e.credential_id));
  const routeByCred = new Map(explicitRows.map((e) => [e.credential_id, e]));

  // Candidates = creds owned by a member of this org, plus any explicitly routed
  // here. (Two narrow queries instead of one OR with possibly-empty IN lists.)
  const ownedCreds = memberIds.size
    ? await meta
        .selectFrom("user_credentials")
        .selectAll()
        .where("kind", "=", "ai-provider")
        .where("user_id", "in", Array.from(memberIds))
        .execute()
    : [];
  const byId = new Map<string, (typeof ownedCreds)[number]>();
  for (const c of ownedCreds) byId.set(c.id, c);
  if (explicitCredIds.size) {
    const explicitCreds = await meta
      .selectFrom("user_credentials")
      .selectAll()
      .where("id", "in", Array.from(explicitCredIds))
      .execute();
    for (const c of explicitCreds) byId.set(c.id, c);
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) return null;

  const inScope = (c: (typeof candidates)[number]): boolean => {
    if (!supportsCapability(c.provider_id)) return false;
    switch (c.route_scope) {
      case "sole_member":
        return memberCount === 1 && memberIds.has(c.user_id);
      case "owner":
        return ownerIds.has(c.user_id);
      case "all_mine":
        return memberIds.has(c.user_id);
      case "explicit":
        return explicitCredIds.has(c.id);
      default:
        return false;
    }
  };
  const recent = (a: (typeof candidates)[number], b: (typeof candidates)[number]): number =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

  // Per-workspace mode wins for explicit creds; dynamic scopes use the global
  // route_mode. (A Just-me route and a Share route differ only here.)
  const effectiveMode = (c: (typeof candidates)[number]): RouteMode =>
    c.route_scope === "explicit" ? (routeByCred.get(c.id)?.mode ?? c.route_mode) : c.route_mode;

  // 1) The caller's OWN routed cred — their own AI for their own calls, used
  //    immediately regardless of any Share-approval state (offering to share
  //    must never block your own use).
  const own = callerUserId
    ? candidates.filter((c) => c.user_id === callerUserId && inScope(c)).sort(recent)
    : [];

  // 2) The workspace's chosen shared AI: an APPROVED workspace-default offer
  //    from anyone (the offering member's own approval, or the owner's accept),
  //    preferring the owner-activated one, then most-recent.
  const isApproved = (c: (typeof candidates)[number]): boolean => {
    if (effectiveMode(c) !== "workspace-default" || !inScope(c)) return false;
    // Dynamic-scope workspace-default (legacy/owner global) has no per-org row;
    // grandfather it as approved. Explicit offers must be approved.
    const r = routeByCred.get(c.id);
    return c.route_scope === "explicit" ? r?.approved_at != null : true;
  };
  const shared = candidates
    .filter(isApproved)
    .sort((a, b) => {
      const aw = routeByCred.get(a.id)?.active ? 1 : 0;
      const bw = routeByCred.get(b.id)?.active ? 1 : 0;
      return bw - aw || recent(a, b);
    });

  const pick = own[0] ?? shared[0];
  if (!pick) return null;

  let credentials: Record<string, unknown> = {};
  try {
    credentials = JSON.parse(decryptCreds(pick.credentials_encrypted)) as Record<string, unknown>;
  } catch {
    return null; // unreadable secret → fall through to the workspace provider
  }
  // Carry the credential OWNER's user id so a user-keyed provider (the edge
  // bridge) can route to the owner's live connection — even in workspace-default
  // mode where the caller differs from the owner. Harmless to providers that
  // ignore it (a BYO key just uses its own fields).
  credentials.__connection_user_id = pick.user_id;
  return { credentialId: pick.id, providerId: pick.provider_id, credentials, label: pick.label };
}
