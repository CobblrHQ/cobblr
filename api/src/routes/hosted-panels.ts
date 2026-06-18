// /api/v1/orgs/:slug/hosted-panels — generic settings panels contributed by a
// module/overlay (see platform().hostedPanels + the contract's HostedPanel).
//
// Open core registers no panels, so these endpoints return an empty list / 404
// — a self-hosted instance shows nothing. The hosted overlay registers the
// billing + Slack panels; the web app renders them with one generic renderer, so
// no panel-specific (proprietary) code lives in the open-core web bundle.
//
//   GET  /:slug/hosted-panels            → { panels: [{id,label,icon,group}] }
//   GET  /:slug/hosted-panels/:id        → the panel's declarative view
//   POST /:slug/hosted-panels/:id/action → run an action { action, input? }

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { getHostedPanel, listHostedPanels } from "../platform/hosted-seams.js";

export const hostedPanelsRouter = Router({ mergeParams: true });

function ctxOf(req: Request): { orgId: string; userId: string; slug: string } | null {
  const orgId = req.tenant?.org.id;
  const slug = req.tenant?.org.slug;
  const userId = req.session?.id;
  if (!orgId || !slug || !userId) return null;
  return { orgId, userId, slug };
}

hostedPanelsRouter.get(
  "/:slug/hosted-panels",
  requireAuth,
  withTenant,
  (_req: Request, res: Response) => {
    res.json({ panels: listHostedPanels() });
  },
);

hostedPanelsRouter.get(
  "/:slug/hosted-panels/:id",
  requireAuth,
  withTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const panel = getHostedPanel(req.params.id ?? "");
      if (!panel) {
        res.status(404).json({ error: { code: "no_panel", message: "no such panel" } });
        return;
      }
      const ctx = ctxOf(req);
      if (!ctx) {
        res.status(400).json({ error: { code: "no_org" } });
        return;
      }
      res.json(await panel.getView(ctx));
    } catch (err) {
      next(err);
    }
  },
);

hostedPanelsRouter.post(
  "/:slug/hosted-panels/:id/action",
  requireAuth,
  withTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const panel = getHostedPanel(req.params.id ?? "");
      if (!panel) {
        res.status(404).json({ error: { code: "no_panel", message: "no such panel" } });
        return;
      }
      const ctx = ctxOf(req);
      if (!ctx) {
        res.status(400).json({ error: { code: "no_org" } });
        return;
      }
      const body = (req.body ?? {}) as {
        action?: string;
        input?: { value?: string | null; values?: Record<string, string> };
      };
      if (!body.action) {
        res.status(400).json({ error: { code: "no_action", message: "action required" } });
        return;
      }
      res.json(await panel.runAction(ctx, body.action, body.input));
    } catch (err) {
      next(err);
    }
  },
);
