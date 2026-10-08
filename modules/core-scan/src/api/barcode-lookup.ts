import { Router } from "express";
import { z } from "zod";
import { sessionUser, tenantContext } from "../db.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { asyncHandler, badBody } from "./util.js";
import { barcodeFormLookup } from "../services/barcode-form-lookup.js";

export const barcodeLookupRouter = Router({ mergeParams: true });
const Body = z.object({ code: z.string().trim().min(1).max(4096) });
// AI-REACH: action core-scan:lookup-barcode
barcodeLookupRouter.post("/barcode-lookup", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-scan:lookup-barcode"))) return;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  res.json(await barcodeFormLookup(tenantContext(req).org.id, parsed.data.code, sessionUser(req).id));
}));
