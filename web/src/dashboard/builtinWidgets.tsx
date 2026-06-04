// The host's built-in "at a glance" widgets — for the modules whose web UI
// lives in the HOST (machines / assets / purchases have no packaged @cobblr/<m>/ui
// bundle, their pages are host pages). They register through the SAME public
// seam a bundle / third-party module uses (`registerDashboardWidget`), so the
// Dashboard itself has no per-module knowledge. Imported for its side effect
// (the register calls) by Dashboard.tsx.
//
// The three PACKAGED modules' tiles (inventory / labels / projects) used to
// live here too; they now register from inside their own `@cobblr/<m>/ui`
// bundles (modules/<m>/src/ui/DashboardWidget.tsx) — the module owns its glance
// number. These three stay host-side because they have no packaged UI to move
// into.

import { useQuery } from "@tanstack/react-query";
import { Wrench, Sprout, ShoppingCart } from "lucide-react";
import { DashboardTile, registerDashboardWidget } from "@cobblr/platform-web";
import { api } from "../lib/api";

function MachinesWidget({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-machines", slug],
    queryFn: () =>
      api.request<{ items: Array<{ state: string }> }>(
        "GET",
        `/orgs/${slug}/modules/machines/machines?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const states = items.reduce<Record<string, number>>((acc, m) => {
    acc[m.state] = (acc[m.state] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(states)
    .map(([s, n]) => `${n} ${s}`)
    .slice(0, 3)
    .join(" · ");
  return (
    <DashboardTile
      to="/machines"
      icon={Wrench}
      label="machines"
      primary={items.length}
      secondary={breakdown || "none yet"}
    />
  );
}

function AssetsWidget({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-assets", slug],
    queryFn: () =>
      api.request<{ items: Array<{ state: string }> }>(
        "GET",
        `/orgs/${slug}/modules/assets/assets?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const states = items.reduce<Record<string, number>>((acc, m) => {
    const k = m.state ?? "—";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const top = Object.entries(states)
    .slice(0, 2)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
  return (
    <DashboardTile
      to="/assets"
      icon={Sprout}
      label="assets"
      primary={items.length}
      secondary={top || "none yet"}
    />
  );
}

function PurchasesWidget({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-orders", slug],
    queryFn: () =>
      api.request<{ items: Array<{ status: string }> }>(
        "GET",
        `/orgs/${slug}/modules/purchases/orders?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const open = items.filter((o) => o.status !== "arrived" && o.status !== "cancelled").length;
  return (
    <DashboardTile
      to="/purchases"
      icon={ShoppingCart}
      label="purchases"
      primary={open}
      secondary={open === items.length ? "all open" : `${items.length} total`}
    />
  );
}

// Order hints leave room for the module-registered tiles (inventory 10,
// projects 30, labels 60) to interleave in the default arrangement.
registerDashboardWidget({ module: "machines", order: 20, component: MachinesWidget });
registerDashboardWidget({ module: "assets", order: 40, component: AssetsWidget });
registerDashboardWidget({ module: "purchases", order: 50, component: PurchasesWidget });
