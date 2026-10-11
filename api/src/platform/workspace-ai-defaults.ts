// A workspace's own order per AI job (#5622): the reads, checks and the
// write behind the AI page's "Who does what, in order". The same view a
// person's own defaults give (my-ai-defaults.ts), so the page draws both
// with one editor: each job's steps, the connections this workspace can
// name with the models each can do each job with.
//
// A connection is named by a key: a personal connection by its id, one of
// the workspace's own providers as `workspace:<provider id>`.

import { z } from "zod";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { AI_JOBS, type AiJobId } from "@cobblr/platform-contract";
type OrgRole = string;
import type { AiModelChoice } from "@cobblr/platform-contract/ai-models";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as aiImpl from "./ai.js";
import * as activity from "./activity.js";
import { listWorkspaceAiJobSteps, setWorkspaceAiJobSteps, type StoredWorkspaceStep } from "./workspace-ai-job-steps.js";
import { MAX_STEPS } from "./my-ai-defaults.js";

export const WorkspaceStepsBody = z.object({
  steps: z.array(z.object({ connection: z.string().trim().min(1).max(200), model: z.string().trim().min(1).max(200) })).max(MAX_STEPS),
});

export type WorkspaceJob = (typeof AI_JOBS)[number];
export const workspaceJobById = (id: string | undefined): WorkspaceJob | null => AI_JOBS.find((j) => j.id === id) ?? null;

const WORKSPACE = "workspace:";
type Ref = { credentialId: string } | { providerId: string };
const refOf = (key: string): Ref => (key.startsWith(WORKSPACE) ? { providerId: key.slice(WORKSPACE.length) } : { credentialId: key });

type JobModels = { models: string[]; default_model: string | null; choices?: AiModelChoice[] };

export interface WorkspaceAiDefaultsView {
  /** Only an owner or admin changes the order; everyone else reads it. */
  can_edit: boolean;
  jobs: Array<{
    id: AiJobId;
    title: string;
    /** The workspace set this order itself; false = the steps shown are who
     *  answers now with nothing chosen here, the order an edit starts from. */
    chosen: boolean;
    steps: Array<{ credential_id: string; model: string; model_label?: string; label: string; provider_id: string | null; usable: boolean }>;
    own_order_in: [];
  }>;
  connections: Array<{ id: string; label: string; provider_id: string; jobs: Partial<Record<AiJobId, JobModels>>; unlisted?: string; fallback?: string; just_you?: true }>;
  model_labels: Record<string, Record<string, string>>;
}

/** The connections this workspace can name for this caller: its own enabled
 *  providers, connections shared with it, and the caller's own routed here.
 *  Somebody else's shared connection is named as theirs, never by its label. */
export async function namable(orgId: string, userId: string | null): Promise<Array<{ key: string; providerId: string; label: string; justYou: boolean }>> {
  const tdb = (await getTenantDb(orgId)) as unknown as {
    selectFrom: (t: string) => { select: (c: string[]) => { where: (c: string, o: string, v: unknown) => { execute: () => Promise<Array<{ provider_id: string; label: string | null }>> } } };
  };
  const own = await tdb.selectFrom("core_ai_providers").select(["provider_id", "label"]).where("enabled", "=", true).execute().catch(() => []);
  const routed = await meta
    .selectFrom("user_credential_orgs as uco")
    .innerJoin("user_credentials as uc", "uc.id", "uco.credential_id")
    .innerJoin("users as u", "u.id", "uc.user_id")
    .select(["uc.id", "uc.provider_id", "uc.label", "uc.user_id", "u.display_name", "uco.mode", "uco.approved_at"])
    .where("uco.org_id", "=", orgId)
    .where("uco.capability", "is", null)
    .where("uc.kind", "=", "ai-provider")
    .orderBy("uc.created_at", "asc")
    .execute();
  const out: Array<{ key: string; providerId: string; label: string; justYou: boolean }> = [];
  for (const r of own) out.push({ key: `${WORKSPACE}${r.provider_id}`, providerId: r.provider_id, label: r.label?.trim() || aiImpl.getProvider(r.provider_id)?.label || r.provider_id, justYou: false });
  const seen = new Set<string>();
  for (const r of routed) {
    if (seen.has(r.id)) continue;
    const mine = !!userId && r.user_id === userId;
    const shared = r.mode === "workspace-default" && r.approved_at != null;
    if (!mine && !shared) continue;
    seen.add(r.id);
    const label = mine ? r.label?.trim() || aiImpl.getProvider(r.provider_id)?.label || r.provider_id : `Shared by ${r.display_name ?? "a member"}`;
    out.push({ key: r.id, providerId: r.provider_id, label, justYou: mine && !shared });
  }
  return out;
}

