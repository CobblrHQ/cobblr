// What the machines dashboard tile reads (the host's built-in tile,
// web/src/dashboard/builtinWidgets.tsx), named for the one-request dashboard
// snapshot (#6563).
import { collectionTileReads, registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

export function registerMachinesDashboardReads(): void {
  registerDashboardRead({ id: "machines.tile", module: "machines", paths: (ctx) => collectionTileReads(ctx, "machines", "machines/machines") });
}
