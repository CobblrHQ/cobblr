// User feedback about the platform itself (bugs / confusing things / ideas). Any
// authenticated user can submit from any workspace; super-admins triage it via
// /super-admin/feedback. Platform-level (cobblr_meta), cross-tenant.

import { productName } from "../platform/product-name.js";
import { Router, type RequestHandler } from "express";
import { decodeKeysetCursor, encodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { withTenant } from "../middleware/tenant.js";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { postFeedbackCard } from "./feedback-card-post.js";
import { reportingOrgId } from "../platform/feedback-org.js";
import { feedbackReachability } from "../platform/feedback-reachability.js";
import { reporterCardFields } from "../platform/feedback-card.js";
import { pokeTriage } from "../platform/triage-trigger.js";
import { notifyOperators } from "../platform/operator-alert.js";
import { verifyReplyToken } from "../platform/feedback-reply.js";
import { inboundSecretOk } from "../platform/inbound-secret.js";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

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

/** Core of feedback-reply-by-email: verify the signed reply token + the From
 *  matches the reporter, then append the reply to their thread (reopen +
 *  re-triage) — the same conversation model as the in-app + Discord paths. Pure
 *  of req/res so BOTH the standalone /feedback/append-email route AND the
 *  /inbound-email dispatcher can call it. */
export async function appendFeedbackReply(input: {
  token: string;
  from_email: string;
  text: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = AppendEmail.safeParse(input);
  if (!parsed.success || !parsed.data.text) {
    return { status: 400, body: { error: { code: "empty", message: "Nothing to append." } } };
  }
  const feedbackId = verifyReplyToken(parsed.data.token);
  if (!feedbackId) {
    return { status: 400, body: { error: { code: "bad_token", message: "Invalid reply token." } } };
  }
  const fb = await meta
    .selectFrom("feedback")
    .select(["id", "status", "user_id"])
    .where("id", "=", feedbackId)
    .executeTakeFirst();
  if (!fb || !fb.user_id) {
    return { status: 404, body: { error: { code: "not_found", message: "Feedback not found." } } };
  }
  const u = await meta.selectFrom("users").select(["email", "display_name"]).where("id", "=", fb.user_id).executeTakeFirst();
  if (!u?.email || u.email.toLowerCase() !== parsed.data.from_email.toLowerCase()) {
    return { status: 403, body: { error: { code: "from_mismatch", message: "Reply From doesn't match the reporter." } } };
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
  return { status: 200, body: { ok: true, feedback_id: fb.id, reopened } };
}

// POST /feedback/append-email — a recipient replied to a feedback EMAIL. The
// Email Worker parses the reply+<token> address + the stripped body and posts
// here. We verify the shared secret, then hand off to appendFeedbackReply.
// UI-REACH: the email worker relaying a reply to a feedback email
feedbackInboundRouter.post("/feedback/append-email", async (req, res, next) => {
  try {
    if (!inboundSecretOk(req.headers["x-inbound-secret"])) {
      res.status(401).json({ error: { code: "unauthorized", message: "Bad inbound secret." } });
      return;
    }
    const parsed = AppendEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "empty", message: "Nothing to append." } });
      return;
    }
    const out = await appendFeedbackReply(parsed.data);
    res.status(out.status).json(out.body);
  } catch (err) {
    next(err);
  }
});

