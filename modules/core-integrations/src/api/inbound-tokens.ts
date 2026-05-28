// Inbound token CRUD. Each row gives one external sender a stable
// URL it can POST to. Tokens are mirrored into cobblr_meta's
// integration_inbound_token_lookup so the unauthenticated receiver
// can resolve (workspace, handler, token) in one query.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { randomBytes } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const inboundTokensRouter = Router({ mergeParams: true });

const TokenCreate = z.object({
  connector_id: z.string().min(1),
  label: z.string().min(1).max(120),
  config: z.record(z.unknown()).optional(),
});

function newSlug(): string {
  return randomBytes(24).toString("base64url");
}

inboundTokensRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = TokenCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const handler = platform().integrations.listInboundHandlers().find(
      (h) => h.id === parsed.data.connector_id,
    );
    if (!handler) {
      res.status(400).json({
        error: {
          code: "unknown_handler",
          message: `No inbound handler with id ${parsed.data.connector_id}`,
        },
      });
      return;
    }
    const token = newSlug();
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_integrations_inbound_tokens")
      .values({
        connector_id: parsed.data.connector_id,
        token,
        label: parsed.data.label,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
      })
      .returning(["id", "connector_id", "token", "label", "config", "enabled", "created_at"])
      .executeTakeFirstOrThrow();
    // Mirror into cobblr_meta lookup so the unauthenticated receiver
    // can resolve without scanning every tenant DB.
    const meta = platform().db.meta as unknown as {
      insertInto: (t: string) => {
        values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> };
      };
    };
    await meta
      .insertInto("integration_inbound_token_lookup")
      .values({
        token,
        org_id: ctx.org.id,
        inbound_id: row.id,
        connector_id: parsed.data.connector_id,
        enabled: true,
      })
      .execute();
    void platform().events.emit("core-integrations.inbound.token.created", {
      orgId: ctx.org.id,
      tokenId: row.id,
      connectorId: row.connector_id,
    });
    res.status(201).json(row);
  }),
);

inboundTokensRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // Rows include the token secret (selectAll) — owner/admin only,
    // never members/guests, matching the create/revoke/delete gates.
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const items = await db
      .selectFrom("core_integrations_inbound_tokens")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items });
  }),
);

inboundTokensRouter.post(
  "/:id/revoke",
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
      .updateTable("core_integrations_inbound_tokens")
      .set({ enabled: false })
      .where("id", "=", id)
      .returning(["id", "token", "connector_id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "token not found" } });
      return;
    }
    const meta = platform().db.meta as unknown as {
      updateTable: (t: string) => {
        set: (v: Record<string, unknown>) => {
          where: (col: string, op: string, val: unknown) => { execute: () => Promise<unknown> };
        };
      };
    };
    await meta
      .updateTable("integration_inbound_token_lookup")
      .set({ enabled: false })
      .where("token", "=", row.token)
      .execute();
    void platform().events.emit("core-integrations.inbound.token.revoked", {
      orgId: ctx.org.id,
      tokenId: id,
    });
    res.json(row);
  }),
);

inboundTokensRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_integrations_inbound_tokens")
      .where("id", "=", id)
      .returning(["id", "token"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "token not found" } });
      return;
    }
    const meta = platform().db.meta as unknown as {
      deleteFrom: (t: string) => {
        where: (col: string, op: string, val: unknown) => { execute: () => Promise<unknown> };
      };
    };
    await meta
      .deleteFrom("integration_inbound_token_lookup")
      .where("token", "=", row.token)
      .execute();
    res.status(204).end();
  }),
);

inboundTokensRouter.get(
  "/handlers",
  asyncHandler(async (_req, res) => {
    res.json({ items: platform().integrations.listInboundHandlers() });
  }),
);
