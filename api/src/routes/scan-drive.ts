// POST /orgs/:slug/scan-drive — a scan drives the user's designated tab.
// The scanner's device (wedge / BT-phone / edge bridge) POSTs the scanned code
// here, authed as the user; the router pushes the next step (navigate) to
// whichever tab that user marked as driven, or falls back to the triage inbox.
// See api/src/platform/scan-drive.ts + docs/design-decisions/scan-drives-screen.md.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { routeScanToDrive } from "../platform/scan-drive.js";

export const scanDriveRouter = Router({ mergeParams: true });

const Body = z.object({
  code: z.string().min(1).max(2000),
  scan_batch_id: z.string().min(1).max(120).optional(),
  disposition: z.enum(["navigate", "print"]).optional(),
});

scanDriveRouter.post("/:slug/scan-drive", requireAuth, withTenant, async (req, res, next) => {
  try {
    const b = Body.safeParse(req.body);
    if (!b.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "code required" } });
      return;
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const baseUrl = req.headers["x-cobblr-base-url"] as string | undefined;
    const result = await routeScanToDrive({
      orgId: req.tenant!.org.id,
      orgSlug: req.tenant!.org.slug,
      userId: req.session!.id,
      code: b.data.code,
      token,
      scanBatchId: b.data.scan_batch_id,
      baseUrl,
      disposition: b.data.disposition,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
