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
  // Base machines + every machines INSTANCE (3D Printers, Laser Cutters, CNC
  // Machines…), whose items live under /instances/<name>/items. Machines is a
  // "multi" module: the type-specific specialisations are instances, so a
  // workspace with tons of printers but no base-list machines was flagged
  // "nothing in them yet" — the same miss AssetsWidget already fixed.
  const q = useQuery({
    queryKey: ["dash-machines", slug],
    queryFn: () =>
      api
        .request<{ items: Array<{ state: string }> }>("GET", `/orgs/${slug}/modules/machines/machines?limit=200`)
        .catch(() => ({ items: [] })),
    staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-machines-insts", slug],
    queryFn: () => api.listInstances(slug, "machines").catch(() => ({ items: [] })),
    staleTime: 30_000,
  });
  const instList = insts.data?.items ?? [];
  const instData = useQuery({
    queryKey: ["dash-machines-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () =>
      Promise.all(
        instList.map((i) =>
          api
            .request<{ items: unknown[] }>("GET", `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items?limit=200`)
            .then((r) => ({ name: i.instance_name, label: i.display_name, total: r.items.length }))
            .catch(() => ({ name: i.instance_name, label: i.display_name, total: 0 })),
        ),
      ),
    enabled: instList.length > 0,
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const rows = instData.data ?? [];
  const total = items.length + rows.reduce((a, b) => a + b.total, 0);
  const states = items.reduce<Record<string, number>>((acc, m) => {
    acc[m.state] = (acc[m.state] ?? 0) + 1;
    return acc;
  }, {});
  const top = Object.entries(states)
    .slice(0, 2)
    .map(([s, n]) => `${n} ${s}`)
    .join(" · ");
  // Always land on the machines base page — never dive into ONE instance (that
  // silently dropped the others). When the base list is empty but instances
  // exist, /machines shows an instance chooser (3D Printers · N, Laser Cutters ·
  // M…), so the tile's "all machines" promise matches the destination.
  return (
    <DashboardTile
      to="/machines"
      icon={Wrench}
      label="machines"
      primary={total}
      secondary={rows.length > 0 ? rows.map((r) => r.label).join(" · ") : top || "none yet"}
      empty={!q.isLoading && !insts.isLoading && !instData.isLoading && total === 0}
    />
  );
}

function AssetsWidget({ slug }: { slug: string }) {
  // Base assets + every assets INSTANCE (Plant Care, Documents, Warranties…),
  // whose items live under /instances/<name>/items — counting only the base
  // list showed "0" on those workspaces.
  const q = useQuery({
    queryKey: ["dash-assets", slug],
    queryFn: () => api.request<{ items: Array<{ state: string }> }>("GET", `/orgs/${slug}/modules/assets/assets?limit=200`).catch(() => ({ items: [] })),
    staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-assets-insts", slug],
    queryFn: () => api.listInstances(slug, "assets").catch(() => ({ items: [] })),
    staleTime: 30_000,
  });
  const instList = insts.data?.items ?? [];
  const instData = useQuery({
    queryKey: ["dash-assets-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () =>
      Promise.all(
        instList.map((i) =>
          api.request<{ items: unknown[] }>("GET", `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items?limit=200`)
            .then((r) => ({ name: i.instance_name, label: i.display_name, total: r.items.length }))
            .catch(() => ({ name: i.instance_name, label: i.display_name, total: 0 })),
        ),
      ),
    enabled: instList.length > 0,
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const rows = instData.data ?? [];
  const total = items.length + rows.reduce((a, b) => a + b.total, 0);
  const states = items.reduce<Record<string, number>>((acc, m) => {
    const k = m.state ?? "—";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const top = Object.entries(states).slice(0, 2).map(([s, n]) => `${n} ${s}`).join(" · ");
  // Always land on the assets base page — same reasoning as machines: the base
  // page shows an instance chooser when its own list is empty but instances
  // exist, so the tile never dives into one instance and drops the rest.
  return (
    <DashboardTile
      to="/assets"
      icon={Sprout}
      label="assets"
      primary={total}
      empty={!q.isLoading && !insts.isLoading && !instData.isLoading && total === 0}
      secondary={rows.length > 0 ? rows.map((r) => r.label).join(" · ") : top || "none yet"}
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
      empty={!q.isLoading && items.length === 0}
    />
  );
}

// Order hints leave room for the module-registered tiles (inventory 10,
// projects 30, labels 60) to interleave in the default arrangement.
registerDashboardWidget({ module: "machines", order: 20, component: MachinesWidget });
registerDashboardWidget({ module: "assets", order: 40, component: AssetsWidget });
registerDashboardWidget({ module: "purchases", order: 50, component: PurchasesWidget });
