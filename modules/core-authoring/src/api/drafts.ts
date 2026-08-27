// Authoring routes — the copy-paste value loop (Phase 1, zero inference).
//
//   /context              preview what context will be injected
//   /compile              build the prompt (+ persist a draft)
//   /drafts/:id/candidate paste a manifest back → validate (kernel gate)
//   /drafts/:id/repair-prompt   a copy-paste repair prompt for the errors
//   /drafts/:id/apply     install the validated candidate
//   /drafts, /drafts/:id  list / detail (the eval corpus + history)
//
// Validation + install reuse the EXISTING bundles endpoints — single
// source of truth — via an in-process call to this same API. The module
// never re-implements manifest validation.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  assembleContext,
  compilePrompt,
  repairPrompt,
  unwrapBuild,
  unwrapApp,
  nativeFieldsByBaseKind,
  type ValidationError,
  type SeedGroup,
} from "../services/compile.js";
import type { KindFields } from "../services/corroborate.js";
import { kindFieldsOf, modulesOf, shapeCandidate } from "../services/shape.js";
import { listTemplates, getTemplate } from "../services/templates.js";
import { matchTemplateHosted } from "../services/match-template.js";

export const draftsRouter = Router({ mergeParams: true });

interface BundlesResponse {
  status: number;
  body: Record<string, unknown>;
}

// Call our own bundles API in-process (same node, loopback). Forwards the
// caller's bearer so the install/validate run AS the user, inside their
// tenant — so they can't validate/apply against a workspace they can't
// reach. This is the "forwards to the existing endpoint" gate from the
// spec; validation lives with the manifest schema, not duplicated here.
async function callBundles(
  req: Parameters<typeof tenantContext>[0],
  path: "validate" | "install",
  body: Record<string, unknown>,
): Promise<BundlesResponse> {
  const port = process.env.API_PORT ?? "4000";
  const slug = tenantContext(req).org.slug;
  const auth = req.headers.authorization ?? "";
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/orgs/${slug}/bundles/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
  const respBody = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: respBody };
}

// In-process call to core-apps, AS the caller. `path` "validate" → the dry-run
// gate (same { valid, errors } shape as bundles/validate, so the repair loop is
// uniform); "" → POST /apps (create the app). Used by the design-app task.
async function callApps(
  req: Parameters<typeof tenantContext>[0],
  path: "validate" | "",
  body: Record<string, unknown>,
): Promise<BundlesResponse> {
  const port = process.env.API_PORT ?? "4000";
  const slug = tenantContext(req).org.slug;
  const auth = req.headers.authorization ?? "";
  const url = `http://127.0.0.1:${port}/api/v1/orgs/${slug}/modules/core-apps/apps${path ? `/${path}` : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
  const respBody = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: respBody };
}

// One validation indirection for both artifact kinds — design-app validates the
// app definition via /apps/validate; everything else is a bundle manifest via
// /bundles/validate (autoEnable so a referenced-but-unenabled module surfaces in
// the preview, not as an error). Returns the shared { valid, errors } shape.
// Both app tasks (structured blocks + custom HTML) produce a WorkspaceApp and
// validate/apply via core-apps; everything else is a bundle.
function isAppTask(task: string): boolean {
  // refine-app included: its output is a WorkspaceApp (unwrapApp + /apps/validate).
  return task === "design-app" || task === "design-app-custom" || task === "refine-app";
}

async function validateArtifact(
  req: Parameters<typeof tenantContext>[0],
  task: string,
  candidate: unknown,
): Promise<BundlesResponse> {
  if (isAppTask(task)) {
    return callApps(req, "validate", (candidate ?? {}) as Record<string, unknown>);
  }
  return callBundles(req, "validate", { manifest: candidate, autoEnable: true });
}

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? null)}::jsonb`;


// Kind → that module's create endpoint, for seeding starter records on apply
// (mirrors core-scan's commit map + core-ai chat). Only these kinds can be
// seeded; an unmapped kind's records are skipped (and reported).
const KIND_CREATE_PATHS: Record<string, string> = {
  "inventory:part": "inventory/parts",
  "machines:machine": "machines/machines",
  "assets:asset": "assets/assets",
  "projects:project": "projects/projects",
  "projects:task": "projects/tasks",
  "lists:list": "lists/lists",
  "lists:item": "lists/items",
};

// In-process POST to a module's create endpoint, AS the caller (forwards the
// bearer) — same loopback pattern as callBundles.
async function callCreate(
  req: Parameters<typeof tenantContext>[0],
  modulePath: string,
  body: Record<string, unknown>,
): Promise<number> {
  const port = process.env.API_PORT ?? "4000";
  const slug = tenantContext(req).org.slug;
  const auth = req.headers.authorization ?? "";
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/orgs/${slug}/modules/${modulePath}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
  return r.status;
}

// Best-effort: create each planned starter record via its kind's endpoint.
// Custom-field values ride inline — the create endpoints route unknown keys
// into the entity's metadata. Never throws; a bad/unmapped row is just skipped.
async function seedRecords(
  req: Parameters<typeof tenantContext>[0],
  seed: SeedGroup[],
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const group of seed) {
    const path = KIND_CREATE_PATHS[group.kind];
    if (!path) {
      skipped += group.records.length;
      continue;
    }
    for (const rec of group.records) {
      try {
        const status = await callCreate(req, path, rec);
        if (status >= 200 && status < 300) created++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
  }
  return { created, skipped };
}

// ── GET /templates — the flagship template catalog (match-template, Phase 1) ──
// The driving model / user reads this list and picks the nearest template;
// no kernel inference (hosted LLM match is Phase 2). See
// docs/architecture/templates-first-authoring.md.
draftsRouter.get(
  "/templates",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({ items: listTemplates() });
  }),
);

