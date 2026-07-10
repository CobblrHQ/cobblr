// /portal/:slug/locations/:id/plan — a location's floor plan for portal
// members, read-only. Reuses the print renderer (a clean paper card reads
// fine on the portal's chrome); a house shows every floor stacked. Admins
// link this from the portal welcome markdown — no config surface needed.

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type Location } from "../lib/api";
import { readBound } from "../lib/floorplanGeometry";
import { PrintPlan } from "./PlanPrintPage";

export function PortalPlanPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const locs = useQuery({
    queryKey: ["core-locations", slug],
    queryFn: () => api.listLocations(slug!),
    enabled: !!slug,
  });
  const items = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l] as const)), [items]);
  const root = id ? byId.get(id) : undefined;
  usePageTitle(root ? `${root.name} — plan` : "Plan");

  if (locs.isLoading) return <div className="p-6 text-sm text-muted">Loading…</div>;
  if (!root) return <div className="p-6 text-sm text-muted">Location not found.</div>;

  const rootBound = readBound(root.metadata);
  const plans: Location[] = rootBound
    ? [root]
    : items.filter((l) => l.parent_id === root.id && l.kind === "area" && readBound(l.metadata));

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <h1 className="text-lg font-semibold text-content dark:text-mortar-100">{root.name}</h1>
      {plans.length === 0 && (
        <p className="text-sm text-muted dark:text-slate-400">No plan drawn for this location yet.</p>
      )}
      <div className="rounded-xl bg-white p-4 space-y-2">
        {plans.map((p) => (
          <PrintPlan key={p.id} owner={p} items={items} byId={byId} multi={plans.length > 1} />
        ))}
      </div>
    </div>
  );
}
