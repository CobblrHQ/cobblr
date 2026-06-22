// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-locations/
// with requireAuth + withTenant pre-applied by the platform.

import { Router } from "express";
import { locationsRouter } from "./locations.js";
import { locationsImportRouter } from "./import.js";
import { registerLocationsResolvers } from "./resolvers.js";

const router = Router({ mergeParams: true });

// Import/export first so /locations/import + /locations/export aren't swallowed
// by the main router's /locations/:id route.
router.use("/locations", locationsImportRouter);
router.use("/locations", locationsRouter);

// Side-effect: register the entity-kind resolvers at module-load
// time so cross-module callers (machines/assets/inventory entity-
// chip rendering) can platform().entities.lookup() locations.
registerLocationsResolvers();

export default router;
