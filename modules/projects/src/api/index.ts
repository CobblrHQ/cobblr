// Default-exported Router. Mounted at /api/v1/orgs/:slug/modules/projects.
// Side effect on import: registers projects' action handlers +
// entity-kind resolvers with the platform.

import { Router } from "express";
import { projectsRouter } from "./projects.js";
import { tasksRouter } from "./tasks.js";
import { registerProjectsHandlers } from "./handlers.js";

registerProjectsHandlers();

const router = Router({ mergeParams: true });

router.use("/projects", projectsRouter);
router.use("/tasks", tasksRouter);

export default router;
