// The dashboard's own sections, as reads of its one request (#6563;
// @cobblr/platform-contract/dashboard-reads): what every workspace draws,
// whatever is on. What a module draws (a tile, the scan inbox, the pinned
// views) its module registers at its boot, beside what it draws: the kernel
// names no module.
//
// Each path is spelled as the web app asks for it (web/src/pages/Dashboard.tsx
// and what it renders); a path spelled differently is asked again by its
// section, and the walk the-dashboard-arrives-at-once-from-one-request.json
// says which.
import { registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

interface Instance {
  instance_name: string;
  module_name: string;
  is_default: boolean;
}

export function registerCoreDashboardReads(): void {
  registerDashboardRead({
    id: "core.page",
    paths: ({ slug, today, upNext }) => [
      `/orgs/${slug}/modules`,
      `/orgs/${slug}/instances`,
      `/orgs/${slug}/entity-kind-overrides`,
      `/orgs/${slug}/dashboard-layout`,
      `/orgs/${slug}/hosted-panels`,
      `/orgs/${slug}/activity?limit=50`,
      `/orgs/${slug}/attention?today=${today}`,
      ...(upNext ? [`/orgs/${slug}/calendar/events?from=${upNext.from}&to=${upNext.to}`] : []),
    ],
  });

  // Whether the workspace holds anything yet (web/src/lib/workspaceContent.ts):
  // one limit=1 read per named collection. A module's own default collection
  // is probed by its tile's reads (collectionTileReads).
  registerDashboardRead({
    id: "core.has-content",
    paths: async ({ slug, read }) => {
      const insts = (await read<{ items: Instance[] }>(`/orgs/${slug}/instances`))?.items ?? [];
      return insts
        // registry-filter-ok: the probe asks named collections only, as workspaceContent.ts does; a capability's default has no items route
        .filter((i) => !i.is_default && !i.module_name.startsWith("core-"))
        .map((i) => `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items?limit=1`);
    },
  });
}
