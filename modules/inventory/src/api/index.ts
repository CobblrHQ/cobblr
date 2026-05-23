// Default-exported Router. The platform mounts this at
// /api/v1/orgs/:slug/modules/inventory/ with requireAuth +
// withTenant pre-applied, so handlers can rely on req.session +
// req.tenant being populated.
//
// Side effects on import:
//   - Inventory's entity-kind resolvers register with the platform
//     so platform.entities.lookup("inventory:part", id) works.

import { Router } from "express";
import { categoriesRouter } from "./categories.js";
import { locationsRouter } from "./locations.js";
import { partsRouter } from "./parts.js";
import { allocationsRouter } from "./allocations.js";
import { importRouter } from "./import.js";
import { registerInventoryResolvers } from "./resolvers.js";
import { registerInventoryActionHandlers } from "./action-handlers.js";

registerInventoryResolvers();
registerInventoryActionHandlers();

const router = Router({ mergeParams: true });

router.use("/categories", categoriesRouter);
router.use("/locations", locationsRouter);
router.use("/parts", partsRouter);
router.use("/allocations", allocationsRouter);
router.use(importRouter);

export default router;
