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

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { signSession } from "../auth/jwt.js";
import { inboundSecretOk } from "../platform/inbound-secret.js";
import { notifyAccount } from "../platform/notifications.js";
import { absoluteAppUrl } from "../platform/public-url.js";
import { planBodyCapture } from "../platform/receipt-body.js";
import { bestReceiptBody, receiptReplyHeaders } from "../platform/inbound-email-body.js";
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
  /** Plain-text body — a forwarded receipt EMAIL (no file attached) is captured
   *  from this so it never silently vanishes. */
  text: z.string().max(20_000).optional(),
  attachments: z.array(Attachment).max(20).default([]),
});

// ── unauth inbound (Cloudflare Email Worker → here) ─────────────────────────

export interface ReceiptEmailInput {
  /** The receipts+<token> local-part, or the raw To header to parse it from. */
  token?: string;
  to?: string | string[];
  /** Sender — used only for the single-workspace bare-address fallback. */
  from_email?: string;
  /** Plain-text body — captured as a receipt/note when no file is attached. */
  text?: string;
  /** Html body — read when the plain part is thin (store receipts are often html). */
  html?: string;
  /** Original Subject — quoted back in the reply + used for "Re: …". */
  subject?: string;
  /** Original Message-ID — reserved for threading the reply (Phase 2). */
  message_id?: string;
  attachments: Array<{ filename?: string; content_type?: string; content_base64: string }>;
}

/** Core of receipt-by-email: resolve (user, workspace) from the token/sender,
 *  write each receipt attachment via the files seam, and reuse core-scan's
 *  /scan/receipt route per file. Pure of req/res so BOTH the standalone
 *  /receipt-ingest/email route AND the /inbound-email dispatcher can call it.
 *  Never throws for a routing miss — returns a 200 { ignored, reason } so a
 *  stray email doesn't bounce. */
