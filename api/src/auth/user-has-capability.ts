import type { PlatformAuth } from "@cobblr/platform-contract";
import { roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { actionGateOf, gatePasses, capabilitiesHeldBy } from "../platform/action-gates.js";
import { MEMBER_DEFAULT_CAPABILITIES, memberHoldsByDefault } from "../platform/capability-grants.js";

export const userHasCapability: PlatformAuth["userHasCapability"] = async ({ orgId, userId, role, actionId }) => {
  if (role === "guest") return false;
  if (roleHoldsEveryCapability(role)) return true;
  // The action's own declaration (#5170): the role it runs by, read by
  // every door alike (a route that does the same thing gates here too).
  if (gatePasses(actionId, role, () => false)) return true;
  // A grant counts for the action itself or for the capability it shares.
  const ids = [actionId, ...(actionGateOf(actionId).grantedAs ? [actionGateOf(actionId).grantedAs!] : [])];
  // What the stock role holds by a module's declaration (an operator runs the machines, #6672).
  const byRole = capabilitiesHeldBy(role);
  if (ids.some((id) => byRole.has(id))) return true;
  const grant = await meta
    .selectFrom("workspace_capability_grants")
    .select("id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .where("action_id", "in", ids)
    .executeTakeFirst();
  if (grant) return true;
  const viaRole = await meta
    .selectFrom("workspace_role_assignments as a")
    .innerJoin("workspace_role_capabilities as c", "c.role_id", "a.role_id")
    .select("c.action_id")
    .where("a.org_id", "=", orgId)
    .where("a.user_id", "=", userId)
    .where("c.action_id", "in", ids)
    .limit(1)
    .executeTakeFirst();
  if (viaRole) return true;
  // What a plain member holds without a grant (take and put back stock),
  // unless a custom role governs them.
  const byDefault = ids.find((id) => MEMBER_DEFAULT_CAPABILITIES.includes(id));
  if (!byDefault) return false;
  const custom = await meta
    .selectFrom("workspace_role_assignments")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst();
  return memberHoldsByDefault(role, byDefault, !!custom);
};
