import { Router } from "express";
import { machinesRouter } from "./machines.js";
import { registerMachinesResolvers } from "./resolvers.js";

registerMachinesResolvers();

const router = Router({ mergeParams: true });
router.use("/machines", machinesRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD.
export { machinesRouter as primaryRouter };