/** Everything the AI page needs to read and set the workspace's order. */
export async function workspaceAiDefaultsView(orgId: string, userId: string | null, role: OrgRole | null, opts: { fresh?: boolean } = {}): Promise<WorkspaceAiDefaultsView> {
  const [stored, conns] = await Promise.all([listWorkspaceAiJobSteps(orgId), namable(orgId, userId)]);
  const connections = await Promise.all(
    conns.map(async (c) => {
      const jobs: Partial<Record<AiJobId, JobModels>> = {};
      let unlisted: string | undefined;
      let fallback: string | undefined;
      for (const [i, j] of AI_JOBS.entries()) {
        if (j.id === "personal" && aiImpl.getProvider(c.providerId)?.locality !== "local") continue;
        const m = await aiImpl.modelsOfWorkspaceConnection(orgId, userId, refOf(c.key), j.shows, { fresh: opts.fresh && i === 0 });
        if (m.ok) {
          jobs[j.id] = { models: m.models, default_model: m.defaultModel, ...(m.choices ? { choices: m.choices } : {}) };
          if (m.fallback) fallback = m.fallback;
        } else if (m.code === "models_unlisted") unlisted = m.message;
      }
      return { id: c.key, label: c.label, provider_id: c.providerId, jobs, ...(unlisted ? { unlisted } : {}), ...(fallback ? { fallback } : {}), ...(c.justYou ? { just_you: true as const } : {}) };
    }),
  );
  const byKey = new Map(connections.map((c) => [c.id, c]));
  const model_labels: Record<string, Record<string, string>> = {};
  for (const c of connections) {
    const notes = aiImpl.getProvider(c.provider_id)?.modelNotes;
    if (notes && !model_labels[c.provider_id]) model_labels[c.provider_id] = Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.label]));
  }
  // A step can name a member's own "Just me" connection, which nobody else
  // may use or see by its label: said as theirs, never as gone (#5622). Only a
  // connection that really was removed reads "no longer here".
  const unnamed = [...new Set(stored.flatMap((st) => (st.credentialId && !byKey.has(st.credentialId) ? [st.credentialId] : [])))];
  const othersOwn = new Map<string, string>();
  if (unnamed.length) {
    const rows = await meta
      .selectFrom("user_credentials as uc")
      .innerJoin("users as u", "u.id", "uc.user_id")
      .select(["uc.id", "u.display_name"])
      .where("uc.id", "in", unnamed)
      .execute()
      .catch(() => []);
    for (const r of rows) othersOwn.set(r.id, `${r.display_name ?? "A member"}'s own connection`);
  }
  const stepOf = (jobId: AiJobId, key: string, model: string, providerId: string | null) => {
    const c = byKey.get(key);
    const model_label = c?.jobs[jobId]?.choices?.find((x) => x.id === model)?.label;
    return {
      credential_id: key,
      model,
      ...(model_label ? { model_label } : {}),
      label: c?.label ?? othersOwn.get(key) ?? "A connection no longer here",
      provider_id: c?.provider_id ?? providerId,
      usable: !!c?.jobs[jobId],
    };
  };

  const jobs = await Promise.all(
    AI_JOBS.map(async (j) => {
      const mine = stored.filter((s) => s.job === j.id);
      if (mine.length) {
        return { id: j.id, title: j.title, chosen: true, steps: mine.map((s) => stepOf(j.id, s.credentialId ?? `${WORKSPACE}${s.providerId}`, s.model, s.providerId)), own_order_in: [] as [] };
      }
      // Nothing chosen here: who answers now, as the steps an edit starts from.
      const chain = await aiImpl.aiChainFor(orgId, userId, j.shows).catch(() => ({ steps: [] as Awaited<ReturnType<typeof aiImpl.aiChainFor>>["steps"] }));
      const steps = chain.steps
        .filter((s) => s.asked && s.model && (s.credential_id || s.source === "workspace"))
        .map((s) => stepOf(j.id, s.credential_id ?? `${WORKSPACE}${s.provider_id}`, s.model!, s.provider_id ?? null))
        .filter((s) => byKey.has(s.credential_id));
      return { id: j.id, title: j.title, chosen: false, steps, own_order_in: [] as [] };
    }),
  );
  return { can_edit: roleSatisfies(role, ["admin"]), jobs, connections, model_labels };
}

