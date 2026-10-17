// core-templates router. Mounted at
//   /api/v1/orgs/:slug/modules/core-templates/.

import { Router } from "express";
import { templatesRouter } from "./templates.js";
import { registerSaveTemplateAction } from "./save-template-action.js";
import { registerDeleteTemplateAction } from "./delete-template-action.js";

registerSaveTemplateAction();
registerDeleteTemplateAction();

const router = Router({ mergeParams: true });
router.use("/templates", templatesRouter);

export default router;
