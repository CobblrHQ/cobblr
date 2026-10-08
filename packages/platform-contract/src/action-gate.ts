// The gate a route puts in front of the thing an action does (#5170).
//
// A member could add a line to a purchase order on the Purchases page, whose
// route said "member or better" in its own words, and was refused the same
// thing through the API and through Cobb, whose door read the action's
// capability. A route that does what an action does now gates here, on that
// action's id: platform().auth.userHasCapability reads the action's own
// declaration (`runBy`, `grantedAs`), the same one /actions/invoke and Cobb
// read, so every door gives every role one answer.
// lint:route-and-action-gate-agree holds each paired route to it.

import { platform } from "@cobblr/platform-contract";
import { roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";

interface GatedRequest {
  tenant?: { org: { id: string }; role: string };
  session?: { id: string } | null;
}
interface GateResponse {
  status(code: number): { json(body: unknown): unknown };
}

/** May this person do what `actionId` does? Answers the refusal itself (the
 *  platform's sentence, with how to ask) and returns false when not. */
export async function requireCapability(req: unknown, res: GateResponse, actionId: string): Promise<boolean> {
  const r = req as GatedRequest;
  // The admin tier holds every capability (userHasCapability's first answer
  // too), so it is decided from the role, with no lookup.
  if (r.tenant && roleHoldsEveryCapability(r.tenant.role)) return true;
  if (!r.tenant || !r.session) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Sign in first." } });
    return false;
  }
  const who = { orgId: r.tenant.org.id, userId: r.session.id, role: r.tenant.role, actionId };
  if (await platform().auth.userHasCapability(who)) return true;
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({
    error: { code: "missing_capability", message: blocked.sentence, details: { action_id: actionId, your_role: r.tenant.role }, blocked },
  });
  return false;
}
