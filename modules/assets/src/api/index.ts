import { Router } from "express";
import { assetsRouter } from "./assets.js";
import { registerAssetsResolvers } from "./resolvers.js";

registerAssetsResolvers();

const router = Router({ mergeParams: true });
router.use("/assets", assetsRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD — the platform
// dispatches /orgs/:slug/instances/:name/items here with req.instance set.
export { assetsRouter as primaryRouter };
