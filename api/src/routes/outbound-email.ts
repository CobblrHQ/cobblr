// /orgs/:slug/outbound-email — the workspace's own outbound email (owner/admin):
// read what is set up, save a provider, remove it, send a test to yourself,
// and read the log of every send. See platform/outbound-email.ts.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import type { OrgRole } from "../db/schema.js";
import {
  deleteOutboundEmail,
  outboundEmailLog,
  outboundEmailStatus,
  saveOutboundEmail,
  sendFromWorkspace,
} from "../platform/outbound-email.js";
import { externalMessagesSettings, saveExternalMessagesSettings } from "../platform/external-messages.js";
import { beginGoogleConsent, googleOAuthConfigured } from "../platform/mail-source/google-oauth.js";
import { deleteOutboundSms, outboundSmsStatus, saveOutboundSms, sendTextFromWorkspace } from "../platform/outbound-sms.js";

export const outboundEmailRouter = Router({ mergeParams: true });

const ADMINISH: ReadonlyArray<OrgRole> = ["owner", "admin"];

function assertAdmin(req: import("express").Request, res: import("express").Response): boolean {
  // role-gate: exact — the address a workspace mails its customers from, and
  // the provider's keys, are governance, not action. An editor ranks with admin
  // for actions and must not inherit sending as the business.
  if (!ADMINISH.includes(req.tenant!.role as OrgRole)) {
    res.status(403).json({ error: { code: "forbidden", message: "Workspace owners/admins only." } });
    return false;
  }
  return true;
}

outboundEmailRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    res.json({ ...(await outboundEmailStatus(req.tenant!.org.id)), gmail_available: googleOAuthConfigured() });
  } catch (err) {
    next(err);
  }
});

const Save = z.record(z.unknown());
outboundEmailRouter.put("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const body = Save.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "Send the provider settings as an object." } });
    const r = await saveOutboundEmail(req.tenant!.org.id, req.session!.id, body.data);
    if (!r.ok) return void res.status(400).json({ error: { code: "incomplete", message: `Outbound email is not complete: ${r.reason}.` } });
    res.json(r.status);
  } catch (err) {
    next(err);
  }
});

outboundEmailRouter.delete("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    await deleteOutboundEmail(req.tenant!.org.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Send from a Gmail account (#6070, slice 3d): the consent screen, asking
// only to send. Google lands on the shared callback, which saves the sender.
// AI-REACH: exempt: a consent screen the account's owner clicks through in
// their own browser; an assistant cannot grant access to somebody's Gmail.
outboundEmailRouter.post("/gmail/start", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    if (!googleOAuthConfigured()) return void res.status(503).json({ error: { code: "not_configured", message: "Gmail isn't set up on this server yet." } });
    const { url } = await beginGoogleConsent(req.session!.id, req.tenant!.org.id, "send");
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/** Send a test to the person asking, so they see it arrive before a customer
 *  does. It goes through the same door and is logged like any other send. */
outboundEmailRouter.post("/test", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const me = await meta.selectFrom("users").select(["email"]).where("id", "=", req.session!.id).executeTakeFirst();
    if (!me?.email) return void res.status(400).json({ error: { code: "no_address", message: "Your account has no email address to send the test to." } });
    const r = await sendFromWorkspace(req.tenant!.org.id, {
      to: me.email,
      subject: "Test from Cobblr",
      text: `This is a test of ${req.tenant!.org.name}'s outbound email. If you can read it, emails to your customers will arrive the same way.`,
      sentBy: req.session!.id,
    });
    if (!r.ok) return void res.status(r.reason === "not_configured" ? 409 : 502).json({ error: { code: r.reason, message: r.message } });
    res.json({ ok: true, to: me.email, status: r.status });
  } catch (err) {
    next(err);
  }
});

