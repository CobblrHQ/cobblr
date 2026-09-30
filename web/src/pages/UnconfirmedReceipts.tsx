// Orders marked arrived whose stock may never have been added.
//
// "Mark arrived" once marked an order arrived without adding its stock. Which
// past orders went through it cannot be worked out, so stock is never changed
// for a person: each such line is shown here, and they say which it was. "Add
// to stock" adds the line's quantity now (once, however often it is pressed);
// "Already counted" only clears the question. The banner shows only while any
// line is waiting, and the notice's link (?unconfirmed=1) opens the list.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api, ApiError, type UnconfirmedReceiptLine } from "../lib/api";

const key = (slug: string) => ["purchases-unconfirmed", slug] as const;

export function UnconfirmedReceiptsBanner({ slug }: { slug: string }) {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: key(slug), queryFn: () => api.listUnconfirmedReceipts(slug), enabled: !!slug });
  const items = list.data?.items ?? [];
  useEffect(() => {
    if (params.get("unconfirmed") === "1" && items.length > 0) setOpen(true);
  }, [params, items.length]);
  if (items.length === 0) return null;
  const close = () => {
    setOpen(false);
    if (params.has("unconfirmed")) {
      params.delete("unconfirmed");
      setParams(params, { replace: true });
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 mb-4">
        <PackageCheck className="w-5 h-5 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden />
        <p className="text-sm text-content dark:text-mortar-100 flex-1 min-w-[12rem]">
          {items.length === 1 ? "One line" : `${items.length} lines`} on orders marked arrived may not have added {items.length === 1 ? "its" : "their"} stock.
        </p>
        <button type="button" onClick={() => setOpen(true)} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
          Check them
        </button>
      </div>
      {open && <UnconfirmedReceiptsModal slug={slug} items={items} onClose={close} />}
    </>
  );
}

function UnconfirmedReceiptsModal({ slug, items, onClose }: { slug: string; items: UnconfirmedReceiptLine[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settle = useMutation({
    mutationFn: (v: { id: string; decision: "add" | "counted" }) => api.settleUnconfirmedReceipt(slug, v.id, v.decision),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: key(slug) });
      if (v.decision === "add") toast.success("Added to stock");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Close on its own once the last one is settled.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);
  return (
    <Modal open onClose={onClose} title="Orders to check">
      <p className="text-sm text-muted mb-3">
        Marking an order arrived with its button, or answering "Yes, it turned up", once did not add the order to stock. For each line, say whether its stock is already counted or should be added now.
      </p>
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className="rounded border border-line dark:border-slate-700 px-3 py-2">
            <div className="text-sm text-content dark:text-mortar-100">
              {it.qty} × {it.part_title ?? it.description ?? "an item"}
            </div>
            <div className="text-xs text-muted mb-2">
              {[it.vendor, it.order_number ? `order ${it.order_number}` : null, it.arrived_at ? `arrived ${String(it.arrived_at).slice(0, 10)}` : null].filter(Boolean).join(" · ")}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={settle.isPending}
                onClick={() => settle.mutate({ id: it.id, decision: "add" })}
                className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
              >
                Add to stock
              </button>
              <button
                type="button"
                disabled={settle.isPending}
                onClick={() => settle.mutate({ id: it.id, decision: "counted" })}
                className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 hover:border-accent disabled:opacity-50"
              >
                Already counted
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
