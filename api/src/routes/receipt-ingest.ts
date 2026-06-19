// Receipt-by-email ingest — forward a receipt to your per-workspace address and
// its line items land in that workspace's scan inbox.
//
//   POST /receipt-ingest/email        unauth; the Cloudflare Email Worker
//                                     authenticates with COBBLR_INBOUND_EMAIL_SECRET.
//   GET  /orgs/:slug/receipt-address  authed; the caller's address for this
//                                     workspace (shown on the Scan page).
//
// The inbound route resolves the target (user, workspace) from the signed token
// in the To address (receipts+<token>@…) — see receipt-email.ts. It then writes
// each attachment via the files seam and REUSES the existing core-scan receipt
// route (POST /scan/receipt) through an internal call with a minted session
// token — so all the parse/tier/fan-out logic stays in core-scan, uncoupled.

import crypto from "node:crypto";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { signSession } from "../auth/jwt.js";
import {
  extractReceiptToken,
  mintReceiptAddress,
  receiptEmailConfigured,
  verifyReceiptToken,
} from "../platform/receipt-email.js";

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// Attachments worth trying to parse as a receipt. The Worker pre-filters too,
// but we re-check (defense against a misconfigured Worker).
const INGESTABLE_MIME = /^(application\/pdf|image\/|text\/csv|application\/vnd\.ms-excel|text\/plain|application\/octet-stream)/i;
const INGESTABLE_EXT = /\.(pdf|png|jpe?g|webp|heic|csv)$/i;
export function isIngestable(a: { filename?: string; content_type?: string }): boolean {
  if (a.content_type && INGESTABLE_MIME.test(a.content_type)) return true;
  if (a.filename && INGESTABLE_EXT.test(a.filename)) return true;
  return false;
}

const Attachment = z.object({
  filename: z.string().max(255).optional(),
  content_type: z.string().max(120).optional(),
  content_base64: z.string().min(1).max(40_000_000), // ~30 MB decoded ceiling
});
const IngestEmail = z.object({
  /** The receipts+<token> local-part, or the raw To header to parse it from. */
  token: z.string().max(120).optional(),
  to: z.union([z.string().max(400), z.array(z.string().max(400)).max(20)]).optional(),
  /** Sender — used only for the single-workspace bare-address fallback. */
  from_email: z.string().email().max(255).optional(),
  attachments: z.array(Attachment).max(20).default([]),
});

// ── unauth inbound (Cloudflare Email Worker → here) ─────────────────────────

export const receiptInboundRouter = Router();

receiptInboundRouter.post("/receipt-ingest/email", async (req, res, next) => {
  try {
    const secret = process.env.COBBLR_INBOUND_EMAIL_SECRET || "";
    const provided = String(req.headers["x-inbound-secret"] ?? "");
    if (
      !secret ||
      provided.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
    ) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const parsed = IngestEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad payload", details: parsed.error.issues } });
      return;
    }
    const { token, to, from_email, attachments } = parsed.data;

    // Resolve the target (user, workspace).
    let userId: string | null = null;
    let orgId: string | null = null;
    const tok = token ?? extractReceiptToken(to);
    if (tok) {
      const decoded = verifyReceiptToken(tok);
      if (!decoded) {
        res.status(200).json({ ignored: true, reason: "bad_token" });
        return;
      }
      userId = decoded.userId;
      orgId = decoded.orgId;
    } else if (from_email) {
      // Bare receipts@ with no token — only safe when the sender has exactly one
      // workspace (no ambiguity). Otherwise we can't know which workspace.
      const user = await meta
        .selectFrom("users")
        .select(["id"])
        .where(sql`lower(email)`, "=", from_email.toLowerCase())
        .executeTakeFirst();
      if (user) {
        const memberships = await meta
          .selectFrom("org_memberships")
          .select(["org_id"])
          .where("user_id", "=", user.id)
          .execute();
        if (memberships.length === 1) {
          userId = user.id;
          orgId = memberships[0]!.org_id;
        } else if (memberships.length > 1) {
          res.status(200).json({ ignored: true, reason: "ambiguous_workspace" });
          return;
        }
      }
    }
    if (!userId || !orgId) {
      res.status(200).json({ ignored: true, reason: "unresolved" });
      return;
    }

    // Confirm the user is (still) a member of that workspace, and get its slug.
    const membership = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select(["o.slug as slug"])
      .where("m.user_id", "=", userId)
      .where("m.org_id", "=", orgId)
      .executeTakeFirst();
    if (!membership) {
      res.status(200).json({ ignored: true, reason: "not_a_member" });
      return;
    }

    const ingestable = attachments.filter(isIngestable);
    if (ingestable.length === 0) {
      res.status(200).json({ ignored: true, reason: "no_receipt_attachment" });
      return;
    }

    // Write each attachment to core-files (server-side seam) + reuse core-scan's
    // receipt route via an internal call under a freshly minted session token.
    const sessionToken = await signSession(userId);
    const results: Array<Record<string, unknown>> = [];
    for (const a of ingestable) {
      try {
        const bytes = Buffer.from(a.content_base64, "base64");
        const written = await platform().files.write(orgId, new Uint8Array(bytes), {
          filename: a.filename,
          mimeType: a.content_type,
        });
        if (!written) {
          results.push({ filename: a.filename ?? null, error: "store_failed" });
          continue;
        }
        const r = await fetch(`${INTERNAL_API}/api/v1/orgs/${membership.slug}/modules/core-scan/scan/receipt`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: written.fileId }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          receipt?: { item_count?: number; method?: string; vendor?: string | null };
          error?: { code?: string; message?: string };
        };
        results.push(
          r.ok
            ? {
                filename: a.filename ?? null,
                ok: true,
                item_count: body.receipt?.item_count ?? 0,
                method: body.receipt?.method ?? null,
                vendor: body.receipt?.vendor ?? null,
              }
            : { filename: a.filename ?? null, error: body.error?.code ?? `http_${r.status}`, message: body.error?.message },
        );
      } catch (err) {
        results.push({ filename: a.filename ?? null, error: "exception", message: (err as Error).message });
      }
    }
    res.status(200).json({ workspace: membership.slug, results });
  } catch (err) {
    next(err);
  }
});

// ── authed: the caller's forwarding address for a workspace ─────────────────

export const receiptAddressRouter = Router({ mergeParams: true });

receiptAddressRouter.get("/:slug/receipt-address", requireAuth, withTenant, (req, res) => {
  const userId = (req as unknown as { session?: { id: string } }).session?.id;
  const orgId = (req as unknown as { tenant?: { org: { id: string } } }).tenant?.org.id;
  if (!userId || !orgId) {
    res.status(401).json({ error: { code: "no_auth", message: "Auth required." } });
    return;
  }
  res.json({ configured: receiptEmailConfigured(), address: mintReceiptAddress(userId, orgId) });
});
