// A person's own default AI per job (#5404).
//
// For each of the ordinary jobs (AI_DEFAULT_JOBS in the contract) a person may list the
// steps to ask, in order: one of their OWN AI connections and a model each.
// Every workspace they use follows them unless that workspace chose for the
// job itself (core_ai_capability_defaults). The router reads them through
// `myAiJobSteps` (ai.ts nextCandidate); the account page and the assistant
// write them through `/me/ai-defaults` and its workspace door.
//
// Design: docs/design-decisions/ai-job-split.md, "Your defaults".

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { decryptCreds } from "../db/crypto.js";
import { AI_DEFAULT_JOBS, type AiDefaultJobId } from "@cobblr/platform-contract";
import type { ResolvedPersonalProvider } from "./user-credentials.js";

export interface MyAiJobStep {
  position: number;
  credentialId: string;
  /** What was picked: a family's latest (the call asks the listing what it
   *  means now) or an exact version. */
  model: string;
  /** The connection, decrypted, or null when it can no longer be used (not
   *  an AI connection any more, or its secret is unreadable). A deleted one
   *  takes its steps with it (ON DELETE CASCADE). */
  connection: ResolvedPersonalProvider | null;
}

/** One of the person's own AI connections, decrypted, ready to call. Null
 *  when it is not theirs, not an AI connection, or unreadable. */
export async function myAiConnection(userId: string, credentialId: string): Promise<ResolvedPersonalProvider | null> {
  const row = await meta
    .selectFrom("user_credentials")
    .select(["id", "provider_id", "label", "credentials_encrypted", "user_id"])
    .where("id", "=", credentialId)
    .where("user_id", "=", userId)
    .where("kind", "=", "ai-provider")
    .executeTakeFirst();
  if (!row) return null;
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(decryptCreds(row.credentials_encrypted)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The owner's id rides the credentials, as the routed path does, so a
  // user-keyed provider (the edge bridge) reaches this person's own agent.
  credentials.__connection_user_id = row.user_id;
  return { credentialId: row.id, providerId: row.provider_id, credentials, label: row.label, ownerUserId: row.user_id };
}

/** The person's steps for one job, First first. Empty when they set none,
 *  and on any error: the router then takes the path it took before. */
export async function myAiJobSteps(userId: string, job: AiDefaultJobId): Promise<MyAiJobStep[]> {
  try {
    const rows = await meta
      .selectFrom("user_ai_job_defaults")
      .select(["position", "credential_id", "model", "model_follows"])
      .where("user_id", "=", userId)
      .where("job", "=", job)
      .orderBy("position", "asc")
      .execute();
    const out: MyAiJobStep[] = [];
    for (const r of rows) {
      out.push({ position: r.position, credentialId: r.credential_id, model: r.model_follows ?? r.model, connection: await myAiConnection(userId, r.credential_id) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every job's steps, as stored (no secrets), for the account page. */
export async function listMyAiJobDefaults(userId: string): Promise<Array<{ job: AiDefaultJobId; position: number; credential_id: string; model: string }>> {
  const rows = await meta
    .selectFrom("user_ai_job_defaults")
    .select(["job", "position", "credential_id", "model", "model_follows"])
    .where("user_id", "=", userId)
    // Rows an older api keeps for its own jobs (migration 210) are not ours.
    .where("job", "in", AI_DEFAULT_JOBS.map((j) => j.id))
    .orderBy("job", "asc")
    .orderBy("position", "asc")
    .execute();
  return rows.map((r) => ({ job: r.job as AiDefaultJobId, position: r.position, credential_id: r.credential_id, model: r.model_follows ?? r.model }));
}

/** One step as it is kept: `model` a model the provider serves, and
 *  `model_follows` the family's latest when that was picked. */
export interface StoredAiJobStep {
  credential_id: string;
  model: string;
  model_follows: string | null;
}

/** Replace one job's steps. An empty list clears the job. */
export async function setMyAiJobSteps(userId: string, job: AiDefaultJobId, steps: StoredAiJobStep[]): Promise<void> {
  // Two saves of one job at once would interleave the delete and the insert
  // and the second would fail on the position key: one at a time per job.
  await meta.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ai-job-defaults:${userId}:${job}`}, 0))`.execute(trx);
    await trx.deleteFrom("user_ai_job_defaults").where("user_id", "=", userId).where("job", "=", job).execute();
    if (!steps.length) return;
    await trx
      .insertInto("user_ai_job_defaults")
      .values(steps.map((s, i) => ({ user_id: userId, job, position: i, credential_id: s.credential_id, model: s.model, model_follows: s.model_follows })))
      .execute();
  });
}
