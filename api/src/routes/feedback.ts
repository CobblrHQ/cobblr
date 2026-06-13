// User feedback about the platform itself (bugs / confusing things / ideas). Any
// authenticated user can submit from any workspace; super-admins triage it via
// /super-admin/feedback. Platform-level (cobblr_meta), cross-tenant.

import crypto from "node:crypto";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { announce } from "../platform/announce.js";
import { pokeTriage } from "../platform/triage-trigger.js";
import { verifyReplyToken } from "../platform/feedback-reply.js";

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

// Inbound router — NO requireAuth (the caller is the Cloudflare Email Worker,
// not a user). Authenticated by the shared COBBLR_INBOUND_EMAIL_SECRET header.
// Mounted separately in server.ts.
export const feedbackInboundRouter = Router();

const AppendEmail = z.object({
  // The reply+<token> local-part (a signed feedback id).
  token: z.string().min(1).max(200),
  // The reply's From address (anti-spoof: must equal the reporter's email).
  from_email: z.string().email().max(255),
  text: z.string().trim().max(10000).default(""),
});

// POST /feedback/append-email — a recipient replied to a feedback EMAIL. The
// Email Worker parses the reply+<token> address + the stripped body and posts
// here. We verify the shared secret, the signed token, and that the From matches
// the reporter, then append to their thread (reopen + re-triage) — the same
// conversation model as the in-app + Discord paths.
feedbackInboundRouter.post("/feedback/append-email", async (req, res, next) => {
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
    const parsed = AppendEmail.safeParse(req.body);
    if (!parsed.success || !parsed.data.text) {
      res.status(400).json({ error: { code: "empty", message: "Nothing to append." } });
      return;
    }
    const feedbackId = verifyReplyToken(parsed.data.token);
    if (!feedbackId) {
      res.status(400).json({ error: { code: "bad_token", message: "Invalid reply token." } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "status", "user_id"])
      .where("id", "=", feedbackId)
      .executeTakeFirst();
    if (!fb || !fb.user_id) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }
    const u = await meta.selectFrom("users").select(["email", "display_name"]).where("id", "=", fb.user_id).executeTakeFirst();
    if (!u?.email || u.email.toLowerCase() !== parsed.data.from_email.toLowerCase()) {
      res.status(403).json({ error: { code: "from_mismatch", message: "Reply From doesn't match the reporter." } });
      return;
    }
    const entry = { at: new Date().toISOString(), from: u.display_name ?? "reporter", text: parsed.data.text, role: "user" as const };
    const reopened = fb.status === "resolved" || fb.status === "wontfix";
    await meta
      .updateTable("feedback")
      .set({
        followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
        ...(reopened ? { status: "in_progress" as never } : {}),
        triaged_at: null,
      })
      .where("id", "=", fb.id)
      .execute();
    pokeTriage(fb.id);
    res.json({ ok: true, feedback_id: fb.id, reopened });
  } catch (err) {
    next(err);
  }
});

const SubmitFeedback = z.object({
  type: z.enum(["bug", "confusing", "idea", "other"]).default("bug"),
  message: z.string().trim().min(1).max(5000),
  // best-effort: the workspace slug the user was in → resolved to org_id
  workspace_slug: z.string().max(255).optional(),
  // auto-captured by the client: { url, route, userAgent, viewport, build, ... }
  context: z.record(z.unknown()).default({}),
  // Screenshots the client already uploaded to ITS workspace's core-files; we
  // store only the refs. Bytes are read back via platform().files.read under the
  // feedback's own org_id (resolved below), so a client can't reference another
  // org's file — a mismatched org_id simply reads null.
  attachments: z
    .array(
      z.object({
        file_id: z.string().uuid(),
        name: z.string().max(255).optional(),
        content_type: z.string().max(120).optional(),
      }),
    )
    .max(8)
    .default([]),
});

