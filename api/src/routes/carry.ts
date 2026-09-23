// The receiving end of "bring what I built". docs/design-decisions/trial-ledger.md.
//
//   GET  /carry/preview?from=&token=  → the list the trial's ending showed
//   POST /orgs/:slug/carry            → replay it into this workspace
//
// Mounted on every deployment and answering only where COBBLR_CARRY_SOURCES
// names somewhere to read from, so a self-hosted box that never set it takes
// nothing from anyone.
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { CarryError, fetchCarryPackage, replayCarry } from "../platform/carry-replay.js";

export const carryRouter = Router();

const STATUS: Record<CarryError["code"], number> = {
  not_accepted: 404,
  unknown_source: 400,
  expired: 410,
  unreachable: 502,
  bad_package: 502,
  already: 409,
  same_workspace: 409,
};

function sendCarryError(res: Response, err: CarryError): void {
  res.status(STATUS[err.code]).json({ error: { code: `carry_${err.code}`, message: err.message } });
}

const Params = z.object({ from: z.string().min(1).max(500), token: z.string().min(10).max(200) });

// GET /carry/preview — what would come, before anything does. Signed in, so a
// token found in a history cannot be read from here by a stranger.
carryRouter.get(
  "/carry/preview",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const p = Params.safeParse(req.query);
      if (!p.success) {
        res.status(400).json({ error: { code: "invalid_query", message: "from and token are required." } });
        return;
      }
      const { pkg } = await fetchCarryPackage(p.data.from, p.data.token);
      res.json({
        workspace: pkg.workspace,
        ledger: pkg.ledger,
        homes: pkg.homes,
        unread: pkg.unread,
      });
    } catch (err) {
      if (err instanceof CarryError) return sendCarryError(res, err);
      next(err);
    }
  },
);

// POST /orgs/:slug/carry — replay into this workspace, as the person.
// AI-REACH: carries another deployment's trial in on the person's own grant;
// the token arrives in their browser and nowhere an agent reads.
carryRouter.post(
  "/orgs/:slug/carry",
  requireAuth,
  withTenant,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const p = Params.safeParse(req.body);
      if (!p.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "from and token are required." } });
        return;
      }
      const { source, pkg } = await fetchCarryPackage(p.data.from, p.data.token);
      const org = req.tenant!.org;
      const result = await replayCarry({
        orgId: org.id,
        slug: org.slug,
        userId: req.session!.id,
        source,
        token: p.data.token,
        pkg,
      });
      res.json({ workspace: pkg.workspace, ...result });
    } catch (err) {
      if (err instanceof CarryError) return sendCarryError(res, err);
      next(err);
    }
  },
);
