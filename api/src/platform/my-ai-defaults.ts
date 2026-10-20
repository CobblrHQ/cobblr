// A person's own default AI per job (#5404): the reads, checks and the one
// write every door shares. The account page reaches it through
// /me/ai-defaults (routes/ai-defaults.ts); the assistant through the kernel
// action platform:set-my-default-ai (platform-action-handlers.ts), so its
// change is in the chat's ledger with an undo like every other write.
//
// A save is checked the way the workspace's job picker checks one: the
// connection is the caller's, the provider can do the job, and the model is
// one the connection's listing offers for it.

import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { z } from "zod";
import { sql } from "kysely";
import { AI_DEFAULT_JOBS, type AiDefaultJobId } from "@cobblr/platform-contract";
import type { AiModelChoice } from "@cobblr/platform-contract/ai-models";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as aiImpl from "./ai.js";
import * as activity from "./activity.js";
import { listMyAiJobDefaults, setMyAiJobSteps, type StoredAiJobStep } from "./ai-job-defaults.js";
import { listWorkspaceAiJobSteps } from "./workspace-ai-job-steps.js";

/** How many steps one job may list: more than a call ever asks is a list
 *  nobody can reason about. */
export const MAX_STEPS = 5;

export const StepsBody = z.object({
  steps: z
    .array(z.object({ credential_id: z.string().uuid(), model: z.string().trim().min(1).max(200) }))
    .max(MAX_STEPS),
});

export type Job = (typeof AI_DEFAULT_JOBS)[number];
export const jobById = (id: string | undefined): Job | null => AI_DEFAULT_JOBS.find((j) => j.id === id) ?? null;

/** Everything the page and the assistant need to read and set the defaults:
 *  each job's steps, the person's AI connections with the models each can
 *  do each job with, and the workspaces that chose for a job themselves. */
export async function myAiDefaultsView(userId: string, opts: { fresh?: boolean } = {}): Promise<{
  jobs: Array<{
    id: AiDefaultJobId;
    title: string;
    steps: Array<{ credential_id: string; model: string; model_label?: string; label: string; provider_id: string | null; usable: boolean }>;
    own_order_in: Array<{ org_id: string; slug: string; name: string; can_change: boolean; capabilities: string[]; own_order: boolean }>;
  }>;
  connections: Array<{
    id: string;
    label: string;
    provider_id: string;
    jobs: Partial<Record<AiDefaultJobId, { models: string[]; default_model: string | null; choices?: AiModelChoice[] }>>;
    unlisted?: string;
    /** The provider's listing could not be read; these are its usual models. */
    fallback?: string;
  }>;
  model_labels: Record<string, Record<string, string>>;
}> {
  const [stored, conns, orgs] = await Promise.all([
    listMyAiJobDefaults(userId),
    meta
      .selectFrom("user_credentials")
      .select(["id", "label", "provider_id"])
      .where("user_id", "=", userId)
      .where("kind", "=", "ai-provider")
      .orderBy("created_at", "asc")
      .execute(),
    meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select(["o.id", "o.slug", "o.name", "m.role"])
      .where("m.user_id", "=", userId)
      .orderBy("m.position", "asc")
      .execute(),
  ]);

  const connections = await Promise.all(
    conns.map(async (c) => {
      const jobs: Partial<Record<AiDefaultJobId, { models: string[]; default_model: string | null; choices?: AiModelChoice[] }>> = {};
      let unlisted: string | undefined;
      let fallback: string | undefined;
      for (const [i, j] of AI_DEFAULT_JOBS.entries()) {
        // One listing per connection: the first job asks fresh when told to,
        // the rest read what it brought back.
        const m = await aiImpl.modelsOfMyConnection(userId, c.id, j.shows, { fresh: opts.fresh && i === 0 });
        if (m.ok) {
          jobs[j.id] = { models: m.models, default_model: m.defaultModel, ...(m.choices ? { choices: m.choices } : {}) };
          if (m.fallback) fallback = m.fallback;
        } else if (m.code === "models_unlisted") unlisted = m.message;
      }
      const label = c.label?.trim() || aiImpl.getProvider(c.provider_id)?.label || c.provider_id;
      return { id: c.id, label, provider_id: c.provider_id, jobs, ...(unlisted ? { unlisted } : {}), ...(fallback ? { fallback } : {}) };
    }),
  );
  const connById = new Map(connections.map((c) => [c.id, c]));

  // Which capabilities each workspace pinned for itself, and which jobs it
  // keeps its own order for on its AI page (core_ai_job_steps, #5622): both
  // answer there before a person's own defaults. A workspace without the AI
  // module's tables has chosen nothing.
  const chosen = new Map<string, Set<string>>();
  const ownOrder = new Map<string, Set<string>>();
  await Promise.all(
    orgs.map(async (o) => {
      try {
        const tdb = await getTenantDb(o.id);
        const rows = await sql<{ capability: string }>`select capability from core_ai_capability_defaults`.execute(tdb);
        chosen.set(o.id, new Set(rows.rows.map((r) => r.capability)));
      } catch {
        chosen.set(o.id, new Set());
      }
      ownOrder.set(o.id, new Set((await listWorkspaceAiJobSteps(o.id)).map((s) => s.job)));
    }),
  );

  const model_labels: Record<string, Record<string, string>> = {};
  for (const c of connections) {
    const notes = aiImpl.getProvider(c.provider_id)?.modelNotes;
    if (notes && !model_labels[c.provider_id]) model_labels[c.provider_id] = Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.label]));
  }

  return {
    jobs: AI_DEFAULT_JOBS.map((j) => ({
      id: j.id,
      title: j.title,
      steps: stored
        .filter((s) => s.job === j.id)
        .map((s) => {
          const c = connById.get(s.credential_id);
          const model_label = c?.jobs[j.id]?.choices?.find((x) => x.id === s.model)?.label;
          return {
            credential_id: s.credential_id,
            model: s.model,
            ...(model_label ? { model_label } : {}),
            label: c?.label ?? "A removed connection",
            provider_id: c?.provider_id ?? null,
            usable: !!c?.jobs[j.id],
          };
        }),
      own_order_in: orgs
        .map((o) => ({
          org_id: o.id,
          slug: o.slug,
          name: o.name,
          can_change: roleSatisfies(o.role, ["admin"]),
          capabilities: (j.capabilities as readonly string[]).filter((cap) => chosen.get(o.id)?.has(cap)),
          own_order: !!ownOrder.get(o.id)?.has(j.id),
        }))
        .filter((o) => o.capabilities.length > 0 || o.own_order),
    })),
    connections,
    model_labels,
  };
}

