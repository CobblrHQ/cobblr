// The single source of truth for "what can this user do in this org."
//
// Resolved the same way platform().auth.userHasCapability enforces:
//   owner / admin → every capability, implicitly (all: true).
//   else          → direct per-user grants (workspace_capability_grants)
//                    UNION custom-role capability bundles
//                    (workspace_role_assignments → workspace_role_capabilities).
//
// Used by BOTH the UI-gating endpoint (/me/capabilities) and the
// read-time field-scope projection (H2). Keeping them on one query
// means what the UI hides exactly matches what the server withholds —
// no drift between the two that could either leak a field or hide one
// the user is actually allowed to see.

import { meta } from "../db/meta.js";

export interface EffectiveCapabilities {
  /** owner / admin — holds every capability implicitly. When true,
   *  `caps` is empty and callers should skip per-capability checks. */
  all: boolean;
  /** Granted capability action_ids (direct grants ∪ custom-role bundles).
   *  Empty when `all` is true. */
  caps: Set<string>;
}

export async function effectiveCapabilities(
  orgId: string,
  userId: string,
  role: string,
): Promise<EffectiveCapabilities> {
  if (role === "owner" || role === "admin") {
    return { all: true, caps: new Set() };
  }
  const [direct, viaRole] = await Promise.all([
    meta
      .selectFrom("workspace_capability_grants")
      .select("action_id")
      .where("org_id", "=", orgId)
      .where("user_id", "=", userId)
      .execute(),
    meta
      .selectFrom("workspace_role_assignments as a")
      .innerJoin("workspace_role_capabilities as c", "c.role_id", "a.role_id")
      .select("c.action_id")
      .where("a.org_id", "=", orgId)
      .where("a.user_id", "=", userId)
      .execute(),
  ]);
  return {
    all: false,
    caps: new Set([
      ...direct.map((r) => r.action_id),
      ...viaRole.map((r) => r.action_id),
    ]),
  };
}
