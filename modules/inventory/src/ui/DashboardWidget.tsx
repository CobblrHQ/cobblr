// Inventory's "at a glance" dashboard tile. It lives in the module and
// registers through platform-web's public seam at ui-bundle load (the host
// imports @cobblr/inventory/ui eagerly, so this runs), rather than being
// hardcoded in the host — the module owns its own glance number.
//
// Faithful 1:1 with the former host tile: same endpoint, same query key, same
// compute. The widget is mounted by the host OUTSIDE the module's own provider,
// so it can't use useInventory(); it fetches with the injected getToken. A raw
// fetch (not the InventoryApi client) keeps the count exactly as before — the
// client's listParts is cursor-paginated with no `limit`, which would change
// the number.

import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import {
  DashboardTile,
  registerDashboardWidget,
  type DashboardWidgetProps,
} from "@cobblr/platform-web";

async function getJson<T>(url: string, getToken: () => string | null): Promise<T> {
  const token = getToken();
  const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function InventoryDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const all = useQuery({
    queryKey: ["dash-inv-all", slug],
    queryFn: () =>
      getJson<{ items: Array<{ low_stock?: boolean }> }>(
        `/api/v1/orgs/${slug}/modules/inventory/parts?limit=200`,
        getToken,
      ),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const items = all.data?.items ?? [];
  const total = items.length;
  const lowCount = items.filter((p) => p.low_stock).length;
  return (
    <DashboardTile
      to="/inventory"
      icon={Package}
      label="inventory"
      primary={total}
      secondary={
        lowCount > 0 ? (
          <span className="text-ember-600 dark:text-ember-500">{lowCount} low-stock</span>
        ) : (
          "all stocked"
        )
      }
      attention={lowCount > 0}
    />
  );
}

registerDashboardWidget({ module: "inventory", order: 10, component: InventoryDashboardWidget });
