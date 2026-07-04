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

import { Router } from "express";
import { z } from "zod";
import { inboundSecretOk } from "../platform/inbound-secret.js";
import { replyTokenFrom } from "../platform/inbound-email-address.js";
import { ingestReceiptEmail } from "./receipt-ingest.js";
import { appendFeedbackReply } from "./feedback.js";

export const inboundEmailRouter = Router();

const InboundEmail = z.object({
  /** Envelope recipient(s) — the local-part decides the feature. */
  to: z.union([z.string().max(400), z.array(z.string().max(400)).max(20)]).optional(),
  /** Sender address (anti-spoof for feedback; single-workspace fallback for receipts). */
  from_email: z.string().email().max(255).optional(),
  /** The stripped plain-text body (feedback replies). */
  text: z.string().max(20_000).default(""),
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
    const { to, from_email, text, attachments } = parsed.data;

    // reply+<token>@ → feedback; everything else → receipt ingest.
    const replyToken = replyTokenFrom(to);
    if (replyToken) {
      const out = await appendFeedbackReply({ token: replyToken, from_email: from_email ?? "", text });
      res.status(out.status).json({ handled: "feedback", ...out.body });
      return;
    }
    const out = await ingestReceiptEmail({ to, from_email, attachments });
    res.status(out.status).json({ handled: "receipt", ...out.body });
  } catch (err) {
    next(err);
  }
});
