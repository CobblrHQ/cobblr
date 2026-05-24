// QR token CRUD + PNG render. Token rows live in cobblr_meta so
// the unauthenticated /qr/:token scan route can resolve them in
// one query — see api/src/routes/qr-scan.ts for the resolver.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { randomBytes } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import QRCode from "qrcode";
import { tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const tokensRouter = Router({ mergeParams: true });

const TokenCreate = z.object({
  entity_kind: z.string().min(1),
  entity_id: z.string().uuid(),
  mode: z.enum(["navigate", "action"]).default("navigate"),
  action_id: z.string().optional(),
  auth: z.enum(["public", "session"]).default("session"),
  config: z.record(z.unknown()).optional(),
  /** Days until expiry; null = never. */
  expires_in_days: z.number().int().positive().nullable().optional(),
});

function newSlug(): string {
  // 24-char URL-safe random — collision-proof for any reasonable
  // workspace scale + short enough for a 200x200 QR with Q-level EC.
  return randomBytes(18).toString("base64url");
}

interface MetaQrToken {
  id: string;
  token: string;
  org_id: string;
  entity_kind: string;
  entity_id: string;
  mode: "navigate" | "action";
  action_id: string | null;
  auth: "public" | "session";
  config: Record<string, unknown>;
  created_at: Date;
  revoked_at: Date | null;
  expires_at: Date | null;
}

tokensRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = TokenCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (parsed.data.mode === "action" && !parsed.data.action_id) {
      res.status(400).json({
        error: {
          code: "missing_action_id",
          message: "action mode requires an action_id",
        },
      });
      return;
    }
    const ctx = tenantContext(req);
    const slug = newSlug();
    const meta = (platform().db.meta as unknown as { insertInto: (table: string) => unknown });
    const expiresAt = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : null;
    const row = (await (meta.insertInto("core_labels_qr_tokens") as unknown as {
      values: (v: Record<string, unknown>) => {
        returningAll: () => { executeTakeFirstOrThrow: () => Promise<MetaQrToken> };
      };
    })
      .values({
        token: slug,
        org_id: ctx.org.id,
        entity_kind: parsed.data.entity_kind,
        entity_id: parsed.data.entity_id,
        mode: parsed.data.mode,
        action_id: parsed.data.action_id ?? null,
        auth: parsed.data.auth,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as MetaQrToken;
    void platform().events.emit("core-labels-qr.token.created", {
      orgId: ctx.org.id,
      tokenId: row.id,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
    });
    res.status(201).json(row);
  }),
);

tokensRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const entityKind = typeof req.query.entity_kind === "string" ? req.query.entity_kind : undefined;
    const entityId = typeof req.query.entity_id === "string" ? req.query.entity_id : undefined;
    const meta = platform().db.meta as unknown as {
      selectFrom: (table: string) => {
        selectAll: () => {
          where: (col: string, op: string, val: unknown) => unknown;
        };
      };
    };
    let q = (meta.selectFrom("core_labels_qr_tokens").selectAll() as unknown as {
      where: (col: string, op: string, val: unknown) => unknown;
    });
    q = (q.where("org_id", "=", ctx.org.id) as unknown as typeof q);
    if (entityKind) q = (q.where("entity_kind", "=", entityKind) as unknown as typeof q);
    if (entityId) q = (q.where("entity_id", "=", entityId) as unknown as typeof q);
    const items = await (q as unknown as {
      orderBy: (col: string, dir: "asc" | "desc") => { execute: () => Promise<MetaQrToken[]> };
    })
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items });
  }),
);

tokensRouter.post(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const meta = platform().db.meta as unknown as {
      updateTable: (table: string) => {
        set: (v: Record<string, unknown>) => {
          where: (col: string, op: string, val: unknown) => {
            where: (col: string, op: string, val: unknown) => {
              returningAll: () => { executeTakeFirst: () => Promise<MetaQrToken | undefined> };
            };
          };
        };
      };
    };
    const updated = await meta
      .updateTable("core_labels_qr_tokens")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("org_id", "=", ctx.org.id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "token not found" } });
      return;
    }
    void platform().events.emit("core-labels-qr.token.revoked", {
      orgId: ctx.org.id,
      tokenId: id,
    });
    res.json(updated);
  }),
);

// PNG render — useful for the print path to embed the QR image
// directly in a label. Resolves a token id to its `token` slug, then
// renders.
tokensRouter.get(
  "/:id/png",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const meta = platform().db.meta as unknown as {
      selectFrom: (table: string) => {
        select: (cols: string[]) => {
          where: (col: string, op: string, val: unknown) => {
            where: (col: string, op: string, val: unknown) => {
              executeTakeFirst: () => Promise<{ token: string } | undefined>;
            };
          };
        };
      };
    };
    const row = await meta
      .selectFrom("core_labels_qr_tokens")
      .select(["token"])
      .where("id", "=", id)
      .where("org_id", "=", ctx.org.id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "token not found" } });
      return;
    }
    const base = (req.headers["x-cobblr-base-url"] as string | undefined) ??
      `${req.protocol}://${req.headers.host ?? "localhost"}`;
    const url = `${base}/qr/${row.token}`;
    const png = await QRCode.toBuffer(url, {
      errorCorrectionLevel: "Q",
      margin: 2,
      width: 256,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(png);
  }),
);
