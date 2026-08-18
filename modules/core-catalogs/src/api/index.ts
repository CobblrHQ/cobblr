// core-catalogs router + side-effect registration.
//
// Mounted by the platform at /api/v1/orgs/:slug/modules/core-catalogs/
// with requireAuth + withTenant pre-applied. Registers entity-kind
// resolvers on import so platform.entities.lookup("core-catalogs:entry", id)
// works from anywhere.

import { Router } from "express";
import { catalogsRouter } from "./catalogs.js";
import { registerCatalogsResolvers } from "./resolvers.js";

registerCatalogsResolvers();

const router = Router({ mergeParams: true });
router.use("/catalogs", catalogsRouter);

export default router;

// Side-effect: the assistant's only door into this module.
import { registerCatalogsHandlers } from "./handlers.js";
registerCatalogsHandlers();