// POST /feedback — submit. user_id comes from the session (never the body);
// org_id is a best-effort lookup from the workspace slug.
feedbackRouter.post("/", async (req, res, next) => {
  try {
    const parsed = SubmitFeedback.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad feedback", details: parsed.error.issues },
      });
      return;
    }
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    let orgId: string | null = null;
    if (parsed.data.workspace_slug) {
      const org = await meta
        .selectFrom("orgs")
        .select("id")
        .where("slug", "=", parsed.data.workspace_slug)
        .executeTakeFirst();
      orgId = org?.id ?? null;
    }
    // Slug missing or STALE (e.g. a tab left open across a workspace rename, so
    // the URL slug no longer matches any org). Don't let that drop the report or
    // its screenshots — attribute to the authenticated user's own first
    // workspace; the slug is just a best-effort breadcrumb (kept in context).
    if (!orgId && userId) {
      const m = await meta
        .selectFrom("org_memberships")
        .select("org_id")
        .where("user_id", "=", userId)
        .orderBy("joined_at", "asc")
        .executeTakeFirst();
      orgId = m?.org_id ?? null;
    }
    // Attachments only make sense with a workspace (that's where the files live
    // + where org-scoped read resolves). Drop them only if the user has none.
    const attachments = orgId ? parsed.data.attachments : [];
    const row = await meta
      .insertInto("feedback")
      .values({
        user_id: userId!,
        org_id: orgId,
        type: parsed.data.type,
        message: parsed.data.message,
        context: sql`${JSON.stringify(parsed.data.context)}::jsonb`,
        attachments: sql`${JSON.stringify(attachments)}::jsonb`,
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();

    // Best-effort Discord ping on new feedback — fire-and-forget, never blocks
    // or fails the submission. Toggleable via the announce settings; the full
    // item lives in /super-admin → Feedback.
    const emoji =
      parsed.data.type === "bug" ? "🐛" : parsed.data.type === "confusing" ? "😕" : parsed.data.type === "idea" ? "💡" : "•";
    const route = typeof parsed.data.context.route === "string" ? parsed.data.context.route : "";
    void announce("feedback.new", {
      title: `${emoji} New ${parsed.data.type} feedback`,
      body: parsed.data.message.slice(0, 1500),
      color: 0xb5651d,
      fields: [
        ...(parsed.data.workspace_slug ? [{ name: "workspace", value: parsed.data.workspace_slug, inline: true }] : []),
        ...(route ? [{ name: "page", value: route, inline: true }] : []),
      ],
      // Show the reporter's screenshots inline in the Discord post (c53a6c4f).
      ...(orgId && attachments.length
        ? { images: attachments.map((a) => ({ orgId, fileId: a.file_id, name: a.name })) }
        : {}),
    });

    // Nudge the host-side triage analyzer so the item is judged within seconds
    // (it sweeps hourly as a backstop). Fire-and-forget; no-op if unconfigured.
    pokeTriage(row.id);

    res.status(201).json({ id: row.id, created_at: row.created_at });
  } catch (err) {
    next(err);
  }
});

// GET /feedback/mine — the signed-in user's OWN feedback items + their threads,
// so feedback is a two-way conversation rather than fire-and-forget. Returns
// user-facing fields only — NEVER the internal triage_* verdicts.
feedbackRouter.get("/mine", async (req, res, next) => {
  try {
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "Sign in." } });
      return;
    }
    const items = await meta
      .selectFrom("feedback")
      .select(["id", "type", "message", "status", "created_at", "updated_at", "followups", "attachments", "context"])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /feedback/:id/reply — the reporter replies to their OWN item (answering a
// clarifying question, adding detail). Appends to the thread (role:"user"),
// reopens a resolved item, and re-triages — mirroring the Discord #support
// follow-up path so both surfaces share one conversation model.
const ReplyBody = z.object({ text: z.string().trim().min(1).max(5000) });
feedbackRouter.post("/:id/reply", async (req, res, next) => {
  try {
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    const parsed = ReplyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Empty reply", details: parsed.error.issues } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "user_id", "status"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (!fb || fb.user_id !== userId) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }
    const u = await meta.selectFrom("users").select("display_name").where("id", "=", userId).executeTakeFirst();
    const entry = { at: new Date().toISOString(), from: u?.display_name ?? "you", text: parsed.data.text, role: "user" as const };
    const reopened = fb.status === "resolved" || fb.status === "wontfix";
    await meta
      .updateTable("feedback")
      .set({
        followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
        ...(reopened ? { status: "in_progress" as never } : {}),
        triaged_at: null, // re-judge with the new context
      })
      .where("id", "=", fb.id)
      .execute();
    pokeTriage(fb.id);
    res.json({ ok: true, reopened });
  } catch (err) {
    next(err);
  }
});
