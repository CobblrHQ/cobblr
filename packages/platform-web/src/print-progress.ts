// Process-wide progress of the Bluetooth print batch in flight, so a taskbar-style
// count can surface in the Live box while labels stream to the printer. The BLE
// print path (printBatchOverBluetooth) publishes here — start, per label, clear —
// and any browser surface subscribes. One printer holds one session, so a batch is
// serial and a single global is enough.

import { useEffect, useState } from "react";

export interface PrintProgress {
  /** Labels already sent this batch (a multi-up sheet counts its labels). */
  done: number;
  /** Total labels in the batch. */
  total: number;
  /** The printer this batch is printing to, for a tooltip. */
  deviceName?: string;
}

let current: PrintProgress | null = null;
const listeners = new Set<(p: PrintProgress | null) => void>();

export function getPrintProgress(): PrintProgress | null {
  return current;
}

/** Publish batch progress (called by platform-web's print path). `null` clears it —
 *  the batch finished or aborted. */
export function setPrintProgress(p: PrintProgress | null): void {
  current = p;
  for (const l of listeners) l(current);
}

export function subscribePrintProgress(cb: (p: PrintProgress | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Live batch progress for a React surface (the Live-box printer badge). */
export function usePrintProgress(): PrintProgress | null {
  const [p, setP] = useState<PrintProgress | null>(getPrintProgress());
  useEffect(() => subscribePrintProgress(setP), []);
  return p;
}
