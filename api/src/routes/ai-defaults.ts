// /api/v1/me/ai-defaults: a person's own default AI per job (#5404), for
// the account page's "Who answers for you". The reads, checks and the write
// live in platform/my-ai-defaults.ts, shared with the assistant's door, the
// kernel action platform:set-my-default-ai.

import { Router, type Request, type Response } from "express";
import { AI_DEFAULT_JOBS, AI_JOBS } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { StepsBody, MAX_STEPS, jobById, myAiDefaultsView, saveMyAiDefaults } from "../platform/my-ai-defaults.js";
import { z } from "zod";
import { personalDocumentsReaderView, setPersonalDocumentsReader } from "../platform/personal-documents-reader.js";
import { WorkspaceStepsBody, saveWorkspaceAiDefaults, workspaceAiDefaultsView, workspaceJobById } from "../platform/workspace-ai-defaults.js";

export const aiDefaultsRouter = Router();

async function readHandler(req: Request, res: Response, next: (err?: unknown) => void): Promise<void> {
  try {
    res.json(await myAiDefaultsView(req.session!.id, { fresh: req.query.fresh === "1" }));
  } catch (err) {
    next(err);
  }
}

async function putHandler(req: Request, res: Response, next: (err?: unknown) => void): Promise<void> {
  try {
    const userId = req.session!.id;
    const job = jobById(req.params.job);
    if (!job) {
      res.status(404).json({ error: { code: "unknown_job", message: `No such job. The jobs are: ${AI_DEFAULT_JOBS.map((j) => j.id).join(", ")}.` } });
      return;
    }
    const parsed = StepsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: `Send steps: up to ${MAX_STEPS} of { credential_id, model }, First first.`, details: parsed.error.issues } });
      return;
    }
    const saved = await saveMyAiDefaults(userId, job, parsed.data.steps);
    if (!saved.ok) {
      res.status(400).json({ error: { code: "step_refused", message: saved.refusal } });
      return;
    }
    res.json(saved.view);
  } catch (err) {
    next(err);
  }
}

async function deleteHandler(req: Request, res: Response, next: (err?: unknown) => void): Promise<void> {
  try {
    const userId = req.session!.id;
    const job = jobById(req.params.job);
    if (!job) {
      res.status(404).json({ error: { code: "unknown_job", message: `No such job. The jobs are: ${AI_DEFAULT_JOBS.map((j) => j.id).join(", ")}.` } });
      return;
    }
    const saved = await saveMyAiDefaults(userId, job, []);
    if (!saved.ok) {
      res.status(400).json({ error: { code: "step_refused", message: saved.refusal } });
      return;
    }
    res.json(saved.view);
  } catch (err) {
    next(err);
  }
}

aiDefaultsRouter.get("/me/ai-defaults", requireAuth, readHandler);
// AI-ACTION: platform:set-my-default-ai
// GATE: an account route with no workspace to hold a capability in; it changes only the signed-in person's own defaults (requireAuth), the same any-member rule the action declares
aiDefaultsRouter.put("/me/ai-defaults/:job", requireAuth, putHandler);
// AI-ACTION: platform:set-my-default-ai
// GATE: an account route with no workspace to hold a capability in; it changes only the signed-in person's own defaults (requireAuth), the same any-member rule the action declares
aiDefaultsRouter.delete("/me/ai-defaults/:job", requireAuth, deleteHandler);

// A workspace's own order per job (#5622), for the AI page's "Who does what,
// in order": member-readable, set by an owner or admin. The reads, checks and
// the write live in platform/workspace-ai-defaults.ts.
async function workspaceRead(req: Request, res: Response, next: (err?: unknown) => void): Promise<void> {
  try {
    res.json(await workspaceAiDefaultsView(req.tenant!.org.id, req.session?.id ?? null, req.tenant!.role, { fresh: req.query.fresh === "1" }));
  } catch (err) {
    next(err);
  }
}

async function workspaceWrite(req: Request, res: Response, next: (err?: unknown) => void, clear: boolean): Promise<void> {
  try {
    const job = workspaceJobById(req.params.job);
    if (!job) {
      res.status(404).json({ error: { code: "unknown_job", message: `No such job. The jobs are: ${AI_JOBS.map((j) => j.id).join(", ")}.` } });
      return;
    }
    const parsed = clear ? { success: true as const, data: { steps: [] } } : WorkspaceStepsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: `Send steps: up to ${MAX_STEPS} of { connection, model }, First first.`, details: parsed.error.issues } });
      return;
    }
    const saved = await saveWorkspaceAiDefaults(req.tenant!.org.id, req.session?.id ?? null, req.tenant!.role, job, parsed.data.steps);
    if (!saved.ok) {
      res.status(400).json({ error: { code: "step_refused", message: saved.refusal } });
      return;
    }
    res.json(saved.view);
  } catch (err) {
    next(err);
  }
}

aiDefaultsRouter.get("/orgs/:slug/ai-job-order", requireAuth, withTenant, workspaceRead);
// AI-REACH: the workspace's AI setup is configured by a person on the AI page, as its per-job pins are (core-ai capability-defaults); the assistant does not rearrange which AI answers it
aiDefaultsRouter.put("/orgs/:slug/ai-job-order/:job", requireAuth, withTenant, async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  await workspaceWrite(req, res, next, false);
});
// AI-REACH: the workspace's AI setup is configured by a person on the AI page, as its per-job pins are (core-ai capability-defaults); the assistant does not rearrange which AI answers it
aiDefaultsRouter.delete("/orgs/:slug/ai-job-order/:job", requireAuth, withTenant, async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  await workspaceWrite(req, res, next, true);
});

// Who reads this workspace's personal documents (#5621): on this machine
// only (the default) or one consented cloud connection. Member-readable; only
// an owner changes it.
aiDefaultsRouter.get("/orgs/:slug/personal-documents-reader", requireAuth, withTenant, async (req, res, next) => {
  try {
    res.json(await personalDocumentsReaderView(req.tenant!.org.id, req.session?.id ?? null, req.tenant!.role));
  } catch (err) {
    next(err);
  }
});

const ReaderBody = z.union([z.object({ connection: z.literal("local") }), z.object({ connection: z.string().trim().min(1).max(200), consent: z.string().max(400) })]);

// AI-REACH: consent to send personal documents to a cloud company must be a person's own click; the assistant reads the setting (get_workspace_setup, part ai) and never turns the cloud on
aiDefaultsRouter.put("/orgs/:slug/personal-documents-reader", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner")) return;
    const parsed = ReaderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: 'Send { connection: "local" }, or { connection, consent } with the sentence the page showed.' } });
      return;
    }
    const saved = await setPersonalDocumentsReader(req.tenant!.org.id, req.session!.id, parsed.data);
    if (!saved.ok) {
      res.status(400).json({ error: { code: "consent_refused", message: saved.refusal } });
      return;
    }
    res.json(await personalDocumentsReaderView(req.tenant!.org.id, req.session!.id, req.tenant!.role));
  } catch (err) {
    next(err);
  }
});
