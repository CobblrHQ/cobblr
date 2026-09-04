// Which workspaces a saved connection actually serves, and which one it IS.
//
// Kept apart from user-credentials.ts (which opens a pool on import) so the
// rule can be read and tested on its own. Everything here is a decision about
// rows; the reads and the write live with the caller.

import type { CredentialRoute, RouteMode } from "./user-credentials.js";

export interface PriorRoute {
  mode: RouteMode;
  approved_at: Date | null;
  approved_by: string | null;
  active: boolean;
}

export interface PlannedRoute {
  credential_id: string;
  org_id: string;
  mode: RouteMode;
  approved_at: Date | null;
  approved_by: string | null;
  active: boolean;
}

export interface RoutePlan {
  credentialId: string;
  credOwnerId: string;
  routes: CredentialRoute[];
  /** what this credential's rows looked like before the save, by workspace */
  prev: ReadonlyMap<string, PriorRoute>;
  /** the workspaces the credential's owner owns (a self-share auto-approves) */
  ownsOrg: ReadonlySet<string>;
  /** workspaces that already have a live AI from a DIFFERENT credential */
  liveElsewhere: ReadonlySet<string>;
  now: Date;
}

/**
 * An approved AI in a workspace that has none IS that workspace's AI.
 *
 * Approving used to leave it switched off, and only the "somebody offered you
 * their AI" path had this rule, so a stranger's offer went live by itself and
 * your own key did not. Ticking your workspaces when you save a key is what a
 * person means by turning it on there; the second, separate "make this the
 * active one" step existed without ever saying so.
 *
 * Found 2026-09-02: an account swapped its bridge for a Gemini key, the
 * bridge's routes went with it, the Gemini rows landed approved-and-inactive,
 * and seven workspaces ran with NO ai for twelve days. Nothing said so; scans
 * quietly fell back to the no-AI path.
 *
 * It can only ever fill a vacancy. A workspace with a live AI keeps the one
 * its owner picked.
 */
export function planRouteRows(plan: RoutePlan): PlannedRoute[] {
  const { credentialId, credOwnerId, routes, prev, ownsOrg, liveElsewhere, now } = plan;
  const goesLive = (orgId: string, approved: boolean): boolean =>
    approved && !liveElsewhere.has(orgId);

  return routes.map((r) => {
    if (r.mode === "my-calls") {
      // A personal route spends the owner's own credit on their own calls. It
      // is never the workspace's AI.
      return {
        credential_id: credentialId,
        org_id: r.org_id,
        mode: r.mode,
        approved_at: null,
        approved_by: null,
        active: false,
      };
    }
    const was = prev.get(r.org_id);
    if (was?.mode === "workspace-default" && was.approved_at) {
      return {
        credential_id: credentialId,
        org_id: r.org_id,
        mode: r.mode,
        approved_at: was.approved_at,
        approved_by: was.approved_by,
        // Keep it live if it was; otherwise take the vacancy. Re-saving the
        // routes on a workspace with no AI is the same intent as adding it.
        active: was.active || goesLive(r.org_id, true),
      };
    }
    const isOwner = ownsOrg.has(r.org_id);
    return {
      credential_id: credentialId,
      org_id: r.org_id,
      mode: r.mode,
      // Offering YOUR key to a workspace somebody else owns stays a pending
      // offer for them to accept; nothing here accepts it on their behalf.
      approved_at: isOwner ? now : null,
      approved_by: isOwner ? credOwnerId : null,
      active: goesLive(r.org_id, isOwner),
    };
  });
}
