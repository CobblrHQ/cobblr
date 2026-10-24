// Stock here: what one place carries, across every collection. Contributed by
// inventory onto a location's page through the panel seam, so the place page
// never names inventory. Each line is the count at this place against the
// minimum kept here, whether it is low, and when the soonest of it goes off,
// the same reading the record's own page gives.
//
// Each line carries a −/+ (the shared StockStepper) that takes one off or
// puts one back AT THIS PLACE: the ledgered stock adjust on that line's own
// record, never its card, so scanning a shelf's label and tapping − moves the
// shelf and nothing else. A line inside a sub-place says which one.
//
// Renders nothing for a place that holds no stock: the page's "what's here"
// already says so.

import { quantityNumber } from "@cobblr/platform-contract/quantity-number";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { expiryPhrase, expiryState } from "@cobblr/platform-contract/expiry-grace";
import type { Day } from "@cobblr/platform-contract/day";
import { api, getToken, type StockPlaceRow } from "../../lib/api";
import { StockStepper, refreshAfterStockChange } from "@cobblr/platform-web";
import { useKindLabels } from "../../lib/useKindLabels";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { InventoryApi, WhatsStillHereButton } from "@cobblr/inventory/ui";

import { countOf } from "@cobblr/platform-contract/plural";
function fmt(n: number): string {
  return quantityNumber(n);
}

function offWords(expiresOn: string | null, today: string): string | null {
  if (!expiresOn) return null;
  const r = expiryState(expiresOn, 0, today as Day);
  return r ? expiryPhrase(r) : null;
}

function Row({ r, today, slug, here }: { r: StockPlaceRow; today: string; slug: string; here: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const off = offWords(r.expires_on, today);
  const inside = r.location_id && r.location_id !== here ? r.location_name : null;
  const step = async (delta: number) => {
    const out = await api.stockAdjustAt(slug, r.instance, r.id, delta);
    void refreshAfterStockChange(qc, [r.id]);
    return Number(out.qty);
  };
  return (
    <li className="px-3 py-2 text-sm" data-testid="stock-here-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={r.detail_path} className="flex-1 min-w-0 basis-40 truncate text-content dark:text-mortar-100 hover:text-accent">
          {inside && <span className="text-muted dark:text-slate-400">{inside} · </span>}
          {r.name}
        </Link>
        <span className="inline-flex items-center gap-2">
          <StockStepper qty={r.qty} unit={r.unit} onStep={step} label={r.name} />
          {r.min_qty != null ? (
            <span className="font-mono text-xs text-faint" title="The minimum kept here">
              / {fmt(r.min_qty)}
            </span>
          ) : null}
        </span>
        {r.low && (
          <span className="inline-flex items-center gap-1 text-[10px] text-ember-600 dark:text-ember-400 border border-ember-200 dark:border-ember-800 rounded px-1.5 py-0.5">
            <AlertTriangle size={10} /> low
          </span>
        )}
        {off && <span className="font-mono text-[11px] text-muted dark:text-slate-400">{off}</span>}
        {r.lots.length > 1 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[11px] text-accent hover:underline">
            {open ? "Hide" : "Show"} {countOf(r.lots.length, "lot")}
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 pl-3 text-[11px] font-mono text-muted dark:text-slate-400">
          {r.lots.map((l, i) => (
            // Among numbered lots one without says "batch unknown"; among
            // lots none of which is dated (a spool's batches), none says "no date".
            <li key={i}>
              {[
                fmt(l.qty),
                l.lot ? `lot ${l.lot}` : r.lots.some((x) => x.lot) ? "batch unknown" : null,
                offWords(l.expires_on, today) ?? (r.lots.some((x) => x.expires_on) || !r.lots.some((x) => x.lot) ? "no date" : null),
              ]
                .filter(Boolean)
                .join(" · ")}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function StockHerePanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const labels = useKindLabels(ctx.slug);
  const inventory = useMemo(() => new InventoryApi(ctx.slug, { getToken }), [ctx.slug]);
  const q = useQuery({
    queryKey: ["stock-at", ctx.slug, ctx.entityId],
    queryFn: () => api.stockAt(ctx.slug, ctx.entityId),
  });
  if (!q.data || q.data.items.length === 0) return null;
  const { items, today, low, expiring } = q.data;
  // Low first, then soonest to go off, then by name: what needs doing on top.
  const sorted = [...items].sort(
    (a, b) =>
      Number(b.low) - Number(a.low) ||
      (a.expires_on ?? "9999").localeCompare(b.expires_on ?? "9999") ||
      a.name.localeCompare(b.name),
  );
  const byCollection = new Map<string, StockPlaceRow[]>();
  for (const r of sorted) byCollection.set(r.kind, [...(byCollection.get(r.kind) ?? []), r]);
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3" data-testid="stock-here">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="text-[10px] uppercase tracking-widest text-accent">stock here</div>
        <span className="text-xs text-muted dark:text-slate-400">
          {items.length} {items.length === 1 ? "thing" : "things"}
          {low ? ` · ${low} low` : ""}
          {expiring ? ` · ${expiring} going off within 30 days` : ""}
        </span>
        <span className="ml-auto">
          <WhatsStillHereButton api={inventory} slug={ctx.slug} scope={{ place_id: ctx.entityId }} label={ctx.entityTitle} />
        </span>
      </div>
      {[...byCollection.entries()].map(([kind, rows]) => (
        <div key={kind}>
          {byCollection.size > 1 && (
            <div className="text-[10px] uppercase tracking-widest text-faint mb-1">{labels.collection(kind)}</div>
          )}
          <ul className="divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700">
            {rows.map((r) => (
              <Row key={r.id} r={r} today={today} slug={ctx.slug} here={ctx.entityId} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
