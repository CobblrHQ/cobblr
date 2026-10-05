import { Router } from "express";
import { asyncHandler } from "./util.js";
import { floorSnapshot } from "../floor-manager.js";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
export const floorRouter = Router({ mergeParams: true });
floorRouter.get("/", asyncHandler(async (req, res) => {
 res.json(await floorSnapshot(tenantDb(req), tenantContext(req).org.id, { userId: sessionUser(req)?.id, role: tenantContext(req).role }));
}));
