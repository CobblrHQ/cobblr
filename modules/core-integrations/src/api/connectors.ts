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

export const connectorsRouter = Router({ mergeParams: true });

const ConnectorCreate = z.object({
  connector_id: z.string().min(1),
  label: z.string().min(1).max(120),
  credentials: z.record(z.unknown()),
  config: z.record(z.unknown()).optional(),
});

const ConnectorUpdate = z.object({
  label: z.string().min(1).max(120).optional(),
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const InvokeBody = z.object({
  action_id: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  rendered: z.string().optional(),
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

// AI-REACH: creates a connector, which holds credentials; the assistant must never handle these
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

// AI-REACH: edits a connector's stored config, which can carry credentials
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

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
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

// AI-REACH: drives a device or a preview surface, or is an operator/self-test probe
connectorsRouter.post(
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

// AI-REACH: invokes an external connector with the workspace's credentials; a person owns that call
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
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_integrations_connectors")
      .select(["connector_id", "credentials_enc", "enabled"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "connector not found" } });
      return;
    }
    if (!row.enabled) {
      res.status(409).json({ error: { code: "disabled", message: "connector is disabled" } });
      return;
    }
    const def = platform().integrations.getConnector(row.connector_id);
    if (!def) {
      res.status(400).json({
        error: { code: "unknown_connector", message: `Connector ${row.connector_id} not registered` },
      });
      return;
    }
    const creds = await platform().integrations.decryptCredentials(
      ctx.org.id,
      row.credentials_enc,
    );
    const start = Date.now();
    let ok = false;
    let status: number | null = null;
    let errorMsg: string | null = null;
    let result: unknown = null;
    try {
      result = await platform().integrations.invokeConnector(
        row.connector_id,
        {
          orgId: ctx.org.id,
          rowId: id,
          credentials: creds,
          args: parsed.data.args ?? {},
          rendered: parsed.data.rendered,
        },
        parsed.data.action_id,
      );
      ok = true;
      const maybeStatus = (result as { status?: number } | null)?.status;
      if (typeof maybeStatus === "number") status = maybeStatus;
    } catch (err) {
      errorMsg = (err as Error).message;
    }
    const ms = Date.now() - start;
    try {
      await db
        .insertInto("core_integrations_calls")
        .values({
          direction: "outbound",
          connector_id: row.connector_id,
          action_or_event: parsed.data.action_id,
          status,
          ok,
          error: errorMsg,
          request_meta: sql`${JSON.stringify({ args: parsed.data.args ?? {} })}::jsonb` as never,
          ms,
        })
        .execute();
    } catch (err) {
      console.error("[core-integrations] audit write failed:", err);
    }
    void platform().events.emit(
      ok ? "core-integrations.connector.invoked" : "core-integrations.connector.failed",
      {
        orgId: ctx.org.id,
        rowId: id,
        connectorId: row.connector_id,
        actionId: parsed.data.action_id,
        ms,
        error: errorMsg,
      },
    );
    if (!ok) {
      res.status(502).json({
        error: { code: "connector_failed", message: errorMsg ?? "connector error" },
      });
      return;
    }
    res.json({ ok: true, ms, result });
  }),
);
