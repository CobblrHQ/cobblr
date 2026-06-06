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
  parseJsonObject,
  unwrapBuild,
  type ValidationError,
} from "../services/compile.js";
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

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? null)}::jsonb`;

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
draftsRouter.post(
  "/match-template",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const match = await matchTemplateHosted(tenantContext(req).org.id, parsed.data.intent);
    res.json(match);
  }),
);

// ── POST /context — preview the assembled context (+ warnings) ──
const ContextBody = z.object({ selected_kinds: z.array(z.string()).optional() });
draftsRouter.post(
  "/context",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ContextBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = await assembleContext(tenantContext(req).org.id, parsed.data.selected_kinds);
    res.json({ kinds: ctx.kinds, actions: ctx.actions, output_contract: ctx.outputContract, warnings: ctx.warnings });
  }),
);

// ── POST /compile — build the prompt + persist the draft ──
const CompileBody = z.object({
  intent: z.string().min(1).max(4000),
  selected_kinds: z.array(z.string()).optional(),
  task: z.string().optional(),
  base_template_id: z.string().optional(),
});
draftsRouter.post(
  "/compile",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CompileBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const user = sessionUser(req);
    let ctx;
    try {
      ctx = await assembleContext(
        orgId,
        parsed.data.selected_kinds,
        parsed.data.task ?? "create-bundle",
        parsed.data.base_template_id,
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

// ── POST /build — HOSTED build (Phase 2): inline AI + auto-repair ──
// Compiles the prompt, calls the workspace's AI itself, validates the result
// through the SAME kernel gate (callBundles validate), and auto-repairs on
// failure (re-prompts with the validator's errors, up to MAX_BUILD_ATTEMPTS).
// Returns a validated, ready-to-apply draft — no copy-paste. Degrades cleanly
// when the workspace has no AI (409 no_ai_provider) so the UI falls back.
const BuildBody = z.object({
  intent: z.string().min(1).max(4000),
  selected_kinds: z.array(z.string()).optional(),
  task: z.string().optional(),
  base_template_id: z.string().optional(),
});
const MAX_BUILD_ATTEMPTS = 3;
draftsRouter.post(
  "/build",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BuildBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const user = sessionUser(req);

    let ctx;
    try {
      ctx = await assembleContext(
        orgId,
        parsed.data.selected_kinds,
        parsed.data.task ?? "create-bundle",
        parsed.data.base_template_id,
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
        status: "prompt-built",
        base_template_id: parsed.data.base_template_id ?? null,
        created_by: user?.id ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const draftId = draft.id;

    let prompt = basePrompt;
    let lastValidation: Record<string, unknown> | null = null;
    let candidate: unknown = null;
    let interpretation: string | null = null;

    for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
      let text: string;
      try {
        const r = await platform().ai.invoke({
          orgId,
          capability: "chat",
          input: { messages: [{ role: "user", content: prompt }] },
          source: { kind: "core-authoring:build", id: draftId },
        });
        const result = r.result as { content?: string; text?: string } | string;
        text = typeof result === "string" ? result : (result?.content ?? result?.text ?? "");
      } catch (e) {
        // No provider / not entitled → degrade so the UI offers copy-paste.
        const msg = e instanceof Error ? e.message : String(e);
        const noAi = msg.includes("no provider") || msg.includes("not entitled") || msg.includes("not available");
        res.status(noAi ? 409 : 502).json({
          draft_id: draftId,
          ai: false,
          error: { code: noAi ? "no_ai_provider" : "ai_error", message: msg },
        });
        return;
      }

      const unwrapped = unwrapBuild(parseJsonObject(text));
      candidate = unwrapped.bundle;
      if (unwrapped.interpretation) interpretation = unwrapped.interpretation;
      if (candidate === null || typeof candidate !== "object") {
        lastValidation = { valid: false, errors: [{ path: "", code: "not_json", message: "AI did not return a JSON object." }] };
        prompt = repairPrompt(basePrompt, text, [
          { path: "", code: "not_json", message: 'Your output was not valid JSON. Return ONLY one JSON object: { "interpretation": "...", "bundle": {...} } — no prose, no fences.' },
        ]);
        continue;
      }

      const { body: v } = await callBundles(req, "validate", { manifest: candidate, autoEnable: true });
      lastValidation = v;
      await db
        .updateTable("core_authoring_drafts")
        .set({
          candidate: jsonb(candidate) as never,
          validation: jsonb(v) as never,
          status: v.valid ? "validated" : "candidate",
          updated_at: new Date(),
        })
        .where("id", "=", draftId)
        .execute();

      if (v.valid) {
        res.json({ draft_id: draftId, ai: true, valid: true, attempts: attempt, validation: v, candidate, interpretation });
        return;
      }
      prompt = repairPrompt(basePrompt, candidate, (v.errors as ValidationError[] | undefined) ?? []);
    }

    // Exhausted attempts — return the last validation so the UI can show the
    // errors + offer the copy-paste repair path.
    res.json({ draft_id: draftId, ai: true, valid: false, attempts: MAX_BUILD_ATTEMPTS, validation: lastValidation, candidate, interpretation });
  }),
);

// ── POST /drafts/:id/candidate — paste a manifest back → validate ──
const CandidateBody = z.object({ manifest: z.unknown() });
draftsRouter.post(
  "/drafts/:id/candidate",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CandidateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const draft = await db.selectFrom("core_authoring_drafts").select("id").where("id", "=", req.params.id!).executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    // The pasted reply may be the wrapper `{ interpretation, bundle }` (the
    // new contract) or a bare bundle — unwrap to the bundle before validating.
    const { bundle } = unwrapBuild(parsed.data.manifest);
    // autoEnable:true → a referenced-but-unenabled module shows in
    // preview.modules_to_enable (apply enables it), not as an error.
    const { body: v } = await callBundles(req, "validate", { manifest: bundle, autoEnable: true });
    await db
      .updateTable("core_authoring_drafts")
      .set({
        candidate: jsonb(bundle) as never,
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
draftsRouter.post(
  "/drafts/:id/apply",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ApplyBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const draft = await db.selectFrom("core_authoring_drafts").select(["id", "candidate"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!draft) {
      res.status(404).json({ error: { code: "not_found", message: "Draft not found." } });
      return;
    }
    if (!draft.candidate) {
      res.status(400).json({ error: { code: "no_candidate", message: "Paste a manifest and validate it before applying." } });
      return;
    }
    // Forward to install — which RE-VALIDATES (never trust a stale
    // candidate). confirm defaults true so required modules are enabled
    // as part of the apply.
    const { status, body: ires } = await callBundles(req, "install", {
      manifest: draft.candidate,
      confirm: parsed.data.confirm ?? true,
    });
    if (status >= 400) {
      res.status(status).json(ires);
      return;
    }
    await db
      .updateTable("core_authoring_drafts")
      .set({ status: "applied", updated_at: new Date() })
      .where("id", "=", req.params.id!)
      .execute();
    res.json({ applied: true, bundle: ires });
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
