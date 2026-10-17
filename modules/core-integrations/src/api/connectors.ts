// /api/v1/orgs/:slug/modules/core-integrations/connectors —
// CRUD + invoke + test-connection.
//
// Credentials are encrypted at write time and decrypted only inside
// the platform's invoke path; this layer never returns plaintext.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { invokeSavedConnector } from "../invoke-saved.js";
import { optionalField } from "@cobblr/platform-contract/optional-fields";

export const connectorsRouter = Router({ mergeParams: true });

const ConnectorCreate = z.object({
  connector_id: z.string().min(1),
  label: z.string().min(1).max(120),
  credentials: z.record(z.unknown()),
  config: z.record(z.unknown()).optional(),
});

const ConnectorUpdate = z.object({
  label: z.string().min(1).max(120).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const InvokeBody = z.object({
  action_id: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  rendered: optionalField(z.string()),
});

// ──────────────────────────── catalogue ────────────────────────────

connectorsRouter.get(
  "/catalogue",
  asyncHandler(async (_req, res) => {
    res.json({ items: platform().integrations.listConnectors() });
  }),
);

// ────────────────────── recent call audit log ──────────────────────
//
// NB: must be declared before "/:id" routes so /calls isn't captured
// by the parameterised path.

connectorsRouter.get(
  "/calls",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const rows = await db
      .selectFrom("core_integrations_calls")
      .selectAll()
      .orderBy("occurred_at", "desc")
      .limit(limit)
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: exempt Send again repeats a failed call from the log; Cobb sends again by running the connector's service (core-integrations.<connector>.<action>) with the same arguments
connectorsRouter.post(
  "/calls/:callId/resend",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const call = await db.selectFrom("core_integrations_calls").selectAll().where("id", "=", req.params.callId!).executeTakeFirst();
    const meta = (call?.request_meta ?? {}) as { gave_up?: boolean; connection_id?: string; args?: Record<string, unknown>; rendered?: string | null; resent_at?: string };
    if (!call || call.direction !== "outbound" || !meta.gave_up || !meta.connection_id) {
      res.status(404).json({ error: { code: "not_found", message: "that send did not fail, or cannot be sent again" } });
      return;
    }
    const out = await invokeSavedConnector(db, tenantContext(req).org.id, meta.connection_id, call.action_or_event, meta.args ?? {}, meta.rendered ?? undefined);
    if (out.kind === "not_found" || out.kind === "disabled" || out.kind === "unknown_connector") {
      res.status(409).json({ error: { code: "connection_unavailable", message: "the connection it was sent through is gone or switched off" } });
      return;
    }
    await db
      .updateTable("core_integrations_calls")
      .set({ request_meta: sql`request_meta || ${JSON.stringify({ resent_at: new Date().toISOString() })}::jsonb` as never })
      .where("id", "=", call.id)
      .execute();
    if (out.kind === "queued") {
      res.status(202).json({ ok: true, queued: true, run_at: out.runAt.toISOString() });
      return;
    }
    if (!out.ok) {
      res.status(502).json({ error: { code: "connector_failed", message: out.error ?? "connector error" } });
      return;
    }
    res.json({ ok: true, ms: out.ms });
  }),
);

// ────────────────────────────── CRUD ───────────────────────────────

connectorsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_integrations_connectors")
      .select([
        "id",
        "connector_id",
        "label",
        "config",
        "enabled",
        "created_at",
        "updated_at",
      ])
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

// AI-REACH: exempt — takes an outside service's credentials (a Slack token, a
// webhook secret); the assistant never handles a secret
connectorsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectorCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const def = platform().integrations.getConnector(parsed.data.connector_id);
    if (!def) {
      res.status(400).json({
        error: {
          code: "unknown_connector",
          message: `No connector with id ${parsed.data.connector_id}`,
        },
      });
      return;
    }
    const enc = await platform().integrations.encryptCredentials(
      ctx.org.id,
      parsed.data.credentials,
    );
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_integrations_connectors")
      .values({
        connector_id: parsed.data.connector_id,
        label: parsed.data.label,
        credentials_enc: enc,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
      })
      .returning([
        "id",
        "connector_id",
        "label",
        "config",
        "enabled",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-integrations.connector.created", {
      orgId: ctx.org.id,
      rowId: row.id,
      connectorId: row.connector_id,
    });
    res.status(201).json(row);
  }),
);

