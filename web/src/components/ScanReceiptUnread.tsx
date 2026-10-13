// A receipt whose lines could not be read, as every scan surface draws it
// (#3581): what happened in one line, Read again as the first action, and
// "Treat it as one item" as the deliberate other way. The phone row, the item
// screen and the desk card render this one component, and whether a row IS
// such a receipt is the contract's (scanReceiptReadFailed), so no surface can
// fall back to asking a person to name a receipt.
import { ReceiptText } from "lucide-react";
import { Link } from "react-router-dom";
import { RECEIPT_AS_ITEM, RECEIPT_READ_AGAIN, RECEIPT_READ_ANYWAY, RECEIPT_UNREAD_SENTENCE, receiptAlreadyInSentence } from "@cobblr/platform-contract/scan-copy";
import type { ScanReceiptAlreadyIn } from "@cobblr/platform-contract/scan-triage";

export interface ScanReceiptUnreadProps {
  /** A read is running (Read again was pressed). */
  reading: boolean;
  /** "Treat it as one item" is being saved. */
  saving: boolean;
  onReadAgain: () => void;
  onAsItem: () => void;
  /** The phone row's one-line form; the item screen and the card use the block. */
  compact?: boolean;
  /** The receipt is in the inbox already (#4027): say where, and offer a
   *  second copy rather than another read that would stop the same way. */
  alreadyIn?: ScanReceiptAlreadyIn | null;
  /** Read it in as a second copy. */
  onReadAnyway?: () => void;
}

export function ScanReceiptUnread(p: ScanReceiptUnreadProps) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div data-testid="receipt-unread" className={p.compact ? "flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5" : "space-y-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm"}>
      <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <ReceiptText size={p.compact ? 12 : 14} className="shrink-0" />
        {p.alreadyIn ? receiptAlreadyInSentence(p.alreadyIn.label, p.alreadyIn.lines) : RECEIPT_UNREAD_SENTENCE}
      </span>
      <span className={p.compact ? "inline-flex items-center gap-2" : "flex flex-wrap items-center gap-2"}>
        {p.alreadyIn && (
          <Link
            to={`/scan?batch=${p.alreadyIn.batch_id}`}
            data-testid="receipt-already-in"
            onClick={stop}
            className={(p.compact ? "" : "min-h-11 inline-flex items-center px-1 ") + "font-medium text-accent underline"}
          >
            Open it
          </Link>
        )}
        {/* COLOUR-NOT-STATE: both sizes are filled; the condition is the compact size, not a state. */}
        <button
          type="button"
          data-testid="receipt-read-again"
          disabled={p.reading}
          onClick={(e) => {
            stop(e);
            if (p.alreadyIn && p.onReadAnyway) p.onReadAnyway();
            else p.onReadAgain();
          }}
          className={
            p.compact
              ? "rounded-md bg-cobble-600 px-2 py-0.5 font-medium text-white disabled:opacity-50"
              : "min-h-11 rounded-md bg-cobble-600 px-3 font-medium text-white disabled:opacity-50"
          }
        >
          {p.reading ? "Reading…" : p.alreadyIn && p.onReadAnyway ? RECEIPT_READ_ANYWAY : RECEIPT_READ_AGAIN}
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