/** Check one job's steps against each connection's own listing for the job,
 *  the same choices the page offers. Says what is wrong in a sentence, or
 *  hands back the steps as they are kept (a family's latest in model_follows
 *  beside what it means now). */
export async function checkWorkspaceSteps(
  orgId: string,
  userId: string | null,
  job: WorkspaceJob,
  steps: Array<{ connection: string; model: string }>,
): Promise<{ ok: false; refusal: string } | { ok: true; stored: StoredWorkspaceStep[] }> {
  const seen = new Set<string>();
  const stored: StoredWorkspaceStep[] = [];
  const allowed = new Set((await namable(orgId, userId)).map((c) => c.key));
  for (const [i, s] of steps.entries()) {
    const where = i === 0 ? "First" : `Then ${i}`;
    const key = `${s.connection}|${s.model}`;
    if (seen.has(key)) return { ok: false, refusal: `${where} repeats an earlier step. Each connection and model is asked once.` };
    seen.add(key);
    if (!allowed.has(s.connection)) return { ok: false, refusal: `${where}: that connection is not one this workspace can use.` };
    const ref = refOf(s.connection);
    const m = await aiImpl.modelsOfWorkspaceConnection(orgId, userId, ref, job.shows);
    if (!m.ok) return { ok: false, refusal: `${where}: ${m.message}` };
    if (job.id === "personal" && aiImpl.getProvider(m.providerId)?.locality !== "local") {
      return { ok: false, refusal: `${where}: personal documents are read by a local model only.` };
    }
    if (!m.models.includes(s.model)) {
      const offers = m.choices ? m.choices.map((c) => c.label) : m.models;
      return { ok: false, refusal: `${where}: ${m.label} has no ${s.model} for ${job.phrase}. It offers ${offers.slice(0, 12).join(", ") || "nothing"}.` };
    }
    const latest = m.choices?.find((c) => c.id === s.model)?.latest;
    stored.push({ credential_id: "credentialId" in ref ? ref.credentialId : null, provider_id: m.providerId, model: latest?.resolves ?? s.model, model_follows: latest ? s.model : null });
  }
  return { ok: true, stored };
}

/** Replace one job's order (an empty list puts the job back to automatic),
 *  checked first, said in the workspace's activity feed. */
export async function saveWorkspaceAiDefaults(
  orgId: string,
  userId: string | null,
  role: OrgRole | null,
  job: WorkspaceJob,
  steps: Array<{ connection: string; model: string }>,
): Promise<{ ok: false; refusal: string } | { ok: true; view: WorkspaceAiDefaultsView }> {
  const checked = await checkWorkspaceSteps(orgId, userId, job, steps);
  if (!checked.ok) return checked;
  await setWorkspaceAiJobSteps(orgId, job.id, job.capabilities, checked.stored, userId);
  const view = await workspaceAiDefaultsView(orgId, userId, role);
  const names = new Map(view.connections.map((c) => [c.id, c.label]));
  try {
    await activity.log({
      orgId,
      userId,
      action: steps.length ? "ai_job_order_set" : "ai_job_order_cleared",
      ref: { module: null, entityType: "ai_job_order", entityId: job.id },
      diff: { name: job.phrase, steps: steps.map((s) => ({ connection: names.get(s.connection) ?? s.connection, model: s.model })) },
    });
  } catch (err) {
    console.error("[ai-job-order] activity log failed:", (err as Error).message);
  }
  return { ok: true, view };
}
