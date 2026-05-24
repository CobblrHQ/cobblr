// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-locations/
// with requireAuth + withTenant pre-applied by the platform.

import { Router } from "express";
import { locationsRouter } from "./locations.js";
import { registerLocationsResolvers } from "./resolvers.js";

const router = Router({ mergeParams: true });

router.use("/locations", locationsRouter);

// Side-effect: register the entity-kind resolvers at module-load
// time so cross-module callers (machines/assets/inventory entity-
// chip rendering) can platform().entities.lookup() locations.
registerLocationsResolvers();

export default router;
