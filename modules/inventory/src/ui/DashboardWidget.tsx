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

type Row = { low_stock?: boolean };
type Inst = { instance_name: string; display_name: string };

function InventoryDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  // The base inventory + every inventory INSTANCE (Yarn, Hooks, Wardrobe…). A
  // skinned instance keeps its items under /instances/<name>/items, so counting
  // only the base list showed "0" on a workspace full of yarn. Count them all.
  const base = useQuery({
    queryKey: ["dash-inv-base", slug],
    queryFn: () => getJson<{ items: Row[] }>(`/api/v1/orgs/${slug}/modules/inventory/parts?limit=200`, getToken).catch(() => ({ items: [] })),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-inv-insts", slug],
    queryFn: () => getJson<{ items: Inst[] }>(`/api/v1/orgs/${slug}/instances?module=inventory`, getToken).catch(() => ({ items: [] })),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const instList = insts.data?.items ?? [];
  const instData = useQuery({
    queryKey: ["dash-inv-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () =>
      Promise.all(
        instList.map((i) =>
          getJson<{ items: Row[] }>(`/api/v1/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items?limit=200`, getToken)
            .then((r) => ({ name: i.instance_name, label: i.display_name, total: r.items.length, low: r.items.filter((p) => p.low_stock).length }))
            .catch(() => ({ name: i.instance_name, label: i.display_name, total: 0, low: 0 })),
        ),
      ),
    enabled: !!slug && instList.length > 0,
    staleTime: 30_000,
  });
  const baseItems = base.data?.items ?? [];
  const rows = instData.data ?? [];
  const total = baseItems.length + rows.reduce((a, b) => a + b.total, 0);
  const lowCount = baseItems.filter((p) => p.low_stock).length + rows.reduce((a, b) => a + b.low, 0);
  // Click-through: the base list if it has items, else the biggest instance, so
  // the tile never dead-ends on an empty base inventory.
  const biggest = [...rows].sort((a, b) => b.total - a.total)[0];
  const to = baseItems.length > 0 || !biggest ? "/inventory" : `/instances/${biggest.name}`;
  return (
    <DashboardTile
      to={to}
      icon={Package}
      label="inventory"
      primary={total}
      secondary={
        rows.length > 0 ? (
          rows.map((r) => r.label).join(" · ")
        ) : lowCount > 0 ? (
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
