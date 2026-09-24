// A receipt whose lines could not be read, as every scan surface draws it
// (#3581): what happened in one line, Read again as the first action, and
// "Treat it as one item" as the deliberate other way. The phone row, the item
// screen and the desk card render this one component, and whether a row IS
// such a receipt is the contract's (scanReceiptReadFailed), so no surface can
// fall back to asking a person to name a receipt.
import { ReceiptText } from "lucide-react";
import { RECEIPT_AS_ITEM, RECEIPT_READ_AGAIN, RECEIPT_UNREAD_SENTENCE } from "@cobblr/platform-contract/scan-copy";

export interface ScanReceiptUnreadProps {
  /** A read is running (Read again was pressed). */
  reading: boolean;
  /** "Treat it as one item" is being saved. */
  saving: boolean;
  onReadAgain: () => void;
  onAsItem: () => void;
  /** The phone row's one-line form; the item screen and the card use the block. */
  compact?: boolean;
}

export function ScanReceiptUnread(p: ScanReceiptUnreadProps) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div data-testid="receipt-unread" className={p.compact ? "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5" : "space-y-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm"}>
      <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <ReceiptText size={p.compact ? 12 : 14} className="shrink-0" />
        {RECEIPT_UNREAD_SENTENCE}
      </span>
      <span className={p.compact ? "inline-flex items-center gap-2" : "flex flex-wrap items-center gap-2"}>
        <button
          type="button"
          data-testid="receipt-read-again"
          disabled={p.reading}
          onClick={(e) => {
            stop(e);
            p.onReadAgain();
          }}
          className={
            p.compact
              ? "rounded-md bg-cobble-600 px-2 py-0.5 font-medium text-white disabled:opacity-50"
              : "min-h-11 rounded-md bg-cobble-600 px-3 font-medium text-white disabled:opacity-50"
          }
        >
          {p.reading ? "Reading…" : RECEIPT_READ_AGAIN}
        </button>
        <button
          type="button"
          data-testid="receipt-as-item"
          disabled={p.saving}
          onClick={(e) => {
            stop(e);
            p.onAsItem();
          }}
          className={(p.compact ? "" : "min-h-11 px-1 ") + "text-muted underline hover:text-content disabled:opacity-50"}
        >
          {RECEIPT_AS_ITEM}
        </button>
      </span>
    </div>
  );
}