/** Check one job's steps the way the workspace's job picker checks a save:
 *  against the connection's own listing for the job, the same choices the
 *  table offers. Says what is wrong in a sentence, or hands back the steps as
 *  they are kept: a family's latest rides in `model_follows` beside the
 *  version it means now, so `model` always names a model the provider serves
 *  (core-ai migration 0016 keeps a workspace's choice the same way). */
export async function checkSteps(
  userId: string,
  job: Job,
  steps: Array<{ credential_id: string; model: string }>,
): Promise<{ ok: false; refusal: string } | { ok: true; stored: StoredAiJobStep[] }> {
  const seen = new Set<string>();
  const stored: StoredAiJobStep[] = [];
  for (const [i, s] of steps.entries()) {
    const where = i === 0 ? "First" : `Then ${i}`;
    const key = `${s.credential_id}|${s.model}`;
    if (seen.has(key)) return { ok: false, refusal: `${where} repeats an earlier step. Each connection and model is asked once.` };
    seen.add(key);
    const m = await aiImpl.modelsOfMyConnection(userId, s.credential_id, job.shows);
    if (!m.ok) return { ok: false, refusal: `${where}: ${m.message}` };
    if (!m.models.includes(s.model)) {
      const offers = m.choices ? m.choices.map((c) => c.label) : m.models;
      return { ok: false, refusal: `${where}: ${m.label} has no ${s.model} for ${job.phrase}. It offers ${offers.slice(0, 12).join(", ") || "nothing"}.` };
    }
    const latest = m.choices?.find((c) => c.id === s.model)?.latest;
    stored.push({ credential_id: s.credential_id, model: latest?.resolves ?? s.model, model_follows: latest ? s.model : null });
  }
  return { ok: true, stored };
}

/** Each workspace's activity feed says the person changed who answers them
 *  there: their calls in every workspace they use follow this. */
async function logChange(userId: string, job: Job, steps: Array<{ credential_id: string; model: string }>, view: Awaited<ReturnType<typeof myAiDefaultsView>>): Promise<void> {
  const orgs = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).execute();
  const names = new Map(view.connections.map((c) => [c.id, c.label]));
  for (const o of orgs) {
    try {
      await activity.log({
        orgId: o.org_id,
        userId,
        action: steps.length ? "ai_defaults_set" : "ai_defaults_cleared",
        ref: { module: null, entityType: "ai_job_defaults", entityId: job.id },
        diff: { name: job.phrase, steps: steps.map((s) => ({ connection: names.get(s.credential_id) ?? s.credential_id, model: s.model })) },
      });
    } catch (err) {
      console.error("[ai-defaults] activity log failed:", (err as Error).message);
    }
  }
}