export async function ingestReceiptEmail(
  input: ReceiptEmailInput,
): Promise<{ status: number; body: Record<string, unknown>; orgId?: string; userId?: string }> {
  const { token, to, from_email, text, html, subject, message_id, attachments } = input;
  // A forwarded store receipt often has its content in html (or a full,
  // unstripped plain body). Pick whichever carries more text for body capture.
  const bodyText = bestReceiptBody(text, html);

  // Resolve the target (user, workspace).
  let userId: string | null = null;
  let orgId: string | null = null;
  const tok = token ?? extractReceiptToken(to);
  if (tok) {
    const decoded = verifyReceiptToken(tok);
    if (!decoded) return { status: 200, body: { ignored: true, reason: "bad_token" } };
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
        return { status: 200, body: { ignored: true, reason: "ambiguous_workspace" } };
      }
    }
  }
  if (!userId || !orgId) return { status: 200, body: { ignored: true, reason: "unresolved" } };

  // Confirm the user is (still) a member of that workspace, and get its slug.
  const membership = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.slug as slug"])
    .where("m.user_id", "=", userId)
    .where("m.org_id", "=", orgId)
    .executeTakeFirst();
  if (!membership) return { status: 200, body: { ignored: true, reason: "not_a_member" } };

  const slug = membership.slug;
  const scanUrl = absoluteAppUrl(`/w/${slug}/scan`);
  const sessionToken = await signSession(userId);
  const post = (path: string, payload: Record<string, unknown>) =>
    fetch(`${INTERNAL_API}/api/v1/orgs/${slug}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  const results: Array<Record<string, unknown>> = [];
  // parsedCount = real receipt LINE ITEMS (attachments + body parse). noteCreated
  // = the never-vanish single-note fallback fired (the receipt couldn't be parsed
  // into lines — e.g. no AI). Kept apart so the reply doesn't call a whole receipt
  // saved as one note "1 item".
  let parsedCount = 0;
  let noteCreated = false;

  // 1. File attachments → core-files → core-scan's receipt parser (one row per
  //    line item). Written via the server-side seam (system capture, not a user
  //    upload).
  for (const a of attachments.filter(isIngestable)) {
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
      const r = await post(`/modules/core-scan/scan/receipt`, { file_id: written.fileId, origin: "email" });
      const body = (await r.json().catch(() => ({}))) as {
        receipt?: { item_count?: number; method?: string; vendor?: string | null };
        error?: { code?: string; message?: string };
      };
      if (r.ok) parsedCount += body.receipt?.item_count ?? 0;
      results.push(
        r.ok
          ? { filename: a.filename ?? null, ok: true, item_count: body.receipt?.item_count ?? 0, method: body.receipt?.method ?? null, vendor: body.receipt?.vendor ?? null }
          : { filename: a.filename ?? null, error: body.error?.code ?? `http_${r.status}`, message: body.error?.message },
      );
    } catch (err) {
      results.push({ filename: a.filename ?? null, error: "exception", message: (err as Error).message });
    }
  }

  // 2. NEVER-VANISH body fallback: a forwarded receipt EMAIL (no file attached)
  //    carries its line items in the body. When the attachments produced nothing,
  //    run the body through the RECEIPT PARSER (its AI tier extracts one row per
  //    line item from any receipt-shaped text — a forwarded order confirmation
  //    included). Only if the parser finds nothing do we capture a single NOTE, so
  //    the email always lands SOMETHING and a real multi-line receipt is never
  //    flattened into one useless item.
  const body = bodyText.trim();
  if (parsedCount === 0 && planBodyCapture(body) === "receipt") {
    try {
      const written = await platform().files.write(orgId, new TextEncoder().encode(body), {
        filename: "emailed-receipt.txt",
        mimeType: "text/plain",
      });
      if (written) {
        const r = await post(`/modules/core-scan/scan/receipt`, { file_id: written.fileId, origin: "email" });
        const rb = (await r.json().catch(() => ({}))) as { receipt?: { item_count?: number } };
        if (r.ok) {
          parsedCount += rb.receipt?.item_count ?? 0;
          results.push({ source: "body", ok: true, item_count: rb.receipt?.item_count ?? 0 });
        }
      }
    } catch (err) {
      results.push({ source: "body", error: "exception", message: (err as Error).message });
    }
    if (parsedCount === 0) {
      // The parser found nothing usable (e.g. a real receipt but no AI to split it)
      // — capture the whole body as one note item so it never silently disappears.
      const r = await post(`/modules/core-scan/scan/note`, { text: body.slice(0, 2000) });
      if (r.ok) {
        noteCreated = true;
        results.push({ source: "body-note", ok: true });
      }
    }
  }

  // 3. Reply to the sender about THEIR email — BRIEF, and honest about what
  //    actually happened. It comes FROM the `receipts+<token>@` address they
  //    emailed and threads under their original (Reply-To = that address, so a
  //    reply-with-attachment loops back in). Three cases, so a whole receipt saved
  //    as ONE note is never miscounted as "1 item":
  //      parsedCount > 0 → the accurate line-item count
  //      noteCreated     → "we've got your receipt" (no count; the UI flags that
  //                        it wasn't split — the email stays short)
  //      neither         → "couldn't find a receipt"
  //    Goes to the resolved account (in-app + their registered email), never the
  //    raw sender, so no backscatter.
  const subj = (subject ?? "").trim();
  const reSubject = (base: string) => (subj ? `Re: ${subj}` : base);
  const replyHeaders = receiptReplyHeaders(mintReceiptAddress(userId, orgId), message_id);

  if (parsedCount > 0) {
    await notifyAccount({
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.imported",
      message: `Imported ${parsedCount} item${parsedCount === 1 ? "" : "s"} from your emailed receipt${subj ? ` "${subj}"` : ""} into your scan inbox.`,
      link_url: scanUrl,
      email: {
        subject: reSubject("Your emailed receipt is in your scan inbox"),
        text: `We captured ${parsedCount} item${parsedCount === 1 ? "" : "s"} from your receipt. Review them in your scan inbox:\n${scanUrl}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else if (noteCreated) {
    await notifyAccount({
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.received",
      message: "We've got your emailed receipt — see it in your scan inbox.",
      link_url: scanUrl,
      email: {
        subject: reSubject("We've got your receipt"),
        text: `We've got your receipt — see it in your scan inbox:\n${scanUrl}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  } else {
    await notifyAccount({
      userId,
      representativeOrgId: orgId,
      notificationType: "core-scan.email.no_receipt",
      message: "We got your email but couldn't find a receipt to import. Reply with the receipt as a PDF or photo, or forward the store's receipt email.",
      link_url: scanUrl,
      email: {
        subject: reSubject("We couldn't find a receipt in your email"),
        text: `We got your email but couldn't find a receipt to import. Reply with the receipt as a PDF or photo, or forward the store's receipt email:\n${scanUrl}`,
        ...replyHeaders,
      },
    }).catch(() => {});
  }

  return {
    status: 200,
    body: { workspace: slug, item_count: parsedCount, note: noteCreated, results },
    orgId,
    userId,
  };
}

export const receiptInboundRouter = Router();

receiptInboundRouter.post("/receipt-ingest/email", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const parsed = IngestEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad payload", details: parsed.error.issues } });
      return;
    }
    const out = await ingestReceiptEmail(parsed.data);
    res.status(out.status).json(out.body);
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
