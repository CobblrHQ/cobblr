import { useQuery } from "@tanstack/react-query";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { Package } from "lucide-react";
import type { FamilyPayload } from "./api";
import { countOf } from "@cobblr/platform-contract";
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

type Counts = { total: number; low: number; out?: number; stock_value?: number | null; currency?: string };
type Inst = { instance_name: string; display_name: string; is_default?: boolean };

const shortOf = (low: number, out: number) => [low > 0 && `${low} low-stock`, out > 0 && `${out} out of stock`].filter(Boolean).join(" · ");

/** What the stock cost, across the default collection and its named ones, in the shop's currency; nothing when no part has a cost (#8791). */
function worth(base: Counts | undefined, rows: ReadonlyArray<Counts>): string | null {
  const parts = [base, ...rows].filter((c): c is Counts => !!c && typeof c.stock_value === "number");
  if (!parts.length) return null;
  const currency = parts.find((c) => c.currency)?.currency;
  const text = formatStoredMoney(parts.reduce((n, c) => n + (c.stock_value ?? 0), 0), "amount", currency ? { currency } : undefined);
  return text ? `${text} in stock` : null;
}

function InventoryDashboardWidget({ slug, getToken }: DashboardWidgetProps) {
  const base = useQuery({
    queryKey: ["dash-inv-base", slug],
    queryFn: () => getJson<Counts>(`/api/v1/orgs/${slug}/modules/inventory/parts/dashboard`, getToken),
    enabled: !!slug, staleTime: 30_000,
  });
  const insts = useQuery({
    queryKey: ["dash-inv-insts", slug],
    queryFn: () => getJson<{ items: Inst[] }>(`/api/v1/orgs/${slug}/instances?module=inventory`, getToken),
    enabled: !!slug, staleTime: 30_000,
  });
  // registry-filter-ok: the base summary already counts the default collection.
  const instList = (insts.data?.items ?? []).filter((i) => !i.is_default && i.instance_name !== "inventory");
  const instData = useQuery({
    queryKey: ["dash-inv-instdata", slug, instList.map((i) => i.instance_name).sort().join(",")],
    queryFn: () => Promise.all(instList.map(async (i) => ({
      ...await getJson<Counts>(`/api/v1/orgs/${slug}/instances/${encodeURIComponent(i.instance_name)}/items/dashboard`, getToken),
      name: i.instance_name, label: i.display_name,
    }))),
    enabled: !!slug && instList.length > 0, staleTime: 30_000,
  });
  const rows = instData.data ?? [];
  const failed = base.isError || insts.isError || instData.isError;
  const ready = !failed && !!base.data && !!insts.data && (instList.length === 0 || !!instData.data);
  const total = (base.data?.total ?? 0) + rows.reduce((n, r) => n + r.total, 0);
  const low = (base.data?.low ?? 0) + rows.reduce((n, r) => n + r.low, 0);
  const out = (base.data?.out ?? 0) + rows.reduce((n, r) => n + (r.out ?? 0), 0);
  const biggest = [...rows].sort((a, b) => b.total - a.total)[0];
  return <DashboardTile
    to={(base.data?.total ?? 0) > 0 || !biggest ? "/inventory" : `/instances/${encodeURIComponent(biggest.name)}`}
    icon={Package} label="inventory" primary={ready ? total : "…"}
    empty={ready && total === 0} attention={ready && (low > 0 || out > 0)}
    secondary={failed ? "Couldn't load totals" : !ready ? "Loading totals" : low > 0 || out > 0
      ? <span className="text-ember-600 dark:text-ember-500">{shortOf(low, out)}</span>
      : [rows.length > 0 ? rows.map((r) => r.label).join(" · ") : "all stocked", worth(base.data, rows)].filter(Boolean).join(" · ")}
  />;
}

function InventoryInstanceTile(props: DashboardWidgetProps) {
  if (props.instance?.family) return <FamilyTile {...props} />;
  return <PlainInstanceTile {...props} />;
}

/** One tile for a type collection and its things (Filament): "3 spools ·
 *  2 types", and how many types are low, read from the family page's own
 *  numbers so the tile and the page cannot disagree. */
function FamilyTile({ slug, getToken, instance }: DashboardWidgetProps) {
  const name = instance?.instance_name ?? "";
  const q = useQuery({
    queryKey: ["dash-inv-family", slug, name],
    queryFn: () => getJson<FamilyPayload>(`/api/v1/orgs/${slug}/instances/${encodeURIComponent(name)}/items/family/all`, getToken),
    enabled: !!slug && !!instance,
    staleTime: 30_000,
  });
  if (!instance) return null;
  const d = q.isError ? undefined : q.data;
  const nouns = (n: number, one: string | null, fallback: string) => countOf(n, one ?? fallback);
  return (
    <DashboardTile
      to={`/instances/${encodeURIComponent(name)}`}
      icon={Package}
      label={instance.family!.label || instance.display_name}
      primary={d ? d.counts.children : "…"}
      empty={!!d && d.counts.children === 0 && d.counts.types === 0}
      secondary={
        d ? (
          <span data-testid="family-tile-counts" className={d.counts.low ? "text-ember-600 dark:text-ember-500" : undefined}>
            {nouns(d.counts.children, d.child_noun, "item")} · {nouns(d.counts.types, d.parent_noun, "type")}
            {d.counts.low ? ` · ${d.counts.low} low` : ""}
          </span>
        ) : (
          q.isError ? "Couldn't load totals" : "Loading totals"
        )
      }
      attention={!!d?.counts.low}
    />
  );
}

function PlainInstanceTile({ slug, getToken, instance }: DashboardWidgetProps) {
  const name = instance?.instance_name ?? "";
  const isDefault = instance?.is_default ?? false;
  const url = isDefault ? `/api/v1/orgs/${slug}/modules/inventory/parts/dashboard`
    : `/api/v1/orgs/${slug}/instances/${encodeURIComponent(name)}/items/dashboard`;
  const q = useQuery({
    queryKey: ["dash-inv-inst", slug, name],
    queryFn: () => getJson<Counts>(url, getToken),
    enabled: !!slug && !!instance, staleTime: 30_000,
  });
  if (!instance) return null;
  const d = q.isError ? undefined : q.data;
  return <DashboardTile
    to={isDefault ? "/inventory" : `/instances/${encodeURIComponent(name)}`}
    icon={Package} label={instance.display_name} primary={d?.total ?? "…"}
    empty={!!d && d.total === 0} attention={!!d && (d.low > 0 || (d.out ?? 0) > 0)}
    secondary={q.isError ? "Couldn't load totals" : !d ? "Loading totals" : d.low > 0 || (d.out ?? 0) > 0
      ? <span className="text-ember-600 dark:text-ember-500">{shortOf(d.low, d.out ?? 0)}</span> : "all stocked"}
  />;
}

registerDashboardWidget({
  module: "inventory",
  order: 10,
  component: InventoryDashboardWidget,
  instanceTile: InventoryInstanceTile,
});
