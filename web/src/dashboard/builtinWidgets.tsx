// The host's built-in "at a glance" widgets — one per first-party module that
// has a glanceable number. They register through the SAME public seam a
// bundle / third-party module uses (`registerDashboardWidget`), so the
// Dashboard itself has no per-module knowledge: it just renders whatever's
// registered for an enabled module. This file is imported for its side effect
// (the register calls) by Dashboard.tsx.
//
// The fetch + compute logic here is a 1:1 move of what used to live inline in
// Dashboard.tsx, so nothing about the numbers changed — only WHERE they're
// declared. Follow-up (BACKLOG): the three PACKAGED modules' widgets
// (inventory/labels/projects) can migrate into their own `@cobblr/<m>/ui`
// bundles now that the seam exists; machines/assets/purchases have no packaged
// UI (their pages live in the host) so they stay here.

import { useQuery } from "@tanstack/react-query";
import { Package, Wrench, ListChecks, Sprout, ShoppingCart, Tags } from "lucide-react";
import { DashboardTile, registerDashboardWidget } from "@cobblr/platform-web";
import { api } from "../lib/api";

function InventoryWidget({ slug }: { slug: string }) {
  // One fetch — the list endpoint returns `low_stock` per row, so both numbers
  // come from one payload instead of two full-list queries.
  const all = useQuery({
    queryKey: ["dash-inv-all", slug],
    queryFn: () =>
      api.request<{ items: Array<{ low_stock?: boolean }> }>(
        "GET",
        `/orgs/${slug}/modules/inventory/parts?limit=200`,
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

function ProjectsWidget({ slug }: { slug: string }) {
  const projects = useQuery({
    queryKey: ["dash-projects", slug],
    queryFn: () =>
      api.request<{ items: Array<{ status: string }> }>(
        "GET",
        `/orgs/${slug}/modules/projects/projects?limit=200`,
      ),
    staleTime: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["dash-tasks-blocked", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>(
        "GET",
        `/orgs/${slug}/modules/projects/tasks?blocked=1&limit=200`,
      ),
    staleTime: 30_000,
  });
  const all = projects.data?.items ?? [];
  const active = all.filter((p) => p.status === "active").length;
  const blockedCount = blocked.data?.items.length ?? 0;
  return (
    <DashboardTile
      to="/projects"
      icon={ListChecks}
      label="projects"
      primary={active}
      secondary={
        blockedCount > 0 ? (
          <span className="text-ember-600 dark:text-ember-500">{blockedCount} blocked</span>
        ) : (
          `${all.length} total`
        )
      }
      attention={blockedCount > 0}
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

function LabelsWidget({ slug }: { slug: string }) {
  // Shared query key with BasketWidget + QueuePage so React Query de-dupes
  // the request in flight (one fetch, three consumers).
  const q = useQuery({
    queryKey: ["labels-queue", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>("GET", `/orgs/${slug}/modules/labels/queue`),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const queued = q.data?.items.length ?? 0;
  return (
    <DashboardTile
      to="/labels"
      icon={Tags}
      label="labels"
      primary={queued}
      secondary={queued === 0 ? "queue empty" : "in queue"}
    />
  );
}

// Registration order mirrors the old hardcoded tile order.
registerDashboardWidget({ module: "inventory", order: 10, component: InventoryWidget });
registerDashboardWidget({ module: "machines", order: 20, component: MachinesWidget });
registerDashboardWidget({ module: "projects", order: 30, component: ProjectsWidget });
registerDashboardWidget({ module: "assets", order: 40, component: AssetsWidget });
registerDashboardWidget({ module: "purchases", order: 50, component: PurchasesWidget });
registerDashboardWidget({ module: "labels", order: 60, component: LabelsWidget });