// ── GET /templates/:id — one template incl. its starting manifest ──
draftsRouter.get(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const t = getTemplate(req.params.id!);
    if (!t) {
      res.status(404).json({ error: { code: "not_found", message: "Template not found." } });
      return;
    }
    res.json(t);
  }),
);

// ── POST /match-template — hosted match (Phase 2, the non-dev path) ──
// One cheap core-ai call maps the intent → nearest template + confidence.
// Degrades to { template_id: null, ai: false } when no AI provider is
// configured (the caller then shows the full catalog). See
// docs/architecture/templates-first-authoring.md.
const MatchBody = z.object({ intent: z.string().min(1).max(4000) });
// AI-REACH: a step of the design-a-workspace flow, which the assistant enters through the build move (chat.ts) and the user drives from the Build page
draftsRouter.post(
  "/match-template",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const match = await matchTemplateHosted(tenantContext(req).org.id, parsed.data.intent, sessionUser(req)?.id ?? null);
    res.json(match);
  }),
);

// ── POST /context — preview the assembled context (+ warnings) ──
const ContextBody = z.object({ selected_kinds: z.array(z.string()).optional() });
// AI-REACH: a step of the design-a-workspace flow (see /build)
draftsRouter.post(
  "/context",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ContextBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const tc = tenantContext(req);
    const ctx = await assembleContext(tc.org.id, parsed.data.selected_kinds, "create-bundle", undefined, tc.role);
    res.json({
      kinds: ctx.kinds,
      actions: ctx.actions,
      output_contract: ctx.outputContract,
      requester_role: ctx.requesterRole,
      warnings: ctx.warnings,
    });
  }),
);

