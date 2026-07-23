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
  /** Show the paper (sheet/media) + label-size pickers. True for a network printer
   *  AND for no printer at all (the browser/system print path renders a sheet and
   *  needs a size). A Bluetooth roll hides them — it has its own loaded media. */
  sheetControls: boolean;
  /** The browser/system "Print" button (opens the OS print dialog for a sheet). */
  browserPrint: boolean;
  /** The button that prints to the configured default printer — "Send to printer"
   *  for a network manager, or "Print to <name>" over Bluetooth. */
  configuredPrint: boolean;
}

/** Derive the toolbar's parts from the default printer (or its absence). The
 *  sheet pickers and the browser Print button share one gate so they cannot
 *  diverge. */
export function queueToolbarMode(defaultPrinter?: { driver: string } | null): QueueToolbarMode {
  const hasPrinter = !!defaultPrinter;
  const isBle = defaultPrinter?.driver === "browser-bluetooth";
  return {
    connectCtas: !hasPrinter,
    sheetControls: !isBle,
    browserPrint: !isBle,
    configuredPrint: hasPrinter,
  };
}
