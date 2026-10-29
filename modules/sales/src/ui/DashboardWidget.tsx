// What the shop is owed, on Home (#8838): the sum of what is still to be paid across the
// orders, the same figure the month's summary and the accountant's file carry, and who
// owes it one tap away.
import { useQuery } from "@tanstack/react-query";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { ShoppingCart } from "lucide-react";
import { DashboardTile, registerDashboardWidget, workspaceFetch, type DashboardWidgetProps } from "@cobblr/platform-web";
import type { OwedView } from "./api";

async function getOwed(slug: string, getToken: () => string | null): Promise<OwedView> {
  const token = getToken();
  const r = await workspaceFetch(`/api/v1/orgs/${slug}/modules/sales/orders/owed`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<OwedView>;
}

function SalesOwedWidget({ slug, getToken }: DashboardWidgetProps) {
  const q = useQuery({ queryKey: ["sales-owed", slug], queryFn: () => getOwed(slug, getToken), enabled: !!slug, staleTime: 30_000 });
  const rows = q.data?.by_currency ?? [];
  const say = (r: { currency: string; owed: number }) => formatStoredMoney(r.owed, "amount", { currency: r.currency }) ?? String(r.owed);
  const orders = rows.reduce((n, r) => n + r.orders, 0);
  return <DashboardTile
    to="/sales"
    icon={ShoppingCart} label="owed to you"
    primary={q.isError ? "…" : !q.data ? "…" : rows.length === 0 ? "0" : rows.map(say).join(" + ")}
    empty={false} attention={orders > 0}
    secondary={q.isError ? "Couldn't load what you are owed" : !q.data ? "Loading" : orders > 0 ? `${orders} ${orders === 1 ? "order" : "orders"} still to pay` : "nobody owes you"}
  />;
}

registerDashboardWidget({ module: "sales", order: 20, component: SalesOwedWidget });
