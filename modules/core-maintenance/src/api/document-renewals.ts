import { Router } from "express";
import { z } from "zod";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { tenantContext, sessionUser } from "../db.js";
import { planRenewalDocument } from "../renewal-documents.js";
import { asyncHandler, badBody } from "./util.js";

export const DocumentFields = z.object({ vin: z.string().max(80).optional(), plate: z.string().max(80).optional(), expires: z.string().max(40).optional(), amount: z.string().max(80).optional(), reference: z.string().max(200).optional(), make: z.string().max(100).optional(), model: z.string().max(100).optional(), year: z.string().max(20).optional() });
const PlanBody = z.object({ document_type: z.string().min(1).max(80), fields: DocumentFields });
export const documentRenewalsRouter = Router({ mergeParams: true });
// AI-REACH: exempt form choices, the renewal action's planner supplies the same confirmed record and fields to Cobb
// UI-SCREEN: /scan
documentRenewalsRouter.post("/plan", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:renew-document"))) return;
  const parsed = PlanBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const { org, role } = tenantContext(req);
  res.setHeader("Cache-Control", "no-store");
  res.json(await planRenewalDocument(org.id, { userId: sessionUser(req).id, role }, parsed.data.document_type, parsed.data.fields));
}));
