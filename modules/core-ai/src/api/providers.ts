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
    const row = await db
      .insertInto("core_ai_providers")
      .values({
        provider_id: parsed.data.provider_id,
        label: parsed.data.label,
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
