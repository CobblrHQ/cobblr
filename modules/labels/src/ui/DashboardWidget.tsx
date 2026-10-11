import { useQuery } from "@tanstack/react-query";
import { Tags } from "lucide-react";
import {
  DashboardTile,
  registerDashboardWidget,
  type DashboardWidgetProps,
  workspaceFetch,
} from "@cobblr/platform-web";

async function getJson<T>(url: string, getToken: () => string | null): Promise<T> {
  const token = getToken();
  const r = await workspaceFetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function LabelsDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const q = useQuery({
    queryKey: ["dash-labels-count", slug],
    queryFn: () =>
      getJson<{ total: number }>(`/api/v1/orgs/${slug}/modules/labels/queue/count`, getToken),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const queued = q.data?.total ?? 0;
  return (
    <DashboardTile
      to="/labels"
      icon={Tags}
      label="labels"
      primary={!q.isError && q.data ? queued : "…"}
      empty={!q.isError && !!q.data && queued === 0}
      secondary={q.isError ? "Couldn't load totals" : !q.data ? "Loading totals" : queued === 0 ? "queue empty" : "in queue"}
    />
  );
}

registerDashboardWidget({ module: "labels", order: 60, component: LabelsDashboardWidget });
