// Starting a support ("View as") session: the one implementation.
//
// Two doors lead here: the operator console over HTTP, and the deploy box
// itself (scripts/view-as.sh, run by an agent that holds no admin API token).
// They must agree, because the rules below are what make impersonation
// acceptable at all: the target is a real member, platform admins are never
// targets, a reason is recorded, and the session expires.
//
// The record of a look is OPERATOR-ONLY. The June spec wrote a line into the
// workspace's own activity feed; the owner reversed that on 2026-09-08 once
// agents were about to use this routinely ("I am uncomfortable with users
// seeing this"). The impersonation_sessions row is the audit, read through the
// console's Impersonation log and the box CLI, and activity.ts filters any
// impersonation_* action out of every member-facing list by default so a
// future write cannot leak it either.
//
// Two copies of these rules would drift, so both doors call this.
//
// This mints READ-ONLY sessions only. Write mode is a separate, later, audited
// PATCH through the console; nothing here can arm it, on purpose.

import { meta } from "../db/meta.js";
import { signImpersonation } from "../auth/jwt.js";
import { isPlatformAdmin } from "../auth/middleware.js";

export const IMPERSONATION_DEFAULT_TTL_MIN = 30;
export const IMPERSONATION_MAX_TTL_MIN = 60;

export interface StartImpersonationInput {
  orgId: string;
  targetUserId: string;
  reason: string;
  ttlMin?: number;
  /** The operator. Never replaced by the target: it rides the token's `sub`,
   *  so attribution cannot be forged. */
  operatorUserId: string;
}

export interface StartedImpersonation {
  session_id: string;
  token: string;
  expires_at: string;
  mode: "read";
  target: { id: string; name: string; role: string };
  workspace: { id: string; slug: string; name: string };
}

/** A refusal the caller renders in its own idiom (an HTTP status, or a CLI
 *  message). The codes are the ones the route has always returned. */
export class ImpersonationRefused extends Error {
  constructor(
    readonly code: "user_not_found" | "target_is_admin" | "not_a_member" | "org_not_found",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImpersonationRefused";
  }
}

/** Mint a read-only support session. The impersonation_sessions row is the
 *  operator-only record of it. */
export async function startImpersonation(input: StartImpersonationInput): Promise<StartedImpersonation> {
  const { orgId, targetUserId, reason, operatorUserId } = input;
  const ttlMin = Math.min(Math.max(1, input.ttlMin ?? IMPERSONATION_DEFAULT_TTL_MIN), IMPERSONATION_MAX_TTL_MIN);

  const target = await meta
    .selectFrom("users")
    .select(["email", "display_name"])
    .where("id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) throw new ImpersonationRefused("user_not_found", 404, "Target user not found.");

  // No tier-internal impersonation. Hygiene, not security.
  if (isPlatformAdmin(target.email)) {
    throw new ImpersonationRefused("target_is_admin", 403, "Platform admins can't be impersonated.");
  }

  const membership = await meta
    .selectFrom("org_memberships")
    .select(["role"])
    .where("user_id", "=", targetUserId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!membership) throw new ImpersonationRefused("not_a_member", 404, "That user is not a member of that workspace.");

  const org = await meta.selectFrom("orgs").select(["slug", "name"]).where("id", "=", orgId).executeTakeFirst();
  if (!org) throw new ImpersonationRefused("org_not_found", 404, "Workspace not found.");

  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
  const row = await meta
    .insertInto("impersonation_sessions")
    .values({ operator_user_id: operatorUserId, target_user_id: targetUserId, org_id: orgId, reason, expires_at: expiresAt })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  const token = await signImpersonation(operatorUserId, targetUserId, orgId, row.id, ttlMin * 60);

  return {
    session_id: row.id,
    token,
    expires_at: expiresAt.toISOString(),
    mode: "read",
    target: { id: targetUserId, name: target.display_name || target.email, role: membership.role },
    workspace: { id: orgId, slug: org.slug, name: org.name },
  };
}

/** The one sentence an operator reads about a session, in both the console log
 *  and the box CLI, so nobody has to decode a row. */
export function describeSession(s: {
  reason: string;
  mode: string;
  created_at: Date | string;
  ended_at?: Date | string | null;
  expires_at: Date | string;
  request_count?: number;
  operator?: string | null;
  target?: string | null;
  workspace?: string | null;
}): string {
  const who = s.operator || "support";
  const agent = s.reason.startsWith("[agent] ");
  const reason = agent ? s.reason.slice("[agent] ".length) : s.reason;
  const start = new Date(s.created_at);
  const end = new Date(s.ended_at ?? s.expires_at);
  const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const how = s.mode === "write" ? "with editing enabled" : "read-only";
  const reads = s.request_count ? `, ${s.request_count} read${s.request_count === 1 ? "" : "s"}` : "";
  return `${who}${agent ? " (automated)" : ""} viewed ${s.workspace ?? "a workspace"} as ${s.target ?? "a member"}, ${how}, ${mins} min${reads}: ${reason}`;
}
