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


  // The host says whether the rest of the receipt is already on screen as its
  // own inbox rows. When it is, this has nothing to add: it would count the
  // cards either side of it, once per card.
  if (ctx.hints?.siblings_visible === "yes") return null;
  if (!groupId || q.isLoading || !q.data) return null;
  // Unclaimed = recorded on the order, not yet anything you own.
  const unclaimed = (q.data.items ?? []).filter((l) => !l.part_id);
  if (unclaimed.length === 0) return null;

  return (
    // A CHIP, not a row. This used to be a full-width bordered box saying one
    // short sentence, which is a lot of a card to spend on a line you mostly do
    // not need — and it is repeated on every line of the same receipt, so a
    // four-line receipt spent four rows telling you about itself (reported
    // 2026-08-19). It still expands to the same list.
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide the rest of this receipt" : "Show the rest of this receipt"}
        className="inline-flex items-center gap-1.5 rounded-full border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/30 px-2 py-0.5 text-[11px] text-muted hover:text-content dark:hover:text-mortar-100 transition"
      >
        <Receipt size={11} className="shrink-0 text-faint" />
        <span>
          +{unclaimed.length} more on this receipt
        </span>
        <span className="text-faint">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900/30 px-3 py-2">
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