outboundEmailRouter.get("/log", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const kind = typeof req.query.source_kind === "string" ? req.query.source_kind : null;
    const id = typeof req.query.source_id === "string" ? req.query.source_id : null;
    const rows = await outboundEmailLog(req.tenant!.org.id, kind && id ? { kind, id } : undefined);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        to: r.to_address,
        subject: r.subject,
        sent_by: r.sent_by,
        source_kind: r.source_kind,
        source_id: r.source_id,
        status: r.status,
        message_id: r.message_id,
        error: r.error,
        at: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── automations that message people outside the workspace (#6070) ─────────
// The owner's or an admin's yes, and the daily limits, for wires that email
// someone on the People list who is not a member. Off until turned on.

outboundEmailRouter.get("/automations", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const orgId = req.tenant!.org.id;
    const settings = await externalMessagesSettings(orgId);
    const recent = await meta
      .selectFrom("external_message_log")
      .select(["id", "channel", "to_address", "body", "status", "reason", "reply", "record_kind", "record_id", "binding_id", "created_at"])
      .where("org_id", "=", orgId)
      .orderBy("created_at", "desc")
      .limit(30)
      .execute();
    res.json({
      enabled: settings.enabled,
      daily_limit: settings.dailyLimit,
      per_wire_daily_limit: settings.perWireDailyLimit,
      // The reply link's token, when the message carried one: an admin already
      // sees it in the message's text.
      recent: recent.map((r) => ({ ...r, reply_token: /\/m\/reply\/(\S+)/.exec(r.body ?? "")?.[1] ?? null, created_at: r.created_at.toISOString() })),
    });
  } catch (err) {
    next(err);
  }
});

const AutomationSettings = z.object({
  enabled: z.boolean().optional(),
  daily_limit: z.number().int().min(1).max(500).optional(),
  per_wire_daily_limit: z.number().int().min(1).max(100).optional(),
});
// AI-REACH: exempt: letting automations email people outside the workspace is
// the owner's or an admin's own decision, made on this screen, never asked of
// the assistant (the owner's rule for #6070: opt-in, off by default).
outboundEmailRouter.put("/automations", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const body = AutomationSettings.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "enabled (yes or no) and the two daily limits (whole numbers)" } });
    const s = await saveExternalMessagesSettings(req.tenant!.org.id, req.session!.id, {
      enabled: body.data.enabled,
      dailyLimit: body.data.daily_limit,
      perWireDailyLimit: body.data.per_wire_daily_limit,
    });
    res.json({ enabled: s.enabled, daily_limit: s.dailyLimit, per_wire_daily_limit: s.perWireDailyLimit });
  } catch (err) {
    next(err);
  }
});

// ── the workspace's own text messages (#6070, slice 3c) ──────────────────
// Its Twilio account: how an automation texts someone outside the
// workspace. The SID shows again, the token never does.

outboundEmailRouter.get("/sms", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    res.json(await outboundSmsStatus(req.tenant!.org.id));
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt: the workspace's Twilio Account SID and Auth Token, a
// credential an owner or admin types on this screen; it never passes through chat.
outboundEmailRouter.put("/sms", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const body = Save.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "Send account_sid, auth_token and from_number." } });
    const r = await saveOutboundSms(req.tenant!.org.id, req.session!.id, body.data);
    if (!r.ok) return void res.status(400).json({ error: { code: "incomplete", message: `Text messages are not set up: ${r.reason}.` } });
    res.json(r.status);
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt: removing the workspace's Twilio credential is the owner's
// or an admin's own step on this screen, like setting it.
outboundEmailRouter.delete("/sms", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    await deleteOutboundSms(req.tenant!.org.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const SmsTest = z.object({ to: z.string().trim().min(1).max(40) });
// AI-REACH: exempt: a test text to a number the admin types, to check the
// account they just saved on this screen; nothing for the assistant to do.
outboundEmailRouter.post("/sms/test", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!assertAdmin(req, res)) return;
    const body = SmsTest.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "Which number should the test go to?" } });
    const r = await sendTextFromWorkspace(req.tenant!.org.id, {
      to: body.data.to,
      text: `A test from ${req.tenant!.org.name} on Cobblr. If you can read it, its automations can text people the same way.`,
    });
    if (!r.ok) return void res.status(r.reason === "failed" ? 502 : r.reason === "not_configured" ? 409 : 400).json({ error: { code: r.reason, message: r.message } });
    res.json({ ok: true, status: r.status });
  } catch (err) {
    next(err);
  }
});
