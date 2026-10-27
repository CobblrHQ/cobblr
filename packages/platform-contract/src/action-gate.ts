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

import { platform, type EntityRef } from "@cobblr/platform-contract";
import { loanActionRefusal, OFF_WHILE_LENT } from "@cobblr/platform-contract/loan";
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
export async function requireCapability(req: unknown, res: GateResponse, actionId: string, entity?: EntityRef): Promise<boolean> {
  const r = req as GatedRequest;
  // The record half is refuseIfLent's, so a route that names its record here
  // and one that asks after reading it give a lent thing one answer.
  const recordAllowed = async () => !entity || !(await refuseIfLent(req, res, actionId, [entity]));
  // The admin tier holds every capability (userHasCapability's first answer
  // too), so it is decided from the role, with no lookup.
  if (r.tenant && roleHoldsEveryCapability(r.tenant.role)) return recordAllowed();
  if (!r.tenant || !r.session) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Sign in first." } });
    return false;
  }
  const who = { orgId: r.tenant.org.id, userId: r.session.id, role: r.tenant.role, actionId };
  if (await platform().auth.userHasCapability(who)) return recordAllowed();
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({
    error: { code: "missing_capability", message: blocked.sentence, details: { action_id: actionId, your_role: r.tenant.role }, blocked },
  });
  return false;
}

/** A thing lent out is not moved or labelled until it is back (OFF_WHILE_LENT,
 *  record-loans.md). A route that does what such an action does asks here, for
 *  each record it would touch, after its capability: a lent one is refused with
 *  the action's own sentence ("Lent to Sam Lee."), 409 record_lent, and true
 *  comes back, so the route stops. The action and a part's own edit refused,
 *  while the placement route moved a lent part from one shelf to another
 *  (#8235). */
export async function refuseIfLent(req: unknown, res: GateResponse, actionId: string, refs: ReadonlyArray<{ kind: string; id: string }>): Promise<boolean> {
  const orgId = (req as GatedRequest).tenant?.org.id;
  if (!orgId || !OFF_WHILE_LENT.has(actionId)) return false;
  for (const ref of refs) {
    const found = await platform().entities.lookup(orgId, ref.kind, ref.id).catch(() => null);
    const refusal = found ? loanActionRefusal(actionId, found.fields) : null;
    if (refusal) {
      res.status(409).json({ error: { code: "record_lent", message: refusal } });
      return true;
    }
  }
  return false;
}
