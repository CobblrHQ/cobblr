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

function ProjectsDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const projects = useQuery({
    queryKey: ["dash-projects", slug],
    queryFn: () =>
      getJson<{ items: Array<{ status: string }> }>(
        `/api/v1/orgs/${slug}/modules/projects/projects?limit=200`,
        getToken,
      ),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["dash-tasks-blocked", slug],
    queryFn: () =>
      getJson<{ items: unknown[] }>(
        `/api/v1/orgs/${slug}/modules/projects/tasks?blocked=1&limit=200`,
        getToken,
      ),
    enabled: !!slug,
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

registerDashboardWidget({ module: "projects", order: 30, component: ProjectsDashboardWidget });
