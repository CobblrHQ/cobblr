// User feedback about the platform itself (bugs / confusing things / ideas). Any
// authenticated user can submit from any workspace; super-admins triage it via
// /super-admin/feedback. Platform-level (cobblr_meta), cross-tenant.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { announce } from "../platform/announce.js";
import { pokeTriage } from "../platform/triage-trigger.js";

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

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
    // Attachments only make sense with a workspace (that's where the files live
    // + where org-scoped read resolves). Drop them if we couldn't resolve one.
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
    });

    // Nudge the host-side triage analyzer so the item is judged within seconds
    // (it sweeps hourly as a backstop). Fire-and-forget; no-op if unconfigured.
    pokeTriage(row.id);

    res.status(201).json({ id: row.id, created_at: row.created_at });
  } catch (err) {
    next(err);
  }
});