// ── POST /compile — build the prompt + persist the draft ──
const CompileBody = z.object({
  intent: z.string().min(1).max(4000),
  selected_kinds: z.array(z.string()).optional(),
  task: z.string().optional(),
  base_template_id: z.string().optional(),
});
// AI-REACH: a step of the design-a-workspace flow (see /build)
draftsRouter.post(
  "/compile",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CompileBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const tc = tenantContext(req);
    const orgId = tc.org.id;
    const user = sessionUser(req);
    let ctx;
    try {
      ctx = await assembleContext(
        orgId,
        parsed.data.selected_kinds,
        parsed.data.task ?? "create-bundle",
        parsed.data.base_template_id,
        tc.role,
      );
    } catch (e) {
      // Bad task/template selection → a clean 400, not a 500.
      res.status(400).json({ error: { code: "bad_task", message: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const prompt = compilePrompt(ctx, parsed.data.intent);
    const db = tenantDb(req);
    const draft = await db
      .insertInto("core_authoring_drafts")
      .values({
        task: ctx.task,
        intent: parsed.data.intent,
        selected_kinds: jsonb(parsed.data.selected_kinds ?? []) as never,
        context_snapshot: jsonb(ctx) as never,
        compiled_prompt: prompt,
        mode: "copy-paste",
        status: "prompt-built",
        base_template_id: parsed.data.base_template_id ?? null,
        created_by: user?.id ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    res.status(201).json({ draft_id: draft.id, prompt, warnings: ctx.warnings });
  }),
);

// ── POST /build — HOSTED build (Phase 2): inline AI + auto-repair, ASYNC ──
// A whole-workspace generation runs ~150s and can need a repair pass (~290s) —
// far past nginx's 60s proxy read timeout and any sane "frozen button". So the
// request returns IMMEDIATELY with the draft id + status:"building", and the
// AI+validate+repair loop runs in the background, writing the result back onto
// the draft row. The client polls GET /drafts/:id until status leaves
// "building" (→ validated | candidate | failed). Same kernel gate, same
// auto-repair; only the transport changed from blocking to poll.
const BuildBody = z.object({
  intent: z.string().min(1).max(4000),
  selected_kinds: z.array(z.string()).optional(),
  task: z.string().optional(),
  base_template_id: z.string().optional(),
});
const MAX_BUILD_ATTEMPTS = 3;

// The background loop. Detached from the request (not awaited) — it owns the
// draft from "building" to a terminal status. Never throws to the caller; any
// failure is recorded on the draft as status:"failed".
async function runBuild(
  req: Parameters<typeof tenantDb>[0],
  draftId: string,
  orgId: string,
  basePrompt: string,
  userId: string | null,
  task: string,
  /** What the request said and what the workspace already has — the two
   *  things the corroboration layer checks a candidate against. */
  corroborate: { intent: string; kinds: Map<string, KindFields>; modules?: ReadonlySet<string> },
): Promise<void> {
  const db = tenantDb(req);
  let prompt = basePrompt;
  let candidate: unknown = null;
  let interpretation: string | null = null;
  let seed: SeedGroup[] = [];
  try {
    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      let text: string;
      try {
        const r = await platform().ai.invoke({
          orgId,
          capability: "chat",
          // NOT constrained to an output schema, deliberately. The adapters can
          // take one (ollama `format`, OpenAI-compatible `response_format`) and
          // the wrapper schema exists (outputSchemaFor), but measured 2026-08-26
          // it hurt both wires: qwen3:14b timed out at 120s on every case under
          // schema-constrained decoding, and Gemini conformed so strictly to a
          // permissive schema that it emitted null list items. It comes back
          // when the FULL bundle schema is what gets sent, not a wrapper.
          input: { messages: [{ role: "user", content: prompt }] },
          source: { kind: "core-authoring:build", id: draftId },
          userId,
        });
        const result = r.result as { content?: string; text?: string } | string;
        text = typeof result === "string" ? result : (result?.content ?? result?.text ?? "");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const noAi = msg.includes("no provider") || msg.includes("not entitled") || msg.includes("not available");
        await db
          .updateTable("core_authoring_drafts")
          .set({
            status: "failed",
            validation: jsonb({
              valid: false,
              errors: [{ path: "", code: noAi ? "no_ai_provider" : "ai_error", message: msg }],
            }) as never,
            updated_at: new Date(),
          })
          .where("id", "=", draftId)
          .execute();
        return;
      }

      // ONE implementation of parse → unwrap → lean natives → corroborate, shared
      // with the operator eval so what gets measured is what ships.
      const shaped = shapeCandidate(text, task, {
        intent: corroborate.intent,
        kinds: corroborate.kinds,
        ...(corroborate.modules ? { modules: corroborate.modules } : {}),
        natives: await nativeFieldsByBaseKind(),
      });
      candidate = shaped.candidate;
      if (shaped.interpretation) interpretation = shaped.interpretation;
      if (shaped.seed.length > 0 || isAppTask(task)) seed = shaped.seed;
      if (candidate === null || typeof candidate !== "object") {
        const wrapperKey = isAppTask(task) ? "app" : "bundle";
        prompt = repairPrompt(basePrompt, text, [
          { path: "", code: "not_json", message: `Your output was not valid JSON. Return ONLY one JSON object: { "interpretation": "...", "${wrapperKey}": {...} } — no prose, no fences.` },
        ]);
        continue;
      }

      const { body: v } = await validateArtifact(req, task, candidate);
      await db
        .updateTable("core_authoring_drafts")
        .set({
          candidate: jsonb(candidate) as never,
          validation: jsonb(v) as never,
          interpretation,
          seed_plan: jsonb(seed) as never,
          // Terminal on valid; otherwise keep "building" while we still have
          // repair attempts left, so the poller doesn't stop early.
          status: v.valid ? "validated" : attempt >= MAX_BUILD_ATTEMPTS ? "candidate" : "building",
          updated_at: new Date(),
        })
        .where("id", "=", draftId)
        .execute();
      if (v.valid) return;
      prompt = repairPrompt(basePrompt, candidate, (v.errors as ValidationError[] | undefined) ?? []);
    }
  } catch (e) {
    // Defensive: an unexpected error shouldn't leave the draft stuck "building".
    await db
      .updateTable("core_authoring_drafts")
      .set({
        status: "failed",
        validation: jsonb({ valid: false, errors: [{ path: "", code: "build_error", message: e instanceof Error ? e.message : String(e) }] }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", draftId)
      .execute()
      .catch(() => {});
  }
}

// AI-REACH: the assistant enters this through the chat build move, not as a tool; a whole-workspace build always previews before applying
draftsRouter.post(
  "/build",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BuildBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const tc = tenantContext(req);
    const orgId = tc.org.id;
    const user = sessionUser(req);

    let ctx;
    try {
      ctx = await assembleContext(
        orgId,
        parsed.data.selected_kinds,
        parsed.data.task ?? "create-bundle",
        parsed.data.base_template_id,
        tc.role,
      );
    } catch (e) {
      res.status(400).json({ error: { code: "bad_task", message: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const basePrompt = compilePrompt(ctx, parsed.data.intent);
    const db = tenantDb(req);
    const draft = await db
      .insertInto("core_authoring_drafts")
      .values({
        task: ctx.task,
        intent: parsed.data.intent,
        selected_kinds: jsonb(parsed.data.selected_kinds ?? []) as never,
        context_snapshot: jsonb(ctx) as never,
        compiled_prompt: basePrompt,
        mode: "hosted",
        status: "building",
        base_template_id: parsed.data.base_template_id ?? null,
        created_by: user?.id ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    // Fire-and-forget: the loop drives the draft to a terminal status; the
    // client polls GET /drafts/:id. (Single api instance — in-process detach
    // is fine; a crash mid-build just leaves a stale "building" draft.)
    void runBuild(req, draft.id, orgId, basePrompt, user?.id ?? null, ctx.task, {
      intent: parsed.data.intent,
      kinds: kindFieldsOf(ctx),
      modules: modulesOf(ctx),
    });

    res.status(202).json({ draft_id: draft.id, status: "building" });
  }),
);

// ── POST /drafts/:id/refine — Phase 3: revise this draft's artifact ──
// The other half of describe-and-react: "now change X" instead of starting
// over or hand-editing JSON. Takes the parent draft's candidate, compiles a
// refine-bundle prompt around it, and creates a NEW draft (parent_draft_id
// lineage). run:true (default when an AI provider exists is still explicit —
// the caller chooses) drives the same hosted build/repair loop as /build;
// run:false returns the prompt for the copy-paste flow. Same kernel gate.
const RefineBody = z.object({
  intent: z.string().min(1).max(4000),
  run: z.boolean().optional(),
});
// AI-REACH: refines a draft the user is looking at on the Build page; a Build-page step
draftsRouter.post(
  "/drafts/:id/refine",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RefineBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const tc = tenantContext(req);
    const user = sessionUser(req);
    const db = tenantDb(req);

    const parent = await db
      .selectFrom("core_authoring_drafts")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!parent) {
      res.status(404).json({ error: { code: "not_found", message: "No such draft." } });
      return;
    }
    const artifact = parent.candidate as Record<string, unknown> | null;
    if (!artifact || typeof artifact !== "object") {
      res.status(409).json({ error: { code: "no_artifact", message: "This draft has no candidate to refine, build or paste one first." } });
      return;
    }

    // Bundle drafts revise as bundles; app drafts (design-app / design-app-custom
    // / refine-app lineage) revise as apps — same gate their creator used.
    const refineTask = isAppTask(parent.task) ? "refine-app" : "refine-bundle";
    let ctx;
    try {
      ctx = await assembleContext(
        tc.org.id,
        (parent.selected_kinds as string[] | null) ?? undefined,
        refineTask,
        undefined,
        tc.role,
      );
    } catch (e) {
      res.status(400).json({ error: { code: "bad_task", message: e instanceof Error ? e.message : String(e) } });
      return;
    }
    ctx.baseArtifact = artifact;
    const basePrompt = compilePrompt(ctx, parsed.data.intent);
    const run = parsed.data.run ?? false;

    const draft = await db
      .insertInto("core_authoring_drafts")
      .values({
        task: refineTask,
        intent: parsed.data.intent,
        selected_kinds: jsonb(parent.selected_kinds ?? []) as never,
        context_snapshot: jsonb(ctx) as never,
        compiled_prompt: basePrompt,
        mode: run ? "hosted" : "copy-paste",
        status: run ? "building" : "prompt-built",
        parent_draft_id: parent.id,
        created_by: user?.id ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    if (run) {
      void runBuild(req, draft.id, tc.org.id, basePrompt, user?.id ?? null, refineTask, {
        intent: parsed.data.intent,
        kinds: kindFieldsOf(ctx),
      modules: modulesOf(ctx),
      });
      res.status(202).json({ draft_id: draft.id, parent_draft_id: parent.id, status: "building" });
      return;
    }
    res.status(201).json({ draft_id: draft.id, parent_draft_id: parent.id, prompt: basePrompt, warnings: ctx.warnings });
  }),
);

// ── POST /drafts/:id/candidate — paste a manifest back → validate ──
const CandidateBody = z.object({ manifest: z.unknown() });
// AI-REACH: a Build-page step
draftsRouter.post(
  "/drafts/:id/candidate",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CandidateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const draft = await db
      .selectFrom("core_authoring_drafts")
      // base_template_id too: a customize-template draft cannot rebuild its
      // context without it, and assembleContext throws when it is missing.
      .select(["id", "task", "intent", "base_template_id"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    // A pasted reply is still a model's reply: it goes through the SAME
    // parse → unwrap → lean natives → corroborate as a generated one. This
    // route used to unwrap by hand, which was a door around the corroboration
    // layer — the class lint:capabilities now closes.
    const tc = tenantContext(req);
    // Carry the draft's base template through. Without it a customize-template
    // draft threw 'requires a base_template_id' — surfaced as a 500 — so pasting
    // your own manifest back into a customized template never validated.
    let ctx;
    try {
      ctx = await assembleContext(
        tc.org.id,
        undefined,
        draft.task,
        draft.base_template_id ?? undefined,
        tc.role,
      );
    } catch (e) {
      // A knowable condition (unknown/removed template), not an internal fault —
      // the sibling refine route already answers bad_task the same way.
      res.status(400).json({ error: { code: "bad_task", message: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const shaped = shapeCandidate(JSON.stringify(parsed.data.manifest), draft.task, {
      intent: draft.intent ?? "",
      kinds: kindFieldsOf(ctx),
      modules: modulesOf(ctx),
      natives: await nativeFieldsByBaseKind(),
    });
    const candidate = shaped.candidate;
    const { body: v } = await validateArtifact(req, draft.task, candidate);
    await db
      .updateTable("core_authoring_drafts")
      .set({
        candidate: jsonb(candidate) as never,
        validation: jsonb(v) as never,
        status: v.valid ? "validated" : "candidate",
        updated_at: new Date(),
      })
      .where("id", "=", req.params.id!)
      .execute();
    res.json(v);
  }),
);

// ── POST /drafts/:id/repair-prompt — copy-paste repair prompt ──
// AI-REACH: a Build-page step
draftsRouter.post(
  "/drafts/:id/repair-prompt",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const draft = await db
      .selectFrom("core_authoring_drafts")
      .select(["compiled_prompt", "candidate", "validation"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    const validation = (draft.validation as { errors?: ValidationError[] } | null) ?? {};
    const errors = validation.errors ?? [];
    if (!draft.candidate || errors.length === 0) {
      res.status(400).json({ error: { code: "nothing_to_repair", message: "This draft has no rejected candidate to repair." } });
      return;
    }
    res.json({ prompt: repairPrompt(draft.compiled_prompt, draft.candidate, errors) });
  }),
);

// ── POST /drafts/:id/apply — install the validated candidate ──
const ApplyBody = z.object({ confirm: z.boolean().optional() });
// AI-REACH: applies a previewed build; the confirm lives on the Build page and in the chat's build proposal card
draftsRouter.post(
  "/drafts/:id/apply",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ApplyBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const draft = await db
      .selectFrom("core_authoring_drafts")
      .select(["id", "candidate", "seed_plan", "task"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    if (!draft.candidate) {
      res.status(400).json({ error: { code: "no_candidate", message: "Validate a candidate before applying." } });
      return;
    }

    // design-app: apply = create the WorkspaceApp (the create endpoint re-runs
    // the same AppCreate schema validation, so a stale candidate can't sneak in).
    if (isAppTask(draft.task)) {
      const { status, body: ares } = await callApps(req, "", draft.candidate as Record<string, unknown>);
      if (status >= 400) {
        res.status(status).json(ares);
        return;
      }
      await db
        .updateTable("core_authoring_drafts")
        .set({ status: "applied", updated_at: new Date() })
        .where("id", "=", req.params.id!)
        .execute();
      res.json({ applied: true, app: ares });
      return;
    }

    // Bundle: forward to install — which RE-VALIDATES (never trust a stale
    // candidate). confirm defaults true so required modules are enabled as part
    // of the apply.
    const { status, body: ires } = await callBundles(req, "install", {
      manifest: draft.candidate,
      confirm: parsed.data.confirm ?? true,
    });
    if (status >= 400) {
      res.status(status).json(ires);
      return;
    }
    // Schema is live (modules enabled + fields/wires created) — NOW seed the
    // starter records the design planned (best-effort; the fields they set
    // already exist). Other tasks have no seed_plan, so this is a no-op there.
    const seed = Array.isArray(draft.seed_plan) ? (draft.seed_plan as SeedGroup[]) : [];
    const seeded = seed.length > 0 ? await seedRecords(req, seed) : { created: 0, skipped: 0 };
    await db
      .updateTable("core_authoring_drafts")
      .set({ status: "applied", updated_at: new Date() })
      .where("id", "=", req.params.id!)
      .execute();
    res.json({ applied: true, bundle: ires, seeded });
  }),
);

// ── GET /drafts — list (the corpus + history) ──
draftsRouter.get(
  "/drafts",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const items = await db
      .selectFrom("core_authoring_drafts")
      .select(["id", "task", "intent", "mode", "status", "created_at", "updated_at"])
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    res.json({ items });
  }),
);

// ── GET /drafts/:id — detail ──
draftsRouter.get(
  "/drafts/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const draft = await db.selectFrom("core_authoring_drafts").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    res.json(draft);
  }),
);
