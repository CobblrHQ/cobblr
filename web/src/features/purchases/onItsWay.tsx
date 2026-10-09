// On its way: what a record (or a receipt's row in the scan inbox) is still
// waiting to receive, and where it is (#5351). Contributed by purchases onto
// parts, assets and scan inbox rows through the panel seam, so none of those
// pages names purchases.
//
// Renders NOTHING once nothing is still coming: a record that arrived, or was
// never bought, has nothing to say here.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Truck } from "lucide-react";
import { api } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { parcelWords } from "./parcelWords";

export function OnItsWayPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  // A receipt's row knows its order line before it is any record.
  const lineId = ctx.hints?.receipt_order_item_id;
  const kind = ctx.kind ?? "";
  const q = useQuery({
    queryKey: ["purchases-incoming", ctx.slug, lineId ?? `${kind}:${ctx.entityId}`],
    queryFn: () => api.purchasesIncoming(ctx.slug, lineId ? { line_id: lineId } : { kind, id: ctx.entityId }),
    enabled: !!lineId || !!kind,
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it.line_id} className="flex items-start gap-2 text-sm text-content dark:text-mortar-100">
          <Truck size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0">
            <span className="block">{it.not_shipped ? "Not shipped yet" : parcelWords(it.tracking_number ? it : { tracking_number: null, expected_arrival: it.expected_arrival })}</span>
            <Link to={`/purchases/${it.order_id}`} className="block text-xs text-muted hover:text-accent break-words">
              {[it.vendor, it.order_number ? `#${it.order_number}` : null].filter(Boolean).join(" ") || "The order"}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}
