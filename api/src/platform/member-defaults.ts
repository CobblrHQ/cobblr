// Kept free of imports so a test can read the list without booting the api.

/** What a plain member may do without being granted it: take a thing and put
 *  it back. Taking stock is the day-to-day work the member role exists for
 *  ("does the work, cannot install or configure"), and a member who joined a
 *  club's workspace could see the count and a −1 button and do nothing with
 *  either. A member given a custom role is governed by that role
 *  instead: the role says otherwise when it leaves these out. A guest stays
 *  read-only. */
export const MEMBER_DEFAULT_CAPABILITIES: readonly string[] = ["inventory:count-stock", "inventory:use-one"];

/** What a plain member may also do where the workspace allows it
 *  (`orgs.members_may_lend`): check a thing out and take it back, the base
 *  case of a makerspace or a tool library (#8661). On for a workspace born
 *  after migration 250; an older one's owner is asked once, so an update never
 *  opts anyone in. */
export const MEMBER_LEND_CAPABILITIES: readonly string[] = ["platform:lend", "platform:return"];

/** Does this role hold `actionId` without a grant? True for a plain member
 *  (no custom role) and a member-default capability, or a lend one where the
 *  workspace allows members to lend; an operator is a member who runs the
 *  machines, so holds them too (#6672). */
export function memberHoldsByDefault(role: string, actionId: string, hasCustomRole: boolean, membersMayLend = false): boolean {
  if (role !== "member" && role !== "operator") return false;
  if (hasCustomRole) return false;
  return MEMBER_DEFAULT_CAPABILITIES.includes(actionId) || (membersMayLend && MEMBER_LEND_CAPABILITIES.includes(actionId));
}
