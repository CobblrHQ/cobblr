import { useQuery } from "@tanstack/react-query";
import { Wrench, Sprout, ShoppingCart } from "lucide-react";
import { DashboardTile, registerDashboardWidget, summaryLine } from "@cobblr/platform-web";
import { api } from "../lib/api";

type Counts = { total: number; states: Array<{ state: string | null; count: number }> };

function RegisterWidget({ slug, module, icon }: { slug: string; module: "assets" | "machines"; icon: typeof Wrench }) {
  const q = useQuery({
    queryKey: [`dash-${module}`, slug],
    queryFn: () => api.request<Counts>("GET", `/orgs/${slug}/modules/${module}/${module}/dashboard`),
    enabled: !!slug, staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: [`dash-${module}-insts`, slug],
    queryFn: () => api.listInstances(slug, module),
    enabled: !!slug, staleTime: 30_000,
  });
  // registry-filter-ok: the base summary already counts the default collection.
  const instList = (insts.data?.items ?? []).filter((i) => !i.is_default && i.instance_name !== module);
  const instData = useQuery({
    queryKey: [`dash-${module}-instdata`, slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () => Promise.all(instList.map(async (i) => ({
      ...await api.request<Counts>("GET", `/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items/dashboard`),
      name: i.instance_name, label: i.display_name,
    }))),
    enabled: !!slug && instList.length > 0, staleTime: 30_000,
  });
  const rows = instData.data ?? [];
  const failed = q.isError || insts.isError || instData.isError;
  const ready = !failed && !!q.data && !!insts.data && (instList.length === 0 || !!instData.data);
  const total = (q.data?.total ?? 0) + rows.reduce((n, r) => n + r.total, 0);
  const top = (q.data?.states ?? []).slice(0, 2).map((r) => `${r.count} ${r.state || "unknown"}`).join(" · ");
  return <DashboardTile
    to={`/${module}`} icon={icon} label={module} primary={ready ? total : "…"}
    empty={ready && total === 0}
    secondary={failed ? "Couldn't load totals" : !ready ? "Loading totals" : rows.length > 0
      ? summaryLine(rows.map((r) => r.label)) : top || "none yet"}
  />;
}

function MachinesWidget({ slug }: { slug: string }) {
  return <RegisterWidget slug={slug} module="machines" icon={Wrench} />;
}
function AssetsWidget({ slug }: { slug: string }) {
  return <RegisterWidget slug={slug} module="assets" icon={Sprout} />;
}
function PurchasesWidget({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-orders", slug],
    queryFn: () => api.request<{ total: number; open: number }>("GET", `/orgs/${slug}/modules/purchases/orders/dashboard`),
    enabled: !!slug, staleTime: 30_000,
  });
  const d = q.isError ? undefined : q.data;
  return <DashboardTile
    to="/purchases" icon={ShoppingCart} label="purchases" primary={d?.open ?? "…"} primaryNoun="open"
    empty={!!d && d.total === 0}
    secondary={q.isError ? "Couldn't load totals" : !d ? "Loading totals" : d.open === d.total ? "all open" : `${d.total} total`}
  />;
}

registerDashboardWidget({ module: "machines", order: 20, component: MachinesWidget });
registerDashboardWidget({ module: "assets", order: 40, component: AssetsWidget });
registerDashboardWidget({ module: "purchases", order: 50, component: PurchasesWidget });
