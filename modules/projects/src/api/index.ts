// Default-exported Router. Mounted at /api/v1/orgs/:slug/modules/projects.
// Side effect on import: registers projects' action handlers +
// entity-kind resolvers with the platform.

import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { projectsRouter } from "./projects.js";
import { tasksRouter } from "./tasks.js";
import { registerProjectsHandlers } from "./handlers.js";
import { registerProjectsNotificationMappers } from "./notification-mapper.js";
import { registerProjectsCalendarSource } from "./calendar-source.js";

registerProjectsCalendarSource();
registerProjectsHandlers();
registerProjectsNotificationMappers();
// Date custom-fields on projects:project (deadlines/milestones, …) land on the
// workspace calendar via the generic kernel source. (Audit 2026-06-26 follow-up.)
platform().calendar.registerDateFieldSource({
  kind: "projects:project",
  table: "projects_projects",
  entityModule: "projects",
  entityType: "project",
});

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones (projects are the primary entity).
platform().instances.registerItemCounter("projects", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from projects_projects where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });

router.use("/projects", projectsRouter);
router.use("/tasks", tasksRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD (projects are the
// primary entity; tasks remain default-instance for now).
export { projectsRouter as primaryRouter };

// Side-effect: the assistant's door to task dependencies.
import { registerDependencyHandlers } from "./dep-handlers.js";
registerDependencyHandlers();
