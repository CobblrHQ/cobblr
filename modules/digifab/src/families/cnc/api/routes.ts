// The CNC family's routes. Placing a program on stock keeps its path under the
// job it places (POST /jobs/:id/place); the module mounts this router at /jobs
// beside the core's queue routes.
import { Router } from "express";
import { z } from "zod";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { tenantContext, tenantDb } from "../../../db.js";
import { ReviewRequired } from "../../../drivers/job-review.js";
import { asyncHandler, badBody } from "../../../api/util.js";
import { CncPlacementBody, placeCncProgram } from "../cnc-placement-service.js";

export const cncJobsRouter = Router({ mergeParams: true });

// AI-REACH: action digifab:place-program
// UI-SCREEN: /station/machine/:connectionId/:deviceId
cncJobsRouter.post("/:id/place", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: placing a program on stock is setting up the machine; it stays with the admin tier, at every door (#5170)
  if (!(await requireCapability(req, res, "digifab:place-program"))) return;
  const body = CncPlacementBody.safeParse(req.body), id = z.string().uuid().safeParse(req.params.id);
  if (!body.success) return badBody(res, body.error);
  if (!id.success) return badBody(res, id.error);
  try { res.json(await placeCncProgram(tenantDb(req), tenantContext(req).org.id, id.data, body.data)); }
  catch (e) { if (!(e instanceof ReviewRequired)) throw e; res.status(409).json({ error: { code: "placement_refused", message: e.message } }); }
}));
