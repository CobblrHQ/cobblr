// Sandboxes an operator made from the box (cli/try-sandbox.ts), and why.
//
// An operator walking the sandbox to check it is not a visitor. Its mint is
// recorded here (who, why, until when), and every count of visitors and
// signups leaves these workspaces out, and nothing announces them. The ledger
// outlives the sandbox (no foreign key: the org row is reaped with the hour),
// so the record and the exclusion both hold after it is gone.
import { meta } from "../db/meta.js";

export async function recordOperatorSandbox(r: {
  orgId: string;
  slug: string;
  operatorUserId: string;
  operatorEmail: string;
  reason: string;
  expiresAt: Date;
}): Promise<void> {
  await meta
    .insertInto("operator_sandboxes")
    .values({ org_id: r.orgId, slug: r.slug, operator_user_id: r.operatorUserId, operator_email: r.operatorEmail, reason: r.reason, expires_at: r.expiresAt })
    .execute();
}

/** Every workspace an operator ever made this way. */
export async function operatorSandboxOrgIds(): Promise<Set<string>> {
  const rows = await meta.selectFrom("operator_sandboxes").select("org_id").execute();
  return new Set(rows.map((r) => r.org_id));
}

export async function isOperatorSandbox(orgId: string): Promise<boolean> {
  return !!(await meta.selectFrom("operator_sandboxes").select("id").where("org_id", "=", orgId).executeTakeFirst());
}

export async function operatorSandboxLog(limit = 50) {
  return meta
    .selectFrom("operator_sandboxes")
    .select(["id", "slug", "operator_email", "reason", "created_at", "expires_at"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
