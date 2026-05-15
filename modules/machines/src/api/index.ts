import { Router } from "express";
import { machinesRouter } from "./machines.js";
import { registerMachinesResolvers } from "./resolvers.js";

registerMachinesResolvers();

const router = Router({ mergeParams: true });
router.use("/machines", machinesRouter);

export default router;
