// A workspace's own order per AI job (#5622): each step a connection and a
// model, First first, the same shape as a person's own (ai-job-defaults.ts).
// Kept in the workspace (core-ai's core_ai_job_steps) and set by an owner or
// admin on the AI page. The router asks these after an exact per-capability
// pin and before a person's own defaults (ai.ts nextCandidate).
//
// Design: docs/design-decisions/ai-job-split.md, "A workspace's order".

import { sql } from "kysely";
import type { AiJobId } from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";

export interface WorkspaceAiJobStep {
  position: number;
  /** A personal connection routed here; null = the workspace's own provider. */
  credentialId: string | null;
  providerId: string;
  /** As picked: a family's latest, or an exact version. */
  model: string;
}

type StepsTable = {
  selectFrom: (t: string) => {
    select: (c: string[]) => {
      where: (c: string, op: string, v: unknown) => {
        orderBy: (c: string, d: "asc") => { execute: () => Promise<Array<{ job?: string; position: number; credential_id: string | null; provider_id: string; model: string; model_follows: string | null }>> };
      };
      orderBy: (c: string, d: "asc") => {
        orderBy: (c: string, d: "asc") => { execute: () => Promise<Array<{ job: string; position: number; credential_id: string | null; provider_id: string; model: string; model_follows: string | null }>> };
      };
    };
  };
};

/** One job's steps, First first. Empty when the workspace set none, and on
 *  any error (a workspace without the table): the router then takes the
 *  path it took before. */
export async function workspaceAiJobSteps(orgId: string, job: AiJobId): Promise<WorkspaceAiJobStep[]> {
  try {
    const tdb = (await getTenantDb(orgId)) as unknown as StepsTable;
    const rows = await tdb
      .selectFrom("core_ai_job_steps")
      .select(["position", "credential_id", "provider_id", "model", "model_follows"])
      .where("job", "=", job)
      .orderBy("position", "asc")
      .execute();
    return rows.map((r) => ({ position: r.position, credentialId: r.credential_id ?? null, providerId: r.provider_id, model: r.model_follows ?? r.model }));
  } catch {
    return [];
  }
}

/** Every job's steps, as picked, for the AI page. */
export async function listWorkspaceAiJobSteps(orgId: string): Promise<Array<WorkspaceAiJobStep & { job: string }>> {
  try {
    const tdb = (await getTenantDb(orgId)) as unknown as StepsTable;
    const rows = await tdb
      .selectFrom("core_ai_job_steps")
      .select(["job", "position", "credential_id", "provider_id", "model", "model_follows"])
      .orderBy("job", "asc")
      .orderBy("position", "asc")
      .execute();
    return rows.map((r) => ({ job: r.job, position: r.position, credentialId: r.credential_id ?? null, providerId: r.provider_id, model: r.model_follows ?? r.model }));
  } catch {
    return [];
  }
}

export interface StoredWorkspaceStep {
  credential_id: string | null;
  provider_id: string;
  model: string;
  model_follows: string | null;
}

/** Replace one job's steps (an empty list clears the job back to automatic).
 *  The job's exact per-capability pins go with it: the order a person just
 *  set is what answers, not a pin they cannot see from here. */
export async function setWorkspaceAiJobSteps(orgId: string, job: AiJobId, capabilities: readonly string[], steps: StoredWorkspaceStep[], byUserId: string | null): Promise<void> {
  const tdb = await getTenantDb(orgId);
  await tdb.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ai-job-steps:${job}`}, 0))`.execute(trx);
    await sql`delete from core_ai_job_steps where job = ${job}`.execute(trx);
    if (capabilities.length) await sql`delete from core_ai_capability_defaults where capability in (${sql.join([...capabilities])})`.execute(trx);
    for (const [i, s] of steps.entries()) {
      await sql`insert into core_ai_job_steps (job, position, credential_id, provider_id, model, model_follows, updated_by)
        values (${job}, ${i}, ${s.credential_id}, ${s.provider_id}, ${s.model}, ${s.model_follows}, ${byUserId})`.execute(trx);
    }
  });
}
