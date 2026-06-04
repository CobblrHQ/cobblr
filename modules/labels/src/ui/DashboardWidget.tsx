// Labels' "at a glance" dashboard tile — the print-queue length. Registered
// through platform-web's seam at ui-bundle load (the host imports
// @cobblr/labels/ui eagerly). Faithful 1:1 with the former host tile, incl. the
// shared "labels-queue" query key so the BasketWidget + QueuePage + this tile
// de-dupe one fetch. Mounted outside the module's provider, so it fetches with
// the injected getToken.

import { useQuery } from "@tanstack/react-query";
import { Tags } from "lucide-react";
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

function LabelsDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const q = useQuery({
    queryKey: ["labels-queue", slug],
    queryFn: () =>
      getJson<{ items: unknown[] }>(`/api/v1/orgs/${slug}/modules/labels/queue`, getToken),
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

registerDashboardWidget({ module: "labels", order: 60, component: LabelsDashboardWidget });
