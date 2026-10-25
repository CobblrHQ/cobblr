import { ScanLine, ReceiptText } from "lucide-react";

export function ScanInboxEmptyState({ pendingCount, onReceipt }: { pendingCount: number; onReceipt: () => void }) {
  if (pendingCount > 0) return null;
  return (
    <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
      <ScanLine size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
      <div className="text-sm text-muted dark:text-slate-400">
        Nothing pending. Open the camera, upload a photo, or paste a UPC into the search above.
      </div>
      <div className="hidden sm:block mt-1 text-xs text-faint dark:text-slate-500" data-testid="paste-anywhere-hint">
        Or paste or drop a picture anywhere on this page.
      </div>
      {/* The receipt door, in the open: one photo of a paper receipt puts
          the whole trip here. It lived only inside the "..." menu, which a
          phone in a grocery app never found (2026-09-02). */}
      <button
        type="button"
        data-testid="receipt-door"
        onClick={onReceipt}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
      >
        <ReceiptText size={15} /> Photograph a receipt
      </button>
      <div className="text-xs text-faint dark:text-slate-500 mt-3">
        Got a USB or Bluetooth barcode scanner? Just point and scan - it lands
        here automatically, no need to open anything first.
      </div>
    </div>
  );
}
