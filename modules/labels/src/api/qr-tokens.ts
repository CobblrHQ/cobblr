// QR token CRUD + PNG render (merged in from the former core-labels-qr
// module). Token rows live in cobblr_meta so the unauthenticated /qr/:token
// scan route can resolve them in one query — see api/src/routes/qr-scan.ts.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { randomBytes } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import QRCode from "qrcode";
import { tenantContext } from "../db.js";
import { qrTenantDb, getQrTokenStyle, getQrLabelBaseUrl, qrScanUrl, qrShortcode } from "./qr-db.js";
import type { Request } from "express";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const qrTokensRouter = Router({ mergeParams: true });

/** The origin a freshly-minted / rendered QR should encode, in priority order:
 *  1. the workspace's custom label base URL (stable name it forwards to us),
 *  2. the x-cobblr-base-url header (isolated-stack e2e only),
 *  3. the incoming request's own protocol + Host.
 *  The `/qr/<token>` path is appended by qrScanUrl(). */
async function effectiveBase(req: Request): Promise<string> {
  const stored = await getQrLabelBaseUrl(qrTenantDb(req));
  if (stored) return stored;
  const header = req.headers["x-cobblr-base-url"] as string | undefined;
  if (header) return header.replace(/\/+$/, "");
  return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

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

// One slug length for everything: 12 chars (~72 bits). Unguessable enough for a
// public bearer token (anyone with the URL can open it, so it must resist
// enumeration) and trivially unique for a session one, so length is a constant,
// not a knob. The unique constraint + retry-on-collision below cover the rare
// duplicate. The only real toggle is descriptive-vs-opaque (readability).
function slug(): string {
  return randomBytes(9).toString("base64url"); // 12 chars
}
function isDupKey(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === "23505" || /duplicate key|unique constraint/i.test(err.message ?? "");
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

qrTokensRouter.post(
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
    // Style decides the token form: descriptive = "/qr/<kind>/<id>"
    // (self-describing, the workspace default); opaque = "/qr/<random>".
    //
    // Descriptive applies ONLY to a plain, permanent navigate label — the URL
    // /qr/<kind>/<id> *is* the entity, so it's one-per-entity and forever. An
    // action trigger or an expiring token needs a distinct, disposable token,
    // so those stay opaque even under the descriptive default — otherwise a
    // second mint for the same entity would collide with (and reuse) its nav
    // token, silently dropping the new mode/expiry.
    const style = await getQrTokenStyle(qrTenantDb(req));
    // Descriptive (readable "<code>/<slug>") is for a plain, permanent navigate
    // label AND session auth only: a public label must not leak its kind, and an
    // action / expiring token needs a distinct disposable token. Everything else
    // is opaque (a bare slug).
    const isDescriptive =
      style === "descriptive" &&
      parsed.data.mode === "navigate" &&
      !parsed.data.expires_in_days &&
      parsed.data.auth === "session";
    const meta = platform().db.meta as unknown as {
      insertInto: (table: string) => unknown;
      selectFrom: (table: string) => unknown;
    };
    // Resolve the base once so every response (reuse or fresh) carries a
    // ready-to-print scan_url — clients never guess the origin.
    const base = await effectiveBase(req);
    // A descriptive nav token is one-per-entity: reuse an existing (unrevoked)
    // one so a reprint keeps the already-printed URL. Query by entity (the slug
    // is random now, not computable from the entity).
    if (isDescriptive) {
      const sel = meta.selectFrom("core_labels_qr_tokens") as unknown as { selectAll: () => unknown };
      let q = sel.selectAll() as unknown as {
        where: (col: string, op: string, val: unknown) => unknown;
      };
      q = q.where("org_id", "=", ctx.org.id) as typeof q;
      q = q.where("entity_kind", "=", parsed.data.entity_kind) as typeof q;
      q = q.where("entity_id", "=", parsed.data.entity_id) as typeof q;
      q = q.where("mode", "=", "navigate") as typeof q;
      const existing = (await (q as unknown as {
        executeTakeFirst: () => Promise<MetaQrToken | undefined>;
      }).executeTakeFirst()) as MetaQrToken | undefined;
      if (existing && !existing.revoked_at) {
        res.status(200).json({ ...existing, scan_url: qrScanUrl(base, existing.token) });
        return;
      }
    }
    const expiresAt = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : null;
    const mkToken = () =>
      isDescriptive ? `${qrShortcode(parsed.data.entity_kind)}/${slug()}` : slug();
    const insertToken = (token: string) =>
      (meta.insertInto("core_labels_qr_tokens") as unknown as {
        values: (v: Record<string, unknown>) => {
          returningAll: () => { executeTakeFirstOrThrow: () => Promise<MetaQrToken> };
        };
      })
        .values({
          token,
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
        .executeTakeFirstOrThrow();
    let row: MetaQrToken | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        row = (await insertToken(mkToken())) as MetaQrToken;
        break;
      } catch (e) {
        if (isDupKey(e) && attempt < 4) continue; // slug collided on unique(token) — try a new one
        throw e;
      }
    }
    if (!row) throw new Error("could not mint a unique QR token");
    void platform().events.emit("labels.qr.token.created", {
      orgId: ctx.org.id,
      tokenId: row.id,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
    });
    res.status(201).json({ ...row, scan_url: qrScanUrl(base, row.token) });
  }),
);

qrTokensRouter.get(
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
    const base = await effectiveBase(req);
    res.json({ items: items.map((t) => ({ ...t, scan_url: qrScanUrl(base, t.token) })) });
  }),
);

qrTokensRouter.post(
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
    void platform().events.emit("labels.qr.token.revoked", {
      orgId: ctx.org.id,
      tokenId: id,
    });
    res.json(updated);
  }),
);

// PNG render — useful for the print path to embed the QR image
// directly in a label. Resolves a token id to its `token` slug, then
// renders.
qrTokensRouter.get(
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
    const url = qrScanUrl(await effectiveBase(req), row.token);
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
