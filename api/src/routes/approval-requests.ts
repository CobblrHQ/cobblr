// /orgs/:slug/approval-requests — asking for what a gate refused, answering,
// and finishing. The rules live in platform/approvals.ts; this is the door.
//
// Two audiences on one router: the person who asked (create, withdraw,
// resume, complete, read their own) and the people who decide (list every
// open one, decide). The decision here is the same function the
// notification's Approve/Deny press runs, so the two doors cannot disagree.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import {
  completeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
  describeBlock,
  listApprovalRequests,
  mayDecide,
  prepareResume,
  viewRequest,
  withdrawApprovalRequest,
} from "../platform/approvals.js";

export const approvalRequestsRouter = Router({ mergeParams: true });

type Req = import("express").Request;

const orgOf = (req: Req) => (req as unknown as { tenant: { org: { id: string; slug: string }; role: string } }).tenant;
const userOf = (req: Req) => (req as unknown as { session: { id: string } }).session;

const Remedy = z.object({ kind: z.enum(["capability", "install"]), key: z.string().min(1).max(200) });
const CreateBody = z.object({
  remedies: z.array(Remedy).min(1).max(4),
  subject: z.string().min(1).max(200),
  note: z.string().max(500).optional().nullable(),
  /** The refused request, as the client sent it, so the yes can finish it.
   *  Replayed under the requester's own session: it can do nothing the
   *  person could not do by hand once the remedies hold. */
  resume: z
    .object({
      method: z.enum(["POST", "PATCH", "DELETE"]),
      path: z.string().min(1).max(600),
      body: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  /** The web route the person is on, so the yes reopens it. */
  route: z.string().max(600).nullable().optional(),
});
const DecideBody = z.object({ decision: z.enum(["approve", "deny"]), note: z.string().max(500).optional().nullable() });
const CompleteBody = z.object({ ok: z.boolean(), status: z.number().int().optional(), message: z.string().max(500).nullable().optional() });
const ListQuery = z.object({ status: z.enum(["open", "pending", "approved", "denied", "expired", "withdrawn", "resuming", "completed"]).optional() });

const DescribeBody = z.object({ remedies: z.array(Remedy).min(1).max(4), doing: z.string().max(80).optional() });

// AI-REACH: a read despite the verb; the same explanation a 403 carries, for a surface that knows ahead of the refusal
approvalRequestsRouter.post("/describe", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = DescribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const t = orgOf(req);
    const blocked = await describeBlock({
      orgId: t.org.id,
      userId: userOf(req).id,
      role: t.role,
      remedies: parsed.data.remedies,
      ...(parsed.data.doing ? { doing: parsed.data.doing } : {}),
    });
    res.json({ blocked });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: reads; the assistant sees a person's own requests through the sheet, not a door
approvalRequestsRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const q = ListQuery.safeParse(req.query);
    const t = orgOf(req);
    const items = await listApprovalRequests({
      orgId: t.org.id,
      viewerId: userOf(req).id,
      viewerRole: t.role,
      ...(q.success && q.data.status ? { status: q.data.status } : {}),
    });
    res.json({ items, can_decide: mayDecide(t.role) });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: asking for a permission is the person's own act after a refusal the sheet shows them; an assistant blocked the same way is told the same sentence and does not ask on their behalf
approvalRequestsRouter.post("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const t = orgOf(req);
    const slugPrefix = `/orgs/${t.org.slug}/`;
    const resume = parsed.data.resume ?? null;
    // The replay is the requester's own call, so it is bounded by their own
    // permissions; the one thing to refuse is a path outside this workspace,
    // which would be a draft for somewhere else.
    if (resume && !resume.path.startsWith(slugPrefix)) {
      res.status(400).json({ error: { code: "invalid_body", message: "The request to finish must be in this workspace." } });
      return;
    }
    const r = await createApprovalRequest({
      orgId: t.org.id,
      requesterId: userOf(req).id,
      requesterRole: t.role,
      remedies: parsed.data.remedies,
      subject: parsed.data.subject,
      note: parsed.data.note ?? null,
      resume: resume ? { method: resume.method, path: resume.path, body: resume.body ?? null } : null,
      route: parsed.data.route ?? null,
    });
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    const view = await viewRequest(r.request.id, userOf(req).id, t.role, t.org.id);
    res.status(r.existing ? 200 : 201).json({ request: view, existing: r.existing });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: reads
approvalRequestsRouter.get("/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    const t = orgOf(req);
    const view = await viewRequest(req.params.id!, userOf(req).id, t.role, t.org.id);
    if (!view) {
      res.status(404).json({ error: { code: "not_found", message: "No such request." } });
      return;
    }
    res.json({ request: view });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: deciding what another person may do is a person's decision; the assistant never approves or declines a request, and the two actions behind this are wire-only
approvalRequestsRouter.post("/:id/decide", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = DecideBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const t = orgOf(req);
    const r = await decideApprovalRequest({
      requestId: req.params.id!,
      deciderId: userOf(req).id,
      decision: parsed.data.decision,
      note: parsed.data.note ?? null,
    });
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    const view = await viewRequest(r.request.id, userOf(req).id, t.role, t.org.id);
    res.json({ request: view, applied: r.applied });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: taking back one's own ask; the sheet offers it beside the pending state
approvalRequestsRouter.post("/:id/withdraw", requireAuth, withTenant, async (req, res, next) => {
  try {
    const row = await withdrawApprovalRequest(req.params.id!, userOf(req).id);
    if (!row) {
      res.status(409).json({ error: { code: "not_pending", message: "Only your own pending request can be withdrawn." } });
      return;
    }
    res.json({ ok: true, status: row.status });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: the requester's own resume, handed out once; the sheet replays their draft under their session
approvalRequestsRouter.post("/:id/resume", requireAuth, withTenant, async (req, res, next) => {
  try {
    const r = await prepareResume(req.params.id!, userOf(req).id);
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json({ resume: r.resume, subject: r.request.subject, remedies: r.request.remedies });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: the requester reporting how their replay went; bookkeeping on their own row
approvalRequestsRouter.post("/:id/complete", requireAuth, withTenant, async (req, res, next) => {
  try {
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const row = await completeApprovalRequest(req.params.id!, userOf(req).id, parsed.data);
    if (!row) {
      res.status(409).json({ error: { code: "not_resuming", message: "Nothing of yours is being finished." } });
      return;
    }
    res.json({ ok: true, status: row.status });
  } catch (err) {
    next(err);
  }
});
