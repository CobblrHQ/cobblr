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
import { registerPlaceParent } from "./place-parent.js";
import { lightsRouter } from "./lights.js";
import { planDraftsRouter, registerPlanDraftHandlers } from "./plan-drafts.js";
import { floorplanFileRouter, registerFloorplanFileHandlers } from "./floorplan-file.js";

const router = Router({ mergeParams: true });

// Import/export first so /locations/import + /locations/export aren't swallowed
// by the main router's /locations/:id route.
router.use("/locations", locationsImportRouter);
// Floor plan (":id/floorplan/seed") before the generic /:id routes.
router.use("/locations", floorplanRouter);
// A whole house as one file (cobblr-floorplan/1): /floorplan/import before /:id.
router.use("/locations", floorplanFileRouter);
router.use("/locations", lightsRouter);
// Planning layouts (":id/plan-drafts", "plan-drafts/:draftId") before /:id.
router.use("/locations", planDraftsRouter);
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
// Side-effect: the assistant's doors to a planning layout.
registerPlanDraftHandlers();
// Side-effect: the assistant's doors to importing and exporting a plan file.
registerFloorplanFileHandlers();
// Side-effect: a place's parent place, for "where is this" across placements.
registerPlaceParent();

export default router;
