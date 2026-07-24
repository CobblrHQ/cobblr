// The ONE inbound-email dispatcher. Cloudflare Email Routing allows a single
// catch-all per zone, so every inbound message to cobblr.me arrives here through
// one thin Worker (scripts/email-workers/inbound-email/). The Worker is dumb
// Cloudflare glue — it parses the MIME and POSTs { to, from_email, text,
// attachments }; ALL the "what does this address mean" routing lives HERE, in
// the app, where it's versioned, tested, and typed:
//
//   reply+<token>@…   → feedback reply-by-email  → appendFeedbackReply()
//   anything else     → receipt ingest           → ingestReceiptEmail()
//
// Adding a future inbound feature (parts+, orders+, …) is a branch here + its
// handler — NOT a new Worker or a new catch-all. See
// docs/operations/email-inbound-capture.md.
//
// EVERY message is ARCHIVED (raw) before it is dispatched, so a message we
// couldn't handle is replayable from the backend rather than lost — a user
// sends an email once, and reprocessing our failures is our job, not theirs
// (see inbound-archive.ts + the reprocess routes below).

import { Router } from "express";
import { z } from "zod";
import { inboundSecretOk } from "../platform/inbound-secret.js";
import { isNoReplyAddress, replyTokenFrom } from "../platform/inbound-email-address.js";
import { stripQuoted } from "../platform/inbound-email-body.js";
import { ingestReceiptEmail } from "./receipt-ingest.js";
import { appendFeedbackReply } from "./feedback.js";
import {
  archiveInboundEmail,
  getInboundPayload,
  listReprocessable,
  recordInboundOutcome,
  type InboundPayload,
} from "../platform/inbound-archive.js";

export const inboundEmailRouter = Router();

const InboundEmail = z.object({
  /** Envelope recipient(s) — the local-part decides the feature. */
  to: z.union([z.string().max(400), z.array(z.string().max(400)).max(20)]).optional(),
  /** Sender address (anti-spoof for feedback; single-workspace fallback for receipts). */
  from_email: z.string().email().max(255).optional(),
  /** The FULL plain-text body (unstripped — quoting is trimmed server-side per
   *  address). Feedback replies + body-only / forwarded receipts. */
  text: z.string().max(20_000).default(""),
  /** The html body — a store receipt is often html-only. */
  html: z.string().max(400_000).default(""),
  /** The original Subject — quoted back + used for the reply's "Re: …". */
  subject: z.string().max(400).default(""),
  /** The original Message-ID — for threading the reply (In-Reply-To). */
  message_id: z.string().max(400).default(""),
  /** Receipt attachments. */
  attachments: z
    .array(
      z.object({
        filename: z.string().max(255).optional(),
        content_type: z.string().max(120).optional(),
        content_base64: z.string().min(1).max(40_000_000),
      }),
    )
    .max(20)
    .default([]),
});

interface DispatchResult {
  status: number;
  /** What we return to the caller (the Worker). */
  body: Record<string, unknown>;
  /** What we persist about how this attempt resolved. */
  record: { handler: string | null; org_id?: string | null; user_id?: string | null; outcome?: Record<string, unknown> | null };
}

/** Route a payload to its handler. Shared by the live POST and reprocess, so a
 *  replayed message runs the identical pipeline. */
async function dispatchInbound(payload: InboundPayload): Promise<DispatchResult> {
  const { to, from_email, text, html, subject, message_id, attachments } = payload;
  // A reply to one of OUR one-way notifications (receipt-noreply@ / noreply@) is
  // NOT an ingest — dropping it stops a "what is this?" reply becoming a junk
  // inbox item. Ingest is by FORWARDING to the receipts+ address, never by reply.
  if (isNoReplyAddress(to)) {
    return { status: 200, body: { ignored: true, reason: "noreply" }, record: { handler: null, outcome: { ignored: true, reason: "noreply" } } };
  }
  const replyToken = replyTokenFrom(to);
  if (replyToken) {
    // Feedback wants ONLY the reply the person typed — trim the quoted/forwarded
    // original here (the Worker no longer strips, so the receipt path keeps it).
    const out = await appendFeedbackReply({ token: replyToken, from_email: from_email ?? "", text: stripQuoted(text) });
    return { status: out.status, body: { handled: "feedback", ...out.body }, record: { handler: "feedback", outcome: out.body } };
  }
  const out = await ingestReceiptEmail({ to, from_email, text, html, subject, message_id, attachments: attachments ?? [] });
  return {
    status: out.status,
    body: { handled: "receipt", ...out.body },
    record: { handler: "receipt", org_id: out.orgId ?? null, user_id: out.userId ?? null, outcome: out.body },
  };
}

inboundEmailRouter.post("/inbound-email", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const parsed = InboundEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad payload", details: parsed.error.issues } });
      return;
    }
    const payload: InboundPayload = parsed.data;

    // Archive RAW before touching a handler — a crash or bug past this point
    // leaves the message replayable rather than gone.
    const archiveId = await archiveInboundEmail(payload);
    const result = await dispatchInbound(payload);
    if (archiveId) await recordInboundOutcome(archiveId, result.record);

    res.status(result.status).json(archiveId ? { archive_id: archiveId, ...result.body } : result.body);
  } catch (err) {
    next(err);
  }
});

// ── Operator reprocessing (secret-guarded, same auth as the ingest itself) ──
// "We failed to act on a message the user already sent" is our bug to fix and
// replay, not a reason to ask them to resend.

/** The work-list: archived messages that landed nothing yet. */
inboundEmailRouter.get("/inbound-email/reprocessable", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    res.json({ items: await listReprocessable() });
  } catch (err) {
    next(err);
  }
});

/** Replay one archived message through the current pipeline. */
inboundEmailRouter.post("/inbound-email/:id/reprocess", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const id = req.params.id;
    const payload = await getInboundPayload(id);
    if (!payload) {
      res.status(404).json({ error: { code: "not_found", message: "No archived inbound email with that id." } });
      return;
    }
    const result = await dispatchInbound(payload);
    await recordInboundOutcome(id, result.record);
    res.status(result.status).json({ reprocessed: id, ...result.body });
  } catch (err) {
    next(err);
  }
});
