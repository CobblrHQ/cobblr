// The person's door to Services (services.md §10): what this person can call
// here, starting a job, reading it, answering it, stopping it. Every job
// started here is stamped `person` with the session's user; the confirm lives
// with the consent rule (its own route).

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ServicesNotReadyError } from "@cobblr/platform-contract/services";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { capabilityDetail, invokeAs, readingStatsFor, recentRunRoots, ServiceRefusal } from "../platform/services.js";
import { confirmServiceJob, confirmTriggerView, proposeConfirmTrigger, withdrawConfirmTrigger } from "../platform/service-confirm.js";
import { ServiceRefused } from "../platform/service-gate.js";
import { currentVia } from "../lib/request-context.js";
import type { ServiceDoor } from "@cobblr/platform-contract/services";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

/** Which door this request came through, from how it was authenticated, never
 *  from anything the caller sent: the assistant's grant is Cobb, an MCP
 *  client's token is MCP, an automation is a wire, a plain session a person. */
function doorOf(): ServiceDoor {
  const kind = currentVia()?.kind;
  if (kind === "assistant") return "cobb";
  if (kind === "mcp") return "mcp";
  if (kind === "automation") return "wire";
  return "person";
}

export const servicesRouter = Router({ mergeParams: true });

const orgOf = (req: Request) => req.tenant!.org.id;
const userOf = (req: Request) => req.session?.id ?? null;

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof ServiceRefusal) {
    const status = err.code === "no_service" ? 404 : err.code === "hop_limit" ? 409 : 400;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // The consent rule's refusal (a physical job over MCP, a capability turned
  // off here): its sentence is what the person or the model reads.
  if (err instanceof Error && err.name === "ServiceRefused") {
    res.status(403).json({ error: { code: (err as Error & { code?: string }).code ?? "refused", message: err.message } });
    return;
  }
  if (err instanceof ServicesNotReadyError) {
    res.status(503).json({ error: { code: "not_ready", message: err.message } });
    return;
  }
  next(err);
}

// AI-REACH: exempt (a read; Cobb and MCP reach Services through list_services)
servicesRouter.get("/:slug/services/capabilities", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ items: await platform().services.capabilities(orgOf(req), userOf(req)) });
  } catch (err) {
    fail(res, next, err);
  }
});

const Invoke = z.object({
  capability: z.string().min(3).max(120),
  input: z.unknown(),
  files: z.record(z.string().min(1).max(120)).optional(),
  via: z.union([z.object({ credential_id: z.string().min(1).max(200) }), z.object({ built_in: z.string().min(1).max(120) })]).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  attach_to: z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(200) }).optional(),
});

// AI-REACH: exempt (a read; list_services reads it for one capability's live choices)
servicesRouter.get("/:slug/services/capabilities/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    const found = await capabilityDetail(orgOf(req), userOf(req), String(req.params.id));
    // A page that routinely asks "does anything connected do this?" sends
    // if_any and gets 200 with options: null; a 404 is for asking about a
    // capability that must be there (#6268).
    if (!found && req.query.if_any === "1") {
      res.json({ id: String(req.params.id), offered: false, options: null });
      return;
    }
    if (!found) {
      res.status(404).json({ error: { code: "no_service", message: "nothing connected here does that" } });
      return;
    }
    res.json(found);
  } catch (err) {
    fail(res, next, err);
  }
});

// AI-REACH: exempt (Cobb and MCP start jobs through invoke_service, which stamps its own door)
servicesRouter.post("/:slug/services/jobs", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const b = Invoke.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(b.error.issues), details: b.error.issues } });
      return;
    }
    const job = await invokeAs(
      { origin: doorOf(), userId: userOf(req) },
      {
        orgId: orgOf(req),
        capability: b.data.capability,
        input: b.data.input,
        ...(b.data.files ? { files: b.data.files } : {}),
        ...(b.data.via ? { via: "credential_id" in b.data.via ? { credentialId: b.data.via.credential_id } : { builtIn: b.data.via.built_in } } : {}),
        ...(b.data.idempotency_key ? { idempotencyKey: b.data.idempotency_key } : {}),
        ...(b.data.attach_to ? { attachTo: b.data.attach_to } : {}),
      },
    );
    res.status(202).json((await platform().services.job(orgOf(req), job.id)) ?? job);
  } catch (err) {
    fail(res, next, err);
  }
});

// AI-REACH: exempt (a read: how often each capability was read without a job row, and how the last one went)
servicesRouter.get("/:slug/services/readings", requireAuth, withTenant, async (req, res) => {
  res.json({ items: readingStatsFor(orgOf(req)) });
});

// AI-REACH: exempt (a read)
// A run: the chain a job belongs to, from the job that started it, each
// step with what it waits on (services.md S9).
servicesRouter.get("/:slug/services/runs/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    const run = await platform().services.run(orgOf(req), String(req.params.id));
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "no such run" } });
      return;
    }
    res.json(run);
  } catch (err) {
    fail(res, next, err);
  }
});

