// What the labels-queue toolbar shows, as ONE pure function — because the parts
// depend on each other and drifted once: the paper + label-size pickers were gated
// on "has a Cobblr printer", so the plainest case (no printer configured, print to
// the OS via the browser dialog) lost the size controls while the Print button
// stayed. The rule is simpler than "has a printer": the sheet/label pickers belong
// with the sheet-OUTPUT path, which is everything except a Bluetooth roll (it prints
// one label at a time from its own stored media). Keeping this here, tested, stops
// the pickers and the Print action from ever being gated differently again.

export interface QueueToolbarMode {
  /** No Cobblr printer configured — offer the connect CTAs (Bluetooth / network).
   *  System printing still works, so it is not a dead end. */
  connectCtas: boolean;
  /** Show the media + label-size pickers. ALWAYS true: every print needs a size, so
   *  the pickers belong in the toolbar for every printer — a Bluetooth roll included
   *  (funnelled to the rolls it can feed). Burying a Bluetooth printer's media in a
   *  separate modal, while the toolbar pickers we built sat hidden, was the
   *  disjointedness called out in feedback. */
  sheetControls: boolean;
  /** The browser/system "Print" button (opens the OS print dialog for a sheet).
   *  Everything except a Bluetooth printer, which prints over Bluetooth, not ⌘P. */
  browserPrint: boolean;
  /** The button that prints to the configured default printer — "Send to printer"
   *  for a network manager, or "Print to <name>" over Bluetooth. */
  configuredPrint: boolean;
}

/** The ACTIVE print target from the session pick, resolved against the saved
 *  printers. Returns the active printer, or `undefined` for System print (⌘P) —
 *  which the caller treats as "no capability funnel, all media". The rules, in one
 *  tested place so the toolbar can never strand you:
 *   • `picked === null`            → the saved default (is_default, else the first).
 *   • `picked === systemSentinel`  → System print (undefined).
 *   • `picked === <id>`            → that printer, or System if it was since
 *                                     forgotten (never a dangling ref / crash).
 *  System is therefore ALWAYS reachable — a disconnected or deleted printer is never
 *  a dead end. (The trap this fixes: media was funnelled to a Bluetooth printer's
 *  width with no way off it but "forget forever" — reported 2026-07.) */
export function resolvePrintTarget<T extends { id: string; is_default?: boolean }>(
  picked: string | null,
  printers: T[],
  systemSentinel: string,
): T | undefined {
  const savedDefault = printers.find((p) => p.is_default) ?? printers[0];
  const resolvedId = picked ?? savedDefault?.id ?? systemSentinel;
  return resolvedId === systemSentinel ? undefined : printers.find((p) => p.id === resolvedId);
}

/** Whether a label caption can be reverted to the entity's STOCK system name, and
 *  therefore whether to offer the revert control. True only when we know the stock
 *  name AND the caption has diverged from it. The revert target is ALWAYS the stock
 *  name — never the last-saved caption. (The bug this pins: the revert button reset
 *  to the saved value, so a caption trimmed from "2002 Honda Odyssey Minivan EX" to
 *  "2002 Honda Odyssey" and saved could never get the full name back — reported 2026-07.
 *  Escape already restores the last-saved value; revert means revert to STOCK.) */
export function canRevertToStock(current: string, stockName?: string | null): boolean {
  return !!stockName && current !== stockName;
}

/** Derive the toolbar's parts from the default printer (or its absence). */
export function queueToolbarMode(defaultPrinter?: { driver: string } | null): QueueToolbarMode {
  const hasPrinter = !!defaultPrinter;
  // Roll printers print over their own link, so there is no browser/system
  // print for them — true of BOTH browser drivers, not just Bluetooth.
  const isBle = defaultPrinter?.driver === "browser-bluetooth" || defaultPrinter?.driver === "browser-serial";
  return {
    connectCtas: !hasPrinter,
    sheetControls: true,
    browserPrint: !isBle,
    configuredPrint: hasPrinter,
  };
}
