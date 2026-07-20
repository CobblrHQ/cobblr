// Browser-Bluetooth driver — a printer the SERVER cannot reach.
//
// Every other driver here is server-side: the API opens a socket to CUPS or to an
// edge-bridge and streams bytes. A Bluetooth thermal printer has no network
// address at all; the only thing that can talk to it is a browser holding a Web
// Bluetooth handle, granted by a user gesture. So this driver deliberately does
// NOT print. It exists so such a printer is a first-class row in the printers
// table — same list, same UI, same label flow — carrying the DATA the browser
// needs (profile, protocol dialect, calibrated geometry) instead of that config
// being hardcoded in the front end.
//
// The web layer checks the driver kind and performs the handshake itself; see
// web/src/lib/bluetooth-label.ts. Server-initiated printing to this printer is
// impossible by construction, and the error says so rather than timing out.

import type { PrintDoc, PrintDriver, PrintJobResult, PrinterConfig } from "./types.js";

/** Marker other code can check without importing the class. */
export const BROWSER_BLUETOOTH_KIND = "browser-bluetooth";

export class BrowserBluetoothDriver implements PrintDriver {
  constructor(private cfg: PrinterConfig) {}

  /** Config-only validation — there is nothing on the network to ping. */
  async test(): Promise<{ ok: boolean; error?: string }> {
    const bt = this.cfg.bluetooth;
    if (!bt) return { ok: false, error: "no Bluetooth settings on this printer" };
    if (!bt.widthDots || bt.widthDots < 8) return { ok: false, error: "widthDots must be set (e.g. 320 for a 40mm roll)" };
    if (bt.protocol !== "tspl" && bt.protocol !== "phomemo") {
      return { ok: false, error: 'protocol must be "tspl" or "phomemo"' };
    }
    return { ok: true };
  }

  async print(_doc: PrintDoc): Promise<PrintJobResult> {
    throw new Error(
      "This printer is driven from the browser over Bluetooth, so the server cannot print to it. " +
        "Print from a Chrome/Edge tab on a desktop or Android device. " +
        "For server-initiated or iOS printing, attach the printer to an edge bridge and give this printer a cobblr-edge:// manager URL instead.",
    );
  }
}
