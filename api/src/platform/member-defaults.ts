// Kept free of imports so a test can read the list without booting the api.

/** What a plain member may do without being granted it: take a thing and put
 *  it back. Taking stock is the day-to-day work the member role exists for
 *  ("does the work, cannot install or configure"), and a member who joined a
 *  club's workspace could see the count and a −1 button and do nothing with
 *  either. A member given a custom role is governed by that role
 *  instead: the role says otherwise when it leaves these out. A guest stays
 *  read-only. */
export const MEMBER_DEFAULT_CAPABILITIES: readonly string[] = ["inventory:count-stock", "inventory:use-one"];

/** Does this role hold `actionId` without a grant? True for a plain member
 *  (no custom role) and a member-default capability; an operator is a member
 *  who runs the machines, so holds them too (#6672). */
export function memberHoldsByDefault(role: string, actionId: string, hasCustomRole: boolean): boolean {
  return (role === "member" || role === "operator") && !hasCustomRole && MEMBER_DEFAULT_CAPABILITIES.includes(actionId);
}
