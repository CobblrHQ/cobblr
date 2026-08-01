// THE workspace-content signal. Every "does this workspace have anything yet?"
// gate reads this one hook — the first-run hero, the bundle-suggestion nudge,
// the empty-state furniture (pinned-views ghost, recent activity), and the
// guided tour's auto-open — so they always agree and the probe runs ONCE
// (shared query key). Two copy-pasted probes under different keys preceded it
// (new-user-flow.md F3). `ready` is false while loading: render nothing, not
// the empty state, or furniture flashes on reload.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** One limit=1 read per enabled domain module + each named instance; cached.
 *  Named instances are counted because most flagship bundles keep ALL their
 *  data in instances — without them a populated workspace read as empty and
 *  the first-run hero never went away. */
export async function probeWorkspaceItemCount(slug: string, enabled: Set<string>): Promise<number> {
  const wrap = (path: string) =>
    api.request<{ items: unknown[] }>("GET", `/orgs/${slug}${path}`).then((r) => r.items.length).catch(() => 0);
  const probes: Array<Promise<number>> = [];
  if (enabled.has("inventory")) probes.push(wrap("/modules/inventory/parts?limit=1"));
  if (enabled.has("machines")) probes.push(wrap("/modules/machines/machines?limit=1"));
  if (enabled.has("assets")) probes.push(wrap("/modules/assets/assets?limit=1"));
  if (enabled.has("projects")) probes.push(wrap("/modules/projects/projects?limit=1"));
  if (enabled.has("purchases")) probes.push(wrap("/modules/purchases/orders?limit=1"));
  const instances = await api.listInstances(slug).then((r) => r.items).catch(() => []);
  // NAMED instances only: default instances are covered by the module probes
  // above, and the defaults of core-* capability modules have no items router
  // at all — probing them 501s on every dashboard load.
  for (const inst of instances.filter((i) => !i.is_default))
    probes.push(wrap(`/instances/${encodeURIComponent(inst.instance_name)}/items?limit=1`));
  const counts = await Promise.all(probes);
  return counts.reduce((a, b) => a + b, 0);
}

/** Pass "" as `slug` to keep the probe fully idle (e.g. off the dashboard). */
export function useWorkspaceContentProbe(slug: string): { ready: boolean; hasContent: boolean } {
  const mods = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    staleTime: 30_000,
    enabled: !!slug,
  });
  const enabled = useMemo(
    () => new Set((mods.data?.items ?? []).filter((m) => m.enabled).map((m) => m.name)),
    [mods.data],
  );
  const probeQ = useQuery({
    queryKey: ["dash-content-probe", slug, Array.from(enabled).sort().join(",")],
    queryFn: () => probeWorkspaceItemCount(slug, enabled),
    enabled: !!slug && enabled.size > 0,
    staleTime: 60_000,
  });
  // Zero modules = empty by definition, known as soon as the module list loads.
  const ready = mods.data !== undefined && (enabled.size === 0 || probeQ.data !== undefined);
  return { ready, hasContent: (probeQ.data ?? 0) > 0 };
}
