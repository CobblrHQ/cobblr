// /api/v1/orgs/:slug/modules/core-ai/providers — CRUD over the
// per-workspace `core_ai_providers` table. Encrypts credentials at
// write time using the shared per-org master key.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const providersRouter = Router({ mergeParams: true });

const ProviderCreate = z.object({
  provider_id: z.string().min(1),
  label: z.string().min(1).max(120),
  credentials: z.record(z.unknown()),
  /** Omitted, an ADDITIONAL provider arrives off and the FIRST one arrives on
   *  (see the insert below). Pass it explicitly to switch the workspace's AI
   *  in the same call that adds it. */
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  monthly_budget_cents: z.number().int().positive().nullable().optional(),
});

const ProviderUpdate = z.object({
  label: z.string().min(1).max(120).optional(),
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  monthly_budget_cents: z.number().int().positive().nullable().optional(),
});

// Test credentials that have NOT been saved. The existing /:id/test needs a stored row,
// which forces save-then-test: a bad key gets persisted and only then reported, and the
// person is left with a broken connection to go and edit. This tests what is currently
// typed, so nothing wrong is ever written down.
//
// It also returns the provider's model list, because validating a key IS a model-list
// request for every OpenAI-compatible provider. That list is what lets the form offer a
// dropdown instead of asking someone to type an exact model name.
//
// Nothing is stored: the credentials live for the length of this request.
//
// AI-REACH: exempt credentials - it takes a raw API key, which the assistant must never handle
providersRouter.post(
  "/test-credentials",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const Body = z.object({
      provider_id: z.string().min(1).max(80),
      credentials: z.record(z.unknown()),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "provider_id + credentials required" } });
      return;
    }
    const def = platform().ai.getProvider(parsed.data.provider_id);
    if (!def) {
      res.status(404).json({ error: { code: "not_found", message: "unknown provider" } });
      return;
    }
    if (!def.testConnection) {
      res.json({ ok: true, note: "provider has no test implementation; assumed ok" });
      return;
    }
    const ctx = tenantContext(req);
    // Same org injection as /:id/test, so a bridge-transit provider can derive its key.
    const result = await def.testConnection({ ...parsed.data.credentials, __org_id: ctx.org.id });
    res.json(result);
  }),
);

providersRouter.get(
  "/catalogue",
  asyncHandler(async (_req, res) => {
    res.json({ items: platform().ai.listProviders() });
  }),
);

providersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_ai_providers")
      .select([
        "id",
        "provider_id",
        "label",
        "config",
        "enabled",
        "monthly_budget_cents",
        "created_at",
        "updated_at",
      ])
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: holds or mints credentials; the assistant must never handle these
providersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ProviderCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const def = platform().ai.getProvider(parsed.data.provider_id);
    if (!def) {
      res.status(400).json({
        error: {
          code: "unknown_provider",
          message: `No provider with id ${parsed.data.provider_id}`,
        },
      });
      return;
    }
    const ctx = tenantContext(req);
    const enc = await platform().integrations.encryptCredentials(
      ctx.org.id,
      parsed.data.credentials,
    );
    const db = tenantDb(req);
    // An ADDITIONAL provider arrives OFF. The column defaults to enabled, which
    // is right for the first one — a workspace connecting its only AI wants it
    // on — and wrong for the second: adding a provider to a workspace that
    // already has a working one silently repointed every AI call to the new,
    // unproven credentials. Nobody asked for that, and nothing said it had
    // happened. (Found the honest way, 2026-08-26: registering a benchmark
    // provider on a shared rig took over the AI of another session's run
    // mid-capture.) An explicit `enabled: true` in the request still wins, so
    // a caller that MEANS to switch can say so.
    const alreadyActive = await db
      .selectFrom("core_ai_providers")
      .select("id")
      .where("enabled", "=", true)
      .executeTakeFirst();
    const enabled = parsed.data.enabled ?? !alreadyActive;
    const row = await db
      .insertInto("core_ai_providers")
      .values({
        provider_id: parsed.data.provider_id,
        label: parsed.data.label,
        enabled,
        credentials_enc: enc,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
        monthly_budget_cents: parsed.data.monthly_budget_cents ?? null,
      })
      .returning([
        "id",
        "provider_id",
        "label",
        "config",
        "enabled",
        "monthly_budget_cents",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-ai.provider.created", {
      orgId: ctx.org.id,
      providerId: row.provider_id,
      rowId: row.id,
    });
    res.status(201).json(row);
  }),
);

// AI-REACH: holds or mints credentials; the assistant must never handle these
providersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ProviderUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.label !== undefined) set.label = parsed.data.label;
    if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
    if (parsed.data.config !== undefined) {
      set.config = sql`${JSON.stringify(parsed.data.config)}::jsonb` as never;
    }
    if (parsed.data.monthly_budget_cents !== undefined) {
      set.monthly_budget_cents = parsed.data.monthly_budget_cents;
    }
    if (parsed.data.credentials !== undefined) {
      set.credentials_enc = await platform().integrations.encryptCredentials(
        ctx.org.id,
        parsed.data.credentials,
      );
    }
    const row = await db
      .updateTable("core_ai_providers")
      .set(set as never)
      .where("id", "=", id)
      .returning([
        "id",
        "provider_id",
        "label",
        "config",
        "enabled",
        "monthly_budget_cents",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "provider not found" } });
      return;
    }
    void platform().events.emit("core-ai.provider.updated", {
      orgId: ctx.org.id,
      providerId: row.provider_id,
      rowId: row.id,
    });
    res.json(row);
  }),
);

// AI-REACH: holds or mints credentials; the assistant must never handle these
providersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_ai_providers")
      .where("id", "=", id)
      .returning(["id", "provider_id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "provider not found" } });
      return;
    }
    void platform().events.emit("core-ai.provider.deleted", {
      orgId: ctx.org.id,
      providerId: row.provider_id,
      rowId: row.id,
    });
    res.status(204).end();
  }),
);

// AI-REACH: holds or mints credentials; the assistant must never handle these
providersRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_ai_providers")
      .select(["provider_id", "credentials_enc"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "provider not found" } });
      return;
    }
    const def = platform().ai.getProvider(row.provider_id);
    if (!def?.testConnection) {
      res.json({ ok: true, note: "provider has no test implementation; assumed ok" });
      return;
    }
    const creds = await platform().integrations.decryptCredentials(
      ctx.org.id,
      row.credentials_enc,
    );
    // Inject the org so a bridge-transit provider can derive its channel key
    // (testConnection gets credentials only — no invoke ctx).
    const result = await def.testConnection({ ...creds, __org_id: ctx.org.id });
    res.json(result);
  }),
);