// AI-REACH: exempt — replaces a connector's stored config, which carries its
// credentials and where they are sent; the assistant never handles a secret
connectorsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ConnectorUpdate.safeParse(req.body);
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
    if (parsed.data.credentials !== undefined) {
      set.credentials_enc = await platform().integrations.encryptCredentials(
        ctx.org.id,
        parsed.data.credentials,
      );
    }
    const row = await db
      .updateTable("core_integrations_connectors")
      .set(set as never)
      .where("id", "=", id)
      .returning([
        "id",
        "connector_id",
        "label",
        "config",
        "enabled",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "connector not found" } });
      return;
    }
    void platform().events.emit("core-integrations.connector.updated", {
      orgId: ctx.org.id,
      rowId: row.id,
      connectorId: row.connector_id,
    });
    res.json(row);
  }),
);

// AI-REACH: exempt — deletes a connector's credentials for good and stops every
// wire that sends through it; no undo can bring a secret back, so it is the owner's
connectorsRouter.delete(
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
      .deleteFrom("core_integrations_connectors")
      .where("id", "=", id)
      .returning(["id", "connector_id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "connector not found" } });
      return;
    }
    void platform().events.emit("core-integrations.connector.deleted", {
      orgId: ctx.org.id,
      rowId: row.id,
      connectorId: row.connector_id,
    });
    res.status(204).end();
  }),
);

// ────────────────────────── test-connection ────────────────────────

// AI-ACTION: core-integrations:test-connection
connectorsRouter.post(
  "/:id/test",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-integrations:test-connection"))) return;
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_integrations_connectors")
      .select(["connector_id", "credentials_enc"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "connector not found" } });
      return;
    }
    const def = platform().integrations.getConnector(row.connector_id);
    if (!def) {
      res.status(400).json({
        error: {
          code: "unknown_connector",
          message: `Connector ${row.connector_id} is not registered`,
        },
      });
      return;
    }
    if (!def.testConnection) {
      res.json({ ok: true, note: "no test implementation; assumed ok" });
      return;
    }
    const creds = await platform().integrations.decryptCredentials(
      ctx.org.id,
      row.credentials_enc,
    );
    const result = await def.testConnection(creds);
    res.json(result);
  }),
);

// ─────────────────────────────── invoke ────────────────────────────

// AI-TOOL: invoke_service
connectorsRouter.post(
  "/:id/invoke",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = InvokeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const out = await invokeSavedConnector(tenantDb(req), ctx.org.id, id, parsed.data.action_id, parsed.data.args ?? {}, parsed.data.rendered ?? undefined);
    if (out.kind === "not_found") {
      res.status(404).json({ error: { code: "not_found", message: "connector not found" } });
      return;
    }
    if (out.kind === "disabled") {
      res.status(409).json({ error: { code: "disabled", message: "connector is disabled" } });
      return;
    }
    if (out.kind === "unknown_connector") {
      res.status(400).json({
        error: { code: "unknown_connector", message: `Connector ${out.connectorId} not registered` },
      });
      return;
    }
    if (out.kind === "queued") {
      res.status(202).json({ ok: true, queued: true, run_at: out.runAt.toISOString(), because: out.because, error: out.error });
      return;
    }
    const { ok, ms, result, error: errorMsg } = out;
    if (!ok) {
      res.status(502).json({
        error: { code: "connector_failed", message: errorMsg ?? "connector error" },
      });
      return;
    }
    res.json({ ok: true, ms, result });
  }),
);
