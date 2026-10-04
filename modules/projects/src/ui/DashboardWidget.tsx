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

type Counts = { total: number; active: number };
type PInst = { instance_name: string; display_name: string; is_default?: boolean };

function ProjectsDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const projects = useQuery({
    queryKey: ["dash-projects", slug],
    queryFn: () => getJson<Counts>(`/api/v1/orgs/${slug}/modules/projects/projects/dashboard`, getToken),
    enabled: !!slug, staleTime: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["dash-tasks-blocked", slug],
    queryFn: () => getJson<{ blocked: number }>(`/api/v1/orgs/${slug}/modules/projects/tasks/dashboard`, getToken),
    enabled: !!slug, staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-proj-insts", slug],
    queryFn: () => getJson<{ items: PInst[] }>(`/api/v1/orgs/${slug}/instances?module=projects`, getToken),
    enabled: !!slug, staleTime: 30_000,
  });
  // registry-filter-ok: the base summary already counts the default collection.
  const instList = (insts.data?.items ?? []).filter((i) => !i.is_default && i.instance_name !== "projects");
  const instData = useQuery({
    queryKey: ["dash-proj-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () => Promise.all(instList.map(async (i) => ({
      ...await getJson<Counts>(`/api/v1/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items/dashboard`, getToken),
      name: i.instance_name, label: i.display_name,
    }))),
    enabled: !!slug && instList.length > 0, staleTime: 30_000,
  });
  const rows = instData.data ?? [];
  const failed = projects.isError || blocked.isError || insts.isError || instData.isError;
  const ready = !failed && !!projects.data && !!blocked.data && !!insts.data && (instList.length === 0 || !!instData.data);
  const total = (projects.data?.total ?? 0) + rows.reduce((n, r) => n + r.total, 0);
  const active = (projects.data?.active ?? 0) + rows.reduce((n, r) => n + r.active, 0);
  const blockedCount = blocked.data?.blocked ?? 0;
  const biggest = [...rows].sort((a, b) => b.total - a.total)[0];
  return <DashboardTile
    to={(projects.data?.total ?? 0) > 0 || !biggest ? "/projects" : `/instances/${encodeURIComponent(biggest.name)}`}
    icon={ListChecks} label="projects" primary={ready ? active : "…"} primaryNoun="active"
    empty={ready && total === 0} attention={ready && blockedCount > 0}
    secondary={failed ? "Couldn't load totals" : !ready ? "Loading totals" : blockedCount > 0
      ? <span className="text-ember-600 dark:text-ember-500">{blockedCount} blocked</span>
      : rows.length > 0 ? rows.map((r) => r.label).join(" · ") : `${total} total`}
  />;
}

function ProjectsInstanceTile({ slug, getToken, instance }: DashboardWidgetProps) {
  const name = instance?.instance_name ?? "";
  const isDefault = instance?.is_default ?? false;
  const url = isDefault ? `/api/v1/orgs/${slug}/modules/projects/projects/dashboard`
    : `/api/v1/orgs/${slug}/instances/${encodeURIComponent(name)}/items/dashboard`;
  const q = useQuery({
    queryKey: ["dash-proj-inst", slug, name],
    queryFn: () => getJson<Counts>(url, getToken),
    enabled: !!slug && !!instance, staleTime: 30_000,
  });
  if (!instance) return null;
  const d = q.isError ? undefined : q.data;
  return <DashboardTile
    to={isDefault ? "/projects" : `/instances/${encodeURIComponent(name)}`}
    icon={ListChecks} label={instance.display_name} primary={d?.total ?? "…"}
    empty={!!d && d.total === 0}
    secondary={q.isError ? "Couldn't load totals" : !d ? "Loading totals" : `${d.active} active`}
  />;
}

registerDashboardWidget({ module: "projects", order: 30, component: ProjectsDashboardWidget, instanceTile: ProjectsInstanceTile });
