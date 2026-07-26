// Price history — what you've paid for one thing, every time, and whether it
// moved. Contributed by purchases onto inventory:part through the panel seam
// (manifest contributes.panels → platform-web's detail-panel registry), so the
// part page never names purchases and a workspace without purchases sees
// nothing.
//
// Renders NOTHING for a part that was never bought: an empty "no purchases"
// box on every part page would be noise on the 95% of parts nobody buys twice.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { api, type PurchasePricePoint, type PurchasePriceStats } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function day(iso: string | null): string {
  if (!iso) return "undated";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The headline: latest price + how it moved since the purchase before it. */
function ChangeChip({ stats }: { stats: PurchasePriceStats }) {
  if (stats.direction === null) return null;
  const up = stats.direction === "up";
  const flat = stats.direction === "flat";
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  // Cheaper is good news, dearer is a warning — the colour carries the verdict
  // so the number doesn't have to be read to get the gist.
  const tone = flat
    ? "text-muted bg-subtle dark:bg-slate-800"
    : up
      ? "text-amber-700 dark:text-amber-400 bg-amber-500/10"
      : "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10";
  const pct = stats.change_pct === null ? null : `${stats.change_pct > 0 ? "+" : ""}${stats.change_pct}%`;
  const abs = stats.change_abs === null ? null : `${stats.change_abs > 0 ? "+" : ""}${money(stats.change_abs)}`;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono ${tone}`}>
      <Icon size={12} aria-hidden />
      {flat ? "same as last time" : `${abs}${pct ? ` (${pct})` : ""}`}
    </span>
  );
}

/** Dependency-free sparkline over the priced purchases, oldest → newest. */
function Spark({ points }: { points: PurchasePricePoint[] }) {
  const vals = points
    .map((p) => p.unit_cost)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 2) return null;
  const W = 240;
  const H = 40;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / (vals.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10" role="img" aria-label="Unit price over time">
      <path d={path} fill="none" className="stroke-cobble-500" strokeWidth={1.5} />
      {vals.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={1.8} className="fill-cobble-600" />
      ))}
    </svg>
  );
}

export function PriceHistoryPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const q = useQuery({
    queryKey: ["purchases-price-history", ctx.slug, ctx.entityId],
    queryFn: () => api.purchasesPriceHistory(ctx.slug, ctx.entityId),
    // A part that has never been bought is the common case; don't retry the
    // (perfectly successful) empty answer.
    staleTime: 60_000,
  });

  const items = q.data?.items ?? [];
  const stats = q.data?.stats;
  if (!stats || items.length === 0) return null;

  const head = "text-[10px] font-mono uppercase tracking-widest text-accent";
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className={head}>// price history</div>
        <div className="text-[11px] text-faint font-mono">
          {stats.purchases} purchase{stats.purchases === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-mono text-content dark:text-mortar-100">{money(stats.latest)}</span>
        <span className="text-xs text-muted">last paid {day(stats.last_purchased_at)}</span>
        <ChangeChip stats={stats} />
      </div>

      <Spark points={items} />

      {/* Boxed rows: one purchase per line, newest first — the receipt trail
          behind the number above. Each links to the order it came from. */}
      <div className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-800 rounded-lg overflow-hidden">
        {[...items].reverse().map((p) => (
          <Link
            key={p.id}
            to={`/purchases/${p.order_id}`}
            className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs hover:bg-subtle dark:hover:bg-slate-800"
          >
            <span className="text-muted shrink-0 font-mono">{day(p.purchased_at)}</span>
            <span className="truncate text-content dark:text-mortar-100 flex-1 min-w-0">
              {p.vendor ?? "(no vendor)"}
              {p.qty !== 1 ? <span className="text-faint"> · ×{p.qty}</span> : null}
            </span>
            <span className="font-mono shrink-0 text-content dark:text-mortar-100">{money(p.unit_cost)}</span>
          </Link>
        ))}
      </div>

      {stats.priced > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted font-mono">
          <span>low {money(stats.min)}</span>
          <span>avg {money(stats.avg)}</span>
          <span>high {money(stats.max)}</span>
          <span>spent {money(stats.total_spent)}</span>
        </div>
      )}
    </div>
  );
}
