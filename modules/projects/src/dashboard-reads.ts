// What the projects dashboard tile reads (ui/DashboardWidget.tsx), named for
// the one-request dashboard snapshot (#6563).
import { collectionTileReads, registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerProjectsDashboardReads(): void {
  registerDashboardRead({
    id: "projects.tile",
    module: "projects",
    paths: async (ctx) => [...(await collectionTileReads(ctx, "projects", "projects/projects")), `/orgs/${ctx.slug}/modules/projects/tasks/dashboard`],
  });
}
