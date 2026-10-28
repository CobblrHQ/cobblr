// The single source of truth for "what can this user do in this org."
//
// Resolved the same way platform().auth.userHasCapability enforces:
//   admin tier    → every capability, implicitly (all: true). Which roles that
//                    is comes from roleHoldsEveryCapability, the one home of
//                    the rule — it is NOT a list of role names in here.
//   else          → direct per-user grants (workspace_capability_grants)
//                    UNION custom-role capability bundles
//                    (workspace_role_assignments → workspace_role_capabilities).
//
// Used by BOTH the UI-gating endpoint (/me/capabilities) and the
// read-time field-scope projection (H2). Keeping them on one query
// means what the UI hides exactly matches what the server withholds —
// no drift between the two that could either leak a field or hide one
// the user is actually allowed to see.

import { actionsRunBy, capabilitiesHeldBy } from "../platform/action-gates.js";
import { roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { MEMBER_DEFAULT_CAPABILITIES, MEMBER_LEND_CAPABILITIES, memberHoldsByDefault } from "../platform/capability-grants.js";

async function hasAnyCustomRole(orgId: string, userId: string): Promise<boolean> {
  const row = await meta
    .selectFrom("workspace_role_assignments")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

export interface EffectiveCapabilities {
  /** The admin tier (owner, admin, editor) holds every capability
   *  implicitly. When true, `caps` is empty and callers should skip
   *  per-capability checks. */
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
  if (role === "guest") return { all: false, caps: new Set() };
  if (roleHoldsEveryCapability(role)) {
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
  // A plain member (no custom role) holds the member defaults; a custom role
  // decides for itself. Same rule as userHasCapability (memberHoldsByDefault).
  const hasCustomRole = viaRole.length > 0 || (await hasAnyCustomRole(orgId, userId));
  const mayLend = !!(await meta.selectFrom("orgs").select("members_may_lend").where("id", "=", orgId).executeTakeFirst())?.members_may_lend;
  const held = new Set([
    ...direct.map((r) => r.action_id),
    ...viaRole.map((r) => r.action_id),
    ...[...MEMBER_DEFAULT_CAPABILITIES, ...MEMBER_LEND_CAPABILITIES].filter((c) => memberHoldsByDefault(role, c, hasCustomRole, mayLend)),
    ...capabilitiesHeldBy(role),
  ]);
  // And what an action's own declaration lets this role run (#5170), the
  // same answer userHasCapability gives, so a button shows where it works.
  return { all: false, caps: new Set([...held, ...actionsRunBy(role, held)]) };
}