// The recent runs here, stuck and waiting first.
servicesRouter.get("/:slug/services/runs", requireAuth, withTenant, async (req, res, next) => {
  try {
    const ids = await recentRunRoots(orgOf(req), 20);
    const runs = [];
    for (const id of ids) {
      const r = await platform().services.run(orgOf(req), id);
      if (r) runs.push(r);
    }
    const rank: Record<string, number> = { stuck: 0, waiting: 1, running: 2, failed: 3, done: 4, cancelled: 5 };
    runs.sort((a, b) => (rank[a.state]! - rank[b.state]!) || b.updated_at.localeCompare(a.updated_at));
    res.json({ items: runs });
  } catch (err) {
    fail(res, next, err);
  }
});

servicesRouter.get("/:slug/services/jobs/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    const job = await platform().services.job(orgOf(req), String(req.params.id));
    if (!job) {
      res.status(404).json({ error: { code: "not_found", message: "no such job" } });
      return;
    }
    res.json(job);
  } catch (err) {
    fail(res, next, err);
  }
});

// AI-REACH: exempt (answering a service's question is the job card's, and the chat card's, own control)
servicesRouter.post("/:slug/services/jobs/:id/input", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const userId = userOf(req);
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "sign in to answer" } });
      return;
    }
    await platform().services.answer(orgOf(req), String(req.params.id), (req.body as { input?: unknown } | null)?.input ?? null, userId);
    res.status(202).json(await platform().services.job(orgOf(req), String(req.params.id)));
  } catch (err) {
    fail(res, next, err);
  }
});

// AI-REACH: exempt (stopping a job is the job card's own control)
servicesRouter.post("/:slug/services/jobs/:id/cancel", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    await platform().services.cancel(orgOf(req), String(req.params.id), userOf(req));
    res.status(202).json(await platform().services.job(orgOf(req), String(req.params.id)));
  } catch (err) {
    fail(res, next, err);
  }
});

// A person's yes to a job that waits for one (services.md section 9). Bound
// to exactly what was shown, and only the person allowed to may give it;
// never reachable from an MCP grant (middleware MCP_WRITE_PLATFORM_PATHS).
// AI-REACH: exempt (the yes to a job is a person's, on its card; an assistant never confirms its own job)
servicesRouter.post("/:slug/services/jobs/:id/confirm", requireAuth, withTenant, async (req, res, next) => {
  try {
    // ROLE: the person who asked, or an owner or admin for an automation's job, checked by mayConfirm
    const userId = userOf(req);
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "sign in to say yes" } });
      return;
    }
    const jobId = String(req.params.id);
    await confirmServiceJob(orgOf(req), jobId, userId);
    res.json((await platform().services.job(orgOf(req), jobId)) ?? { id: jobId, status: "queued" });
  } catch (err) {
    if (err instanceof ServiceRefused) {
      const status = err.code === "not_found" ? 404 : err.code === "not_yours" ? 403 : 409;
      res.status(status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    fail(res, next, err);
  }
});

function refusedStatus(code: string): number {
  return code === "not_found" ? 404 : code === "not_yours" ? 403 : code === "refused" ? 400 : 409;
}

// What a waiting job waits for besides a yes ("power off after this print"),
// if anything (services.md section 9).
// AI-REACH: exempt (a read; get_service_job and the job card read it)
servicesRouter.get("/:slug/services/jobs/:id/trigger", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json({ trigger: await confirmTriggerView(orgOf(req), String(req.params.id)) });
  } catch (err) {
    fail(res, next, err);
  }
});

const Trigger = z.object({ after: z.string().min(1).max(200), hours: z.number().positive().max(168).optional() }).strict();

// Propose "start this when that finishes" on a waiting job. Starts nothing:
// the person's yes arms it, bound to what was shown, until its deadline.
// AI-REACH: exempt (Cobb proposes it through invoke_service's after; the yes stays the person's)
// UI-REACH: the assistant proposes it; the job card shows it and takes the yes or the cancel
servicesRouter.post("/:slug/services/jobs/:id/trigger", requireAuth, withTenant, async (req, res, next) => {
  try {
    // ROLE: the person who asked, or an owner or admin for an automation's job, checked by mayConfirm
    const userId = userOf(req);
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "sign in" } });
      return;
    }
    const b = Trigger.safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "after (a job or print id) is required; hours at most 168" } });
      return;
    }
    const view = await proposeConfirmTrigger(orgOf(req), String(req.params.id), userId, b.data.after, b.data.hours ? b.data.hours * 3600_000 : undefined);
    res.json({ trigger: view });
  } catch (err) {
    if (err instanceof ServiceRefused) {
      res.status(refusedStatus(err.code)).json({ error: { code: err.code, message: err.message } });
      return;
    }
    fail(res, next, err);
  }
});

// Take it back: the job waits for a plain yes again.
// AI-REACH: exempt (the job card's own control)
servicesRouter.delete("/:slug/services/jobs/:id/trigger", requireAuth, withTenant, async (req, res, next) => {
  try {
    // ROLE: the person who asked, or an owner or admin for an automation's job, checked by mayConfirm
    const userId = userOf(req);
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "sign in" } });
      return;
    }
    await withdrawConfirmTrigger(orgOf(req), String(req.params.id), userId);
    res.json({ trigger: null });
  } catch (err) {
    if (err instanceof ServiceRefused) {
      res.status(refusedStatus(err.code)).json({ error: { code: err.code, message: err.message } });
      return;
    }
    fail(res, next, err);
  }
});
