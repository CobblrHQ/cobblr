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
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  assembleContext,
  compilePrompt,
  repairPrompt,
  type ValidationError,
} from "../services/compile.js";

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
});
draftsRouter.post(
  "/compile",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CompileBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const user = sessionUser(req);
    const ctx = await assembleContext(orgId, parsed.data.selected_kinds, parsed.data.task ?? "create-bundle");
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
        created_by: user?.id ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    res.status(201).json({ draft_id: draft.id, prompt, warnings: ctx.warnings });
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
    // autoEnable:true → a referenced-but-unenabled module shows in
    // preview.modules_to_enable (apply enables it), not as an error.
    const { body: v } = await callBundles(req, "validate", { manifest: parsed.data.manifest, autoEnable: true });
    await db
      .updateTable("core_authoring_drafts")
      .set({
        candidate: jsonb(parsed.data.manifest) as never,
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
