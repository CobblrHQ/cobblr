// "This receipt lists N other items" — on the scan card, contributed.
//
// Attaching a receipt to one item records EVERY line on the order, because a
// receipt is a document and documents live in Purchases. The other lines are
// not things you own though — most of a grocery order is eaten — so they sit
// unclaimed until somebody says otherwise. This is what tells you they are
// there, at the only moment the count is known.
//
// WHAT IT DOES NOT DO: reach into core-scan. The host hands over its own
// receipt group id as a hint and nothing else; this looks up the order PURCHASES
// created carrying that id, in purchases' own data. The scan card, for its part,
// renders whatever declared into it and never names this file. That is the
// `contributes.panels` seam doing the job it was built for — the same one that
// puts price history on a part page without inventory naming purchases.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { api } from "../../lib/api";
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";

export function ReceiptLinesPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const groupId = ctx.hints?.receipt_group_id;
  const [open, setOpen] = useState(false);

  // The order this receipt became. Found by the host's OWN identifier, which is
  // the only thing crossing the seam.
  const q = useQuery({
    queryKey: ["purchases-order-for-receipt", ctx.slug, groupId],
    queryFn: () => api.findPurchaseOrderByReceiptGroup(ctx.slug, groupId!),
    enabled: !!groupId,
    staleTime: 30_000,
  });


  if (!groupId || q.isLoading || !q.data) return null;
  // Unclaimed = recorded on the order, not yet anything you own.
  const unclaimed = (q.data.items ?? []).filter((l) => !l.part_id);
  if (unclaimed.length === 0) return null;

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/30 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs text-muted hover:text-content dark:hover:text-mortar-100"
      >
        <Receipt size={13} className="shrink-0 text-faint" />
        <span className="flex-1 min-w-0 truncate">
          This receipt lists {unclaimed.length} other item{unclaimed.length === 1 ? "" : "s"}
        </span>
        <span className="shrink-0 text-faint">{open ? "hide" : "look"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 border-t border-line/60 dark:border-slate-700/60 pt-2">
          {unclaimed.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-[13px]">
              <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">
                {l.description}
              </span>
              {/* No "keep this too" button yet, deliberately. What a promoted
                  line should BECOME is an open question — an inbox row to
                  triage like any capture, or a part directly — and a button
                  that picks one quietly is worse than a list that shows you
                  what is there. Reading is the whole value on its own: you can
                  see the rest of the receipt without leaving the card. */}
              <span className="shrink-0 text-faint text-[11px]">
                {l.qty}
                {l.unit_cost != null ? ` × ${l.unit_cost}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
