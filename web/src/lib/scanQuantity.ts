// The scan item's quantity: one place that owns BOTH the optimistic value and
// the write, so a stepper that doesn't save can't be built.
//
// The bug this exists to make impossible (reported 2026-08-03): the Scanned sheet
// kept the count in local state and PATCHed it only from "Save & next". Step
// 2 → 1, swipe the sheet away, and the edit was silently gone — the row still
// said 2. The mini drawer's stepper, meanwhile, wrote on every tap. Same
// control, same item, two different persistence rules depending on which
// surface you happened to be looking at.
//
// So persistence is not a thing a caller remembers to add. `useScanQuantity`
// hands back the value AND the bump, the write is debounced (mashing + must
// not stack requests), and it is FLUSHED — fired immediately — when the
// subject changes or the component unmounts. Every exit path saves, including
// ones nobody has thought of yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ScanInboxItem } from "./api";

/** The debounce + flush machine, free of React so it can be tested with fake
 *  timers. `write` is fired at most once per settled edit, and always exactly
 *  once for an edit that is pending when flush() is called. */
export function createQuantityWriter(opts: {
  write: (itemId: string, quantity: number) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (h: number) => void;
}) {
  const delay = opts.delayMs ?? 500;
  // Bare setTimeout, not window.setTimeout: identical in the browser and
  // available under the node test runner, so this stays testable without a DOM.
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  let pending: { itemId: string; quantity: number } | null = null;
  let handle: number | null = null;

  const fire = () => {
    handle = null;
    const p = pending;
    pending = null;
    if (p) opts.write(p.itemId, p.quantity);
  };

  return {
    /** Record an edit; it lands after the debounce, or at the next flush. */
    set(itemId: string, quantity: number) {
      pending = { itemId, quantity };
      if (handle !== null) clearT(handle);
      handle = setT(fire, delay);
    },
    /** Write a pending edit NOW. Safe to call when nothing is pending. */
    flush() {
      if (handle !== null) clearT(handle);
      fire();
    },
    /** For tests / diagnostics. */
    hasPending() {
      return pending !== null;
    },
  };
}

/** What the STEPPER shows. An item with no meaningful count shows 1, because a
 *  stepper reading 0 invites you to press + to get to the number you already
 *  meant. Display only — never send this to a commit. */
export function displayQuantity(local: number | null, itemQty: number | null | undefined): number {
  if (local !== null) return local;
  const q = Number(itemQty ?? 0);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/** What a COMMIT sends, which is NOT what the stepper shows.
 *
 *  `undefined` means "I am not telling you a count" — and the server then
 *  derives one from what is being committed INTO: a unique catalog target
 *  (a bookshelf, a film shelf) gets no count at all, a fungible stock target
 *  gets the scan's own quantity. That derivation is deliberate
 *  (core-scan/api/inbox.ts, `targetIsUnique`) and has been correct since it
 *  shipped — but the camera sheet sent `qty > 0 ? qty : 1`, so a number was
 *  ALWAYS present and the server's branch never ran. One scanned book then
 *  counted as stock, which latched the whole shelf to the stock face: a
 *  quantity stepper, cost, supplier URL, serial number and fifteen stock
 *  actions on a paperback, permanently.
 *
 *  So a count is sent only when there IS one: the user bumped the stepper, or
 *  the scan itself carried a quantity. Otherwise nothing, and the platform
 *  decides. */
export function commitQuantity(local: number | null, itemQty: number | null | undefined): number | undefined {
  if (local !== null) return local;
  const q = Number(itemQty ?? 0);
  return Number.isFinite(q) && q > 0 ? q : undefined;
}

/** The quantity shown for an item, and the only correct way to change it.
 *  `value` is for display; `commit` is what a confirm should send. */
export function useScanQuantity(slug: string, item: ScanInboxItem | null) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<number | null>(null);

  // The writer outlives renders; the flush on unmount is why a bump made in
  // the last 500ms before you swipe the sheet away still lands.
  const writerRef = useRef<ReturnType<typeof createQuantityWriter> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createQuantityWriter({
      write: (itemId, quantity) => {
        void api
          .updateScanItem(slug, itemId, { quantity })
          .then(() => {
            void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
            void qc.invalidateQueries({ queryKey: ["scan-item-live", slug, itemId] });
          })
          // A failed write leaves the row at its old count; the next open shows
          // the truth rather than a lie we invented.
          .catch(() => {});
      },
    });
  }
  const writer = writerRef.current;

  // A new subject: write the previous item's pending edit before forgetting it.
  const itemId = item?.id ?? null;
  useEffect(() => {
    return () => {
      writer.flush();
      setLocal(null);
    };
  }, [itemId, writer]);

  const value = displayQuantity(local, item?.quantity);
  const bump = useCallback(
    (d: 1 | -1) => {
      if (!item) return;
      const next = Math.max(1, (local ?? (item.quantity > 0 ? item.quantity : 1)) + d);
      setLocal(next);
      writer.set(item.id, next);
    },
    [item, local, writer],
  );

  return { value, commit: commitQuantity(local, item?.quantity), bump, flush: () => writer.flush() };
}
