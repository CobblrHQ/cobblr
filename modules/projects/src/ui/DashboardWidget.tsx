// Projects' "at a glance" dashboard tile — active projects, with a blocked-task
// signal. Registered through platform-web's seam at ui-bundle load (the host
// imports @cobblr/projects/ui eagerly). Faithful 1:1 with the former host tile:
// same two endpoints (incl. `tasks?blocked=1`, which filters dependency-blocked
// tasks — NOT status=blocked), same query keys, same compute. Mounted outside
// the module's provider, so it fetches with the injected getToken.

import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
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

type Proj = { status: string };
type PInst = { instance_name: string; display_name: string };

function ProjectsDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  // Base projects + every projects INSTANCE (Designs, Outfits…). Instances keep
  // their items under /instances/<name>/items, so a Designs/Outfits workspace
  // showed "0 active" off the base list alone — count them all.
  const projects = useQuery({
    queryKey: ["dash-projects", slug],
    queryFn: () => getJson<{ items: Proj[] }>(`/api/v1/orgs/${slug}/modules/projects/projects?limit=200`, getToken).catch(() => ({ items: [] })),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["dash-tasks-blocked", slug],
    queryFn: () => getJson<{ items: unknown[] }>(`/api/v1/orgs/${slug}/modules/projects/tasks?blocked=1&limit=200`, getToken).catch(() => ({ items: [] })),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-proj-insts", slug],
    queryFn: () => getJson<{ items: PInst[] }>(`/api/v1/orgs/${slug}/instances?module=projects`, getToken).catch(() => ({ items: [] })),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const instList = insts.data?.items ?? [];
  const instData = useQuery({
    queryKey: ["dash-proj-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () =>
      Promise.all(
        instList.map((i) =>
          getJson<{ items: Proj[] }>(`/api/v1/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items?limit=200`, getToken)
            .then((r) => ({ name: i.instance_name, label: i.display_name, total: r.items.length, active: r.items.filter((p) => p.status === "active").length }))
            .catch(() => ({ name: i.instance_name, label: i.display_name, total: 0, active: 0 })),
        ),
      ),
    enabled: !!slug && instList.length > 0,
    staleTime: 30_000,
  });
  const base = projects.data?.items ?? [];
  const rows = instData.data ?? [];
  const active = base.filter((p) => p.status === "active").length + rows.reduce((a, b) => a + b.active, 0);
  const total = base.length + rows.reduce((a, b) => a + b.total, 0);
  const blockedCount = blocked.data?.items.length ?? 0;
  const biggest = [...rows].sort((a, b) => b.total - a.total)[0];
  const to = base.length > 0 || !biggest ? "/projects" : `/instances/${biggest.name}`;
  return (
    <DashboardTile
      to={to}
      icon={ListChecks}
      label="projects"
      primary={active}
      secondary={
        blockedCount > 0 ? (
          <span className="text-ember-600 dark:text-ember-500">{blockedCount} blocked</span>
        ) : rows.length > 0 ? (
          rows.map((r) => r.label).join(" · ")
        ) : (
          `${total} total`
        )
      }
      attention={blockedCount > 0}
    />
  );
}

registerDashboardWidget({ module: "projects", order: 30, component: ProjectsDashboardWidget });