/** Replace one job's steps (an empty list clears it), checked first, logged
 *  in every workspace the person uses. Hands back what the job had before,
 *  as it was chosen, so a change can be undone. */
export async function saveMyAiDefaults(
  userId: string,
  job: Job,
  steps: Array<{ credential_id: string; model: string }>,
): Promise<{ ok: false; refusal: string } | { ok: true; view: Awaited<ReturnType<typeof myAiDefaultsView>>; previous: Array<{ credential_id: string; model: string }> }> {
  const checked = await checkSteps(userId, job, steps);
  if (!checked.ok) return checked;
  const previous = (await listMyAiJobDefaults(userId)).filter((s) => s.job === job.id).map((s) => ({ credential_id: s.credential_id, model: s.model }));
  await setMyAiJobSteps(userId, job.id, checked.stored);
  const view = await myAiDefaultsView(userId);
  await logChange(userId, job, steps, view);
  return { ok: true, view, previous };
}

/** What a person may call each job, in words. */
const JOB_WORDS: Array<[AiDefaultJobId, string[]]> = [
  // Quick look first: "a quick look at scans" names a scan too.
  ["glance", ["quick", "glance", "first look", "camera"]],
  ["reading", ["photos", "photo", "scan", "image", "picture", "reading", "identify", "document", "receipt", "invoice", "thorough"]],
  ["chat", ["chat", "cobb", "assistant", "conversation"]],
  ["text", ["text", "organis", "organiz", "summar", "match"]],
  ["search", ["search", "embed"]],
];

/** The job a person named ("scans", "chat"), or null. Personal documents are
 *  never one: they stay on a local model. */
export function jobOfWords(said: string): Job | null {
  const s = said.trim().toLowerCase();
  const id = JOB_WORDS.find(([, words]) => words.some((w) => s === w || s.includes(w)))?.[0];
  return id ? jobById(id) : null;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** One step a person named in words ("my Gemini", "Flash Lite") as the ids a
 *  save takes, or a sentence saying what does not match. A connection by its
 *  id, name or provider; a model by its name on the picker first, then its
 *  id. On a connection that lists its models, a family's name alone
 *  ("Haiku") is its latest and a version ("Haiku 4.5") is that version. */
export function pickMyAiStep(
  view: Awaited<ReturnType<typeof myAiDefaultsView>>,
  job: AiDefaultJobId,
  connection: string,
  model: string,
): { credential_id: string; model: string } | { error: string } {
  const want = squash(connection);
  const conns = view.connections.filter((c) => c.id === connection || squash(c.label) === want || squash(c.provider_id) === want);
  const loose = conns.length ? conns : view.connections.filter((c) => want && (squash(c.label).includes(want) || squash(c.provider_id).includes(want)));
  if (!loose.length) return { error: `You have no AI connection called "${connection}". Yours: ${view.connections.map((c) => c.label).join(", ") || "none"}.` };
  if (loose.length > 1) return { error: `"${connection}" matches ${loose.map((c) => c.label).join(" and ")}. Say which.` };
  const c = loose[0]!;
  const models = c.jobs[job]?.models ?? [];
  if (!models.length) return { error: `${c.label} can't do this job.` };
  const choices = c.jobs[job]?.choices ?? [];
  const labels: Record<string, string> = { ...(view.model_labels[c.provider_id] ?? {}), ...Object.fromEntries(choices.map((x) => [x.id, x.label])) };
  const shorts: Record<string, string> = Object.fromEntries(choices.map((x) => [x.id, x.short]));
  const m = squash(model);
  const exact = models.find((id) => id === model || squash(shorts[id] ?? "") === m || squash(labels[id] ?? "") === m || squash(id) === m);
  const partial = exact ? [] : models.filter((id) => squash(labels[id] ?? "").includes(m) || squash(id).includes(m));
  const hit = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (!hit) {
    return {
      error:
        partial.length > 1
          ? `${c.label} has several models matching "${model}": ${partial.map((id) => labels[id] ?? id).join(", ")}.`
          : `${c.label} has no model "${model}" for this job. It offers ${models.slice(0, 12).map((id) => labels[id] ?? id).join(", ")}.`,
    };
  }
  return { credential_id: c.id, model: hit };
}
