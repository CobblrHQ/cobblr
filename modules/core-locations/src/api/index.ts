// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-locations/
// with requireAuth + withTenant pre-applied by the platform.

import { Router } from "express";
import { locationsRouter } from "./locations.js";
import { locationsImportRouter } from "./import.js";
import { floorplanRouter } from "./floorplan.js";
import { registerLocationsResolvers } from "./resolvers.js";
import { registerLocationsWriter } from "./sync-writer.js";
import { registerLocationsHandlers } from "./handlers.js";

const router = Router({ mergeParams: true });

// Import/export first so /locations/import + /locations/export aren't swallowed
// by the main router's /locations/:id route.
router.use("/locations", locationsImportRouter);
// Floor plan (":id/floorplan/seed") before the generic /:id routes.
router.use("/locations", floorplanRouter);
router.use("/locations", locationsRouter);

// Side-effect: register the entity-kind resolvers at module-load
// time so cross-module callers (machines/assets/inventory entity-
// chip rendering) can platform().entities.lookup() locations.
registerLocationsResolvers();
// Side-effect: register the in-process entity writer so the sync engine can
// mirror an external system's locations in without an HTTP loopback.
registerLocationsWriter();
// Side-effect: register the action handlers (core-locations:reorder) so the
// assistant has a door to the one field the update route refuses.
registerLocationsHandlers();

export default router;
