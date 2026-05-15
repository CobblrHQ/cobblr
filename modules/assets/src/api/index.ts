import { Router } from "express";
import { assetsRouter } from "./assets.js";
import { registerAssetsResolvers } from "./resolvers.js";

registerAssetsResolvers();

const router = Router({ mergeParams: true });
router.use("/assets", assetsRouter);

export default router;
