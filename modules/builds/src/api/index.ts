import { inspectionRouter, registerInspectionActions } from "./inspection.js";
import { reflowRouter, registerReflowActions } from "./reflow.js";
import { registerAssemblyPasteActions } from "./assembly-paste.js";
import { placementRouter, registerPlacementActions } from "./placement.js";
import { assemblyOrdersRouter, registerAssemblyOrderActions } from "./assembly-orders.js";
import { boardRevisionsRouter, registerBoardRevisionActions } from "./board-revisions.js";
// builds router. Mounted at /api/v1/orgs/:slug/modules/builds/.
// Registers entity resolvers + action handlers at load time.

import { Router } from "express";
import { buildsRouter } from "./builds.js";
import { registerBuildsResolvers } from "./resolvers.js";
import { registerBuildsActionHandlers } from "./action-handlers.js";
import { asyncHandler } from "./util.js";
import { sessionUser, tenantContext } from "../db.js";
import { searchComponents } from "../component-search.js";
import { registerAddComponentAction } from "./add-component-action.js";
import { registerRemoveComponentAction } from "./remove-component-action.js";
import { registerAddStepAction } from "./add-step-action.js";
import { registerChangeStepAction } from "./change-step-action.js";
import { registerRemoveStepAction } from "./remove-step-action.js";
import { registerLogStepTimeAction } from "./log-step-time-action.js";
import { registerLogStepCountAction } from "./log-step-count-action.js";
import { registerPlanBuildAction } from "./plan-build-action.js";
import { registerChangePlanAction } from "./change-plan-action.js";
import { registerRemovePlanAction } from "./remove-plan-action.js";

registerRemovePlanAction();

registerChangePlanAction();

registerPlanBuildAction();

registerLogStepCountAction();

registerLogStepTimeAction();

registerRemoveStepAction();

registerChangeStepAction();

registerAddStepAction();

registerRemoveComponentAction();

registerAddComponentAction();
import { registerSetSubAssemblySourceAction } from "./set-sub-assembly-source-action.js";

registerSetSubAssemblySourceAction();

registerBoardRevisionActions();
registerAssemblyOrderActions();
registerPlacementActions();
registerReflowActions();
registerInspectionActions();
registerAssemblyPasteActions();
registerBuildsResolvers();
registerBuildsActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", boardRevisionsRouter);
router.use("/", assemblyOrdersRouter);
router.use("/", placementRouter);
router.use("/", reflowRouter);
router.use("/", inspectionRouter);
router.use("/", buildsRouter);

// What a build can use as a component, across every collection that keeps stock (#5892).
// AI-REACH: exempt (the component picker's search; the assistant finds records with its own search across kinds and adds a component with the build's component route)
router.get("/stock", asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const ctx = tenantContext(req);
  res.json({ items: await searchComponents(ctx.org.id, q, { userId: sessionUser(req)?.id, role: ctx.role }) });
}));

export default router;
