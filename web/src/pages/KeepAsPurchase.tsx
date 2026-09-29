// A receipt read while Purchases was off (#3869).
//
// The order used to be skipped in silence: the receipt's lines sat in the
// inbox and no purchase existed, with nothing on screen to say so. The
// session now says it, and one tap turns Purchases on and records the order
// the read would have made (core-scan services/receipt-purchase.ts).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ReceiptText } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

export const KEEP_AS_PURCHASE_SENTENCE = "Turn on Purchases to keep this as a purchase.";

export function useKeepAsPurchase(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (batchId: string) => api.recordReceiptPurchase(slug, batchId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      void qc.invalidateQueries({ queryKey: ["org-modules", slug] });
      toast.success("Purchases is on, and this receipt is kept as a purchase.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't keep this as a purchase. Try again."),
  });
}

export function KeepAsPurchase({ slug, batchId }: { slug: string; batchId: string }) {
  const keep = useKeepAsPurchase(slug);
  return (
    <div
      data-testid="keep-as-purchase"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <ReceiptText size={15} className="shrink-0" />
      <span className="min-w-0">Not kept as a purchase: Purchases is off. {KEEP_AS_PURCHASE_SENTENCE}</span>
      <button
        type="button"
        disabled={keep.isPending}
        onClick={() => keep.mutate(batchId)}
        className="ml-auto rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        data-testid="keep-as-purchase-button"
      >
        {keep.isPending ? "Turning on…" : "Turn on Purchases"}
      </button>
    </div>
  );
}
