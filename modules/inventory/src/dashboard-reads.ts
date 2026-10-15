// What inventory's dashboard tiles read (ui/DashboardWidget.tsx), named for
// the one-request dashboard snapshot (#6563): the default collection's
// counts, each named collection's, and a type collection's whole family.
import { collectionTileReads, registerDashboardRead } from "@cobblr/platform-contract/dashboard-reads";

interface Override {
  target_kind: string;
  config?: { parent?: { instance?: string } } | null;
}

export function registerInventoryDashboardReads(): void {
  registerDashboardRead({
    id: "inventory.tile",
    module: "inventory",
    paths: async (ctx) => {
      const { slug, read } = ctx;
      const insts = (await read<{ items: Array<{ instance_name: string }> }>(`/orgs/${slug}/instances?module=inventory`))?.items ?? [];
      const overrides = (await read<{ items: Override[] }>(`/orgs/${slug}/entity-kind-overrides`))?.items ?? [];
      // A type collection draws one tile for itself and its things (FamilyTile).
      const parents = new Set(overrides.filter((o) => o.target_kind === "instance").map((o) => o.config?.parent?.instance).filter((p): p is string => !!p));
      return [
        ...(await collectionTileReads(ctx, "inventory", "inventory/parts")),
        // registry-filter-ok: only a type collection has a family to read
        ...insts.filter((i) => parents.has(i.instance_name)).map((i) => `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items/family/all`),
      ];
    },
  });
}