const SubmitFeedback = z.object({
  /** An address a sandbox visitor chose to leave ("Email me when this is
   *  fixed"). Giving it is the consent; it is recorded with the time. */
  contact_email: z.string().trim().email().max(254).optional(),
  type: z.enum(["bug", "confusing", "idea", "use_case", "other"]).default("bug"),
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
        error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues },
      });
      return;
    }
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    // The slug is a hint from the browser, so it counts only for a workspace
    // the reporter belongs to. Missing or STALE (a tab left open across a
    // rename) falls back to the reporter's own first workspace, so the report
    // and its screenshots are not dropped.
    const bySlug = parsed.data.workspace_slug
      ? await meta
          .selectFrom("orgs")
          .leftJoin("org_memberships as m", (j) => j.onRef("m.org_id", "=", "orgs.id").on("m.user_id", "=", userId ?? ""))
          .select(["orgs.id", "m.user_id as member"])
          .where("orgs.slug", "=", parsed.data.workspace_slug)
          .executeTakeFirst()
      : undefined;
    const firstOwn = userId
      ? (
          await meta
            .selectFrom("org_memberships")
            .select("org_id")
            .where("user_id", "=", userId)
            .orderBy("joined_at", "asc")
            .executeTakeFirst()
        )?.org_id ?? null
      : null;
    const orgId = reportingOrgId({ bySlug: bySlug ? { id: bySlug.id, isMember: !!bySlug.member } : null, firstOwn });
    // Attachments only make sense with a workspace (that's where the files live
    // + where org-scoped read resolves). Drop them only if the user has none.
    const attachments = orgId ? parsed.data.attachments : [];
    // Whether anyone can be reached about this, decided here (#4645): a
    // sandbox guest's address is undeliverable, so unless they left one on
    // purpose the item says so and no reply is promised.
    const filer = userId ? await meta.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst() : null;
    const reach = feedbackReachability({ email: filer?.email, contactEmail: parsed.data.contact_email });
    const row = await meta
      .insertInto("feedback")
      .values({
        user_id: userId!,
        org_id: orgId,
        type: parsed.data.type,
        message: parsed.data.message,
        context: sql`${JSON.stringify(parsed.data.context)}::jsonb`,
        attachments: sql`${JSON.stringify(attachments)}::jsonb`,
        reachable: reach.reachable,
        unreachable_reason: reach.unreachable_reason,
        contact_email: reach.contact_email,
        contact_consented_at: reach.contact_email ? new Date() : null,
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();

    // Best-effort Discord ping on new feedback — fire-and-forget, never blocks
    // or fails the submission. Toggleable via the announce settings; the full
    // item lives in /super-admin → Feedback.
    const emoji =
      parsed.data.type === "bug" ? "🐛" : parsed.data.type === "confusing" ? "😕" : parsed.data.type === "idea" ? "💡" : "•";
    const route = typeof parsed.data.context.route === "string" ? parsed.data.context.route : "";
    const cardFields = await reporterCardFields({ userId, orgId, route });
    // Fire-and-forget, but ask Discord to echo the created message so we can
    // remember WHICH post this item produced — the support bot reacts onto that
    // same message as the item is worked (🤖 grabbed → 👀 PR up → ✅ shipped).
    // Never blocks or fails the submission; a failed capture just means no
    // lifecycle reactions for this one item.
    // DETACHED: the Discord card for a filed report; the report is saved, and a boot pass posts cards that are missing
    void (async () => {
      try {
        const posted = await postFeedbackCard(row.id, {
          title: `${emoji} New ${parsed.data.type} feedback`,
          body: parsed.data.message.slice(0, 1500),
          color: 0xb5651d,
          fields: cardFields,
          // Show the reporter's screenshots inline in the Discord post (c53a6c4f).
          ...(orgId && attachments.length
            ? { images: attachments.map((a) => ({ orgId, fileId: a.file_id, name: a.name })) }
            : {}),
        });
        // Nothing was posted, so nobody has been told. On a public instance that is
        // deliberate — a stranger's report quotes their own data and must not land in
        // a chat server whose membership is not theirs to see — but the consequence is
        // an item sitting in a queue no one is watching. On any instance it also covers
        // an expired or broken webhook, which until now failed silently.
        if (!posted.delivered && !posted.skipped) {
          await notifyOperators({
            subject: `[${productName()}] New ${parsed.data.type} feedback`,
            text: [
              `Somebody submitted feedback on this ${productName()} instance.`,
              ``,
              `Type: ${parsed.data.type}`,
              route ? `Where: ${route}` : `Where: not recorded`,
              `Item: ${row.id}`,
              ``,
              parsed.data.message.slice(0, 800),
              // null, not "": the empty strings above are deliberate blank lines, and
              // filtering on emptiness would strip the paragraph breaks with it.
              parsed.data.message.length > 800 ? `… (truncated)` : null,
              ``,
              `Read and reply in Super admin -> Feedback. The reply reaches them the way`,
              `they chose: the in-app thread, a notification, or email.`,
            ]
              .filter((line) => line !== null)
              .join("\n"),
          });
        }
      } catch (err) {
        console.error("[feedback] announce/message-id capture failed:", err);
      }
    })();

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
const listMyFeedback: RequestHandler = async (req, res, next) => {
  try {
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "Sign in." } });
      return;
    }
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }).safeParse(req.query);
    const cursor = parsed.success ? decodeKeysetCursor(parsed.data.cursor) : null;
    if (!parsed.success || (parsed.data.cursor && (!cursor || !z.string().uuid().safeParse(cursor.id).success))) {
      res.status(400).json({ error: { code: "invalid_query", message: "Use the next cursor from your feedback list and a limit from 1 to 100." } });
      return;
    }
    const { limit } = parsed.data;
    let matching = meta.selectFrom("feedback").where("user_id", "=", userId);
    if (req.tenant) matching = matching.where("org_id", "=", req.tenant.org.id);
    let page = matching
      .select(["id", "type", "message", "status", "created_at", "updated_at", "followups", "attachments", "context"])
      .orderBy(sql`date_trunc('milliseconds', created_at)`, "desc")
      .orderBy("id", "desc");
    if (cursor) page = page.where(sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${cursor.at}, ${cursor.id}::uuid)`);
    const [rows, count] = await Promise.all([
      page.limit(limit + 1).execute(),
      matching.select(eb => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow(),
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    res.json({ items, total: Number(count.n), next_cursor: rows.length > limit && last ? encodeKeysetCursor(last.created_at, last.id) : null });
  } catch (err) {
    next(err);
  }
};
feedbackRouter.get("/mine", listMyFeedback);
export const feedbackOrgRouter = Router();
feedbackOrgRouter.get("/:slug/feedback/mine", requireAuth, withTenant, listMyFeedback);

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
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
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
