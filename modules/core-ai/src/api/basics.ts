// Ask Cobblr "basic mode" — the no-AI floor, now per-workspace + trainable.
// When a workspace has no AI provider, the chat calls POST /basics/answer and
// gets a lexical, deterministic answer from the EFFECTIVE ruleset: the built-in
// catalog (basics-catalog.ts) overlaid with this workspace's overrides + custom
// rules (core_ai_basics). Owners/admins manage the rules here; matching + the
// list are member-visible. No provider, no cost, no dead-end.
//
// See docs/design-decisions/no-ai-chat-training.md.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { matchBasics } from "../basics-match.js";
import {
  loadEffectiveRules,
  toMatchable,
  nextCustomPosition,
  isBuiltinKey,
  builtinDefaultPosition,
} from "../basics-store.js";

export const basicsRouter = Router({ mergeParams: true });

const Keywords = z.array(z.string().trim().min(1).max(80)).min(1).max(40);
const AnswerBody = z.object({ message: z.string().min(1).max(2000) });

const BasicCreate = z.object({
  intent: z.string().trim().min(1).max(120),
  keywords: Keywords,
  reply: z.string().trim().min(1).max(4000),
  enabled: z.boolean().optional(),
  // Set to override a built-in (snapshotting its fields); omit for a custom rule.
  builtin_key: z.string().min(1).optional(),
});
const BasicUpdate = z.object({
  intent: z.string().trim().min(1).max(120).optional(),
  keywords: Keywords.optional(),
  reply: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});

// GET /basics — the effective ruleset (built-ins overlaid with overrides + customs).
basicsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rules = await loadEffectiveRules(tenantDb(req));
    res.json({ rules });
  }),
);

// POST /basics/answer — match a message → reply (chat's no-AI path + the tester).
basicsRouter.post(
  "/answer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const effective = await loadEffectiveRules(tenantDb(req));
    res.json(matchBasics(parsed.data.message, toMatchable(effective)));
  }),
);

// POST /basics — create a custom rule, or override a built-in (builtin_key set).
basicsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = BasicCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { intent, keywords, reply, enabled, builtin_key } = parsed.data;
    if (builtin_key && !isBuiltinKey(builtin_key)) {
      res.status(400).json({ error: { code: "unknown_builtin", message: `No built-in rule "${builtin_key}"` } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // Overrides keep the built-in's place; new customs append after everything.
    const position = builtin_key ? builtinDefaultPosition(builtin_key) : nextCustomPosition(await loadEffectiveRules(db));
    try {
      const row = await db
        .insertInto("core_ai_basics")
        .values({
          builtin_key: builtin_key ?? null,
          intent,
          reply,
          keywords: sql`${JSON.stringify(keywords)}::jsonb` as never,
          enabled: enabled ?? true,
          position,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      void platform().events.emit("core-ai.basic.created", { orgId: ctx.org.id, rowId: row.id });
      res.status(201).json(row);
    } catch (e) {
      // The partial unique index guards against a second override of one
      // built-in. Match on pg's SQLSTATE, with a message fallback in case the
      // driver error is wrapped before it reaches here.
      const code = (e as { code?: string }).code;
      const msg = String((e as Error)?.message ?? "");
      if (code === "23505" || /unique|duplicate key/i.test(msg)) {
        res.status(409).json({ error: { code: "already_overridden", message: `"${builtin_key}" already has an override — edit it instead` } });
        return;
      }
      throw e;
    }
  }),
);

// PATCH /basics/:id — edit a custom rule or an existing built-in override.
basicsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = BasicUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const d = parsed.data;
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (d.intent !== undefined) set.intent = d.intent;
    if (d.reply !== undefined) set.reply = d.reply;
    if (d.enabled !== undefined) set.enabled = d.enabled;
    if (d.position !== undefined) set.position = d.position;
    if (d.keywords !== undefined) set.keywords = sql`${JSON.stringify(d.keywords)}::jsonb` as never;

    const row = await tenantDb(req)
      .updateTable("core_ai_basics")
      .set(set as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "No such rule" } });
      return;
    }
    void platform().events.emit("core-ai.basic.updated", { orgId: tenantContext(req).org.id, rowId: id });
    res.json(row);
  }),
);

// DELETE /basics/:id — remove a custom rule, or reset a built-in to its default.
basicsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const del = await tenantDb(req).deleteFrom("core_ai_basics").where("id", "=", id).executeTakeFirst();
    if (!del.numDeletedRows) {
      res.status(404).json({ error: { code: "not_found", message: "No such rule" } });
      return;
    }
    void platform().events.emit("core-ai.basic.deleted", { orgId: tenantContext(req).org.id, rowId: id });
    res.status(204).end();
  }),
);
