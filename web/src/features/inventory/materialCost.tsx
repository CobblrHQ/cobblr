import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { QueryError } from "@cobblr/platform-web";
import { api } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";

export function MaterialCostPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const q = useQuery({ queryKey: ["material-cost", ctx.slug, ctx.kind, ctx.entityId], queryFn: () => api.materialCost(ctx.slug, ctx.kind!, ctx.entityId), enabled: !!ctx.kind });
  if (q.isError) return <QueryError what="filament use" onRetry={() => { void q.refetch(); }} />;
  if (!q.data?.items.length) return null;
  return <section className="rounded-xl border border-line p-3 space-y-2" data-testid="material-cost">
    <h3 className="text-sm font-semibold">Filament used</h3>
    <ul className="space-y-2 text-sm">{q.data.items.map((r) => <li key={r.id} className="flex flex-wrap gap-2">
      <Link className="text-accent flex-1 min-w-0" to={openRecordPath("inventory:part", r.id)}>{r.name}</Link>
      <span>{r.grams.toLocaleString(undefined, { maximumFractionDigits: 2 })} g</span>
      {r.cost && <span>{formatMoney(centsFromAmount(r.cost.amount), { currency: r.cost.currency })}</span>}
    </li>)}</ul>
    <p className="text-xs text-muted">Cost estimates use the type's current price per kg. Set a price on the filament type to see its estimate here.</p>
  </section>;
}
