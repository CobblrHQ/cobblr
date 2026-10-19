import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { sessionUser, tenantContext } from "../../../db.js";
import { resinActionContext } from "../resin-stock.js";
import { ResinPostprocess } from "../resin-postprocess.js";
import { asyncHandler, requireRole, badBody } from "../../../api/util.js";
export const resinRouter = Router({ mergeParams: true });
// AI-ACTION: digifab:resin-postprocess
resinRouter.post("/jobs/:id/postprocess", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:resin-postprocess"))) return;
  const body = ResinPostprocess.safeParse({ job_id: req.params.id, step: req.body?.step });
  if (!body.success) return badBody(res, body.error);
  const result = normaliseActionResult(await platform().actions.invoke("digifab:resin-postprocess", resinActionContext(tenantContext(req).org.id, sessionUser(req)?.id ?? null, body.data)), "digifab.resin-postprocess");
  if (!result.ok) return void res.status(409).json({ error: { code: "postprocess_not_ready", message: typeof result.error === "string" ? result.error : "Check this print's washing and curing." } });
  res.json(result);
}));
