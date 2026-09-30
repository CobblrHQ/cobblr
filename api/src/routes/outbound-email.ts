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
    res.json(await outboundEmailStatus(req.tenant!.org.id));
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
