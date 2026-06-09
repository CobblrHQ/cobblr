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

export interface UserCredentialInput {
  provider_id: string;
  label?: string;
  credentials: Record<string, unknown>;
  route_mode?: RouteMode;
  route_scope?: RouteScope;
  auto_enable_new?: boolean;
  /** For 'explicit' scope — the workspaces this credential reaches. */
  org_ids?: string[];
}

export interface UserCredentialView {
  id: string;
  provider_id: string;
  label: string;
  route_mode: RouteMode;
  route_scope: RouteScope;
  auto_enable_new: boolean;
  org_ids: string[];
  /** Which credential keys are set (names only — never the secret values). */
  credential_keys: string[];
  created_at: Date;
  updated_at: Date;
}

/** Replace the explicit-scope workspace list for a credential. */
async function setExplicitOrgs(credentialId: string, orgIds: string[]): Promise<void> {
  await meta.deleteFrom("user_credential_orgs").where("credential_id", "=", credentialId).execute();
  if (orgIds.length === 0) return;
  await meta
    .insertInto("user_credential_orgs")
    .values(orgIds.map((org_id) => ({ credential_id: credentialId, org_id })))
    .execute();
}

export async function addUserCredential(
  userId: string,
  input: UserCredentialInput,
): Promise<string> {
  const row = await meta
    .insertInto("user_credentials")
    .values({
      user_id: userId,
      kind: "ai-provider",
      provider_id: input.provider_id,
      label: input.label ?? "",
      credentials_encrypted: encryptCreds(JSON.stringify(input.credentials ?? {})),
      route_mode: input.route_mode ?? "my-calls",
      route_scope: input.route_scope ?? "sole_member",
      auto_enable_new: input.auto_enable_new ?? false,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if ((input.route_scope ?? "sole_member") === "explicit" && input.org_ids?.length) {
    await setExplicitOrgs(row.id, input.org_ids);
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
  if (patch.route_scope !== undefined) set.route_scope = patch.route_scope;
  if (patch.auto_enable_new !== undefined) set.auto_enable_new = patch.auto_enable_new;
  if (patch.credentials !== undefined) {
    set.credentials_encrypted = encryptCreds(JSON.stringify(patch.credentials));
  }
  await meta.updateTable("user_credentials").set(set).where("id", "=", credentialId).execute();
  if (patch.org_ids !== undefined) await setExplicitOrgs(credentialId, patch.org_ids);
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
  const orgsByCred = new Map<string, string[]>();
  for (const o of orgRows) {
    const list = orgsByCred.get(o.credential_id) ?? [];
    list.push(o.org_id);
    orgsByCred.set(o.credential_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    provider_id: r.provider_id,
    label: r.label,
    route_mode: r.route_mode,
    route_scope: r.route_scope,
    auto_enable_new: r.auto_enable_new,
    org_ids: orgsByCred.get(r.id) ?? [],
    credential_keys: keysOf(r.credentials_encrypted),
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
 * Precedence: the caller's own 'my-calls' credential wins (most personal), then
 * any 'workspace-default' credential in scope; ties break by most-recently
 * updated. `supportsCapability` is supplied by the AI layer (the provider map).
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
    .select(["credential_id"])
    .where("org_id", "=", orgId)
    .execute();
  const explicitCredIds = new Set(explicitRows.map((e) => e.credential_id));

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

  // 1) caller's own my-calls credential, 2) any workspace-default in scope.
  const myCalls = callerUserId
    ? candidates
        .filter((c) => c.route_mode === "my-calls" && c.user_id === callerUserId && inScope(c))
        .sort(recent)
    : [];
  const wsDefault = candidates
    .filter((c) => c.route_mode === "workspace-default" && inScope(c))
    .sort(recent);
  const pick = myCalls[0] ?? wsDefault[0];
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
