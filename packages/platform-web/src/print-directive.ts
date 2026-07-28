// The `ui.print` action directive — walk-up printing, generically.
//
// THE PROBLEM IT SOLVES. A browser-Bluetooth printer can only be driven by the
// browser, and the browser is the one place that has no idea what a label is.
// The actions bar is generic platform UI rendered on every entity page; teaching
// it about the labels module would break the rule that modules stay mutually
// ignorant.
//
// THE SEAM. A module's action handler returns, alongside its normal result, a
// directive saying "here is something printable, and here is where to tell me it
// printed". The platform owns the radio and the printer list; the module owns
// what a label says and its own bookkeeping. Neither learns the other's job.
//
//   ui: { print: { content: {...}, record: { path, ids } } }
//
// A directive is a REQUEST, not a command: if no browser-driven printer is the
// default, this does nothing at all and the module's normal path (the queue)
// still holds the work. That is what makes it safe to return unconditionally.

import {
  isWebBluetoothAvailable,
  printOneOverBluetooth,
  type BluetoothPrinterSettings,
  type LabelContent,
} from "./bluetooth-label";
import { isWebSerialAvailable, printOneOverSerial } from "./serial-printer.js";
import { renderLabelPng } from "./bluetooth-label";
import {
  EdgeBridgeClient,
  httpBridgeTransport,
  type BridgePrinterSettings,
} from "@cobblr/platform-contract/edge-bridge-client";

/** What a module asks the platform to put on paper. */
export interface PrintDirective {
  content: LabelContent;
  /** Where to report what reached paper. The module owns this endpoint; the
   *  platform just calls it. Omit and nothing is reported. */
  record?: { path: string; ids: string[] };
}

export interface PrintDirectiveResult {
  printed: boolean;
  deviceName?: string;
  /** Set when the label printed but the module could not be told. The paper
   *  exists either way, so this is a bookkeeping warning, not a print failure. */
  recordError?: string;
  /** Why nothing printed, when nothing printed. Absent on success. */
  skipped?: "no-browser-printer" | "no-web-bluetooth" | "no-web-serial" | "no-width" | "no-bridge-instance";
}

interface PrinterRow {
  id: string;
  name: string;
  driver: string;
  is_default: boolean;
  settings?: unknown;
}

/** Run a directive against the workspace's default printer.
 *
 *  Only browser-driven printers are handled here, because they are the only
 *  ones the server cannot reach on its own. A CUPS or edge-bridge printer needs
 *  no help from the browser, so those skip and the queue handles them. */
export async function runPrintDirective(
  directive: PrintDirective,
  deps: {
    listPrinters: () => Promise<{ items: PrinterRow[] }>;
    post: (path: string, body: unknown) => Promise<unknown>;
  },
): Promise<PrintDirectiveResult> {
  const { items } = await deps.listPrinters();
  const target = items.find((p) => p.is_default) ?? items[0];
  // Both browser drivers can take a directive; only the pipe differs. Gating on
  // Bluetooth alone silently skipped every serial printer, so a module asking the
  // platform to put something on paper got "no-browser-printer" from a workspace
  // that had a perfectly good printer connected.
  // A printer whose settings carry a LOCAL bridge address is browser-driven
  // whatever its nominal driver: the bridge is on this user's machine, so only
  // this browser can reach it. The server-side driver refuses it by design.
  const bridgeSettings = ((target?.settings ?? {}) as { bridge?: BridgePrinterSettings }).bridge;
  if (target && bridgeSettings?.bridgeUrl) {
    if (!bridgeSettings.instance) return { printed: false, skipped: "no-bridge-instance" };
    // The PROTOCOL comes from the shared client — the same code the server-side
    // driver runs over the tunnel — with a fetch transport under it. The label
    // goes as a PNG at the width the bridge is calibrated for; the bridge owns
    // the dialect and geometry, so nothing printer-physical is mirrored here.
    const png = await renderLabelPng(
      directive.content,
      bridgeSettings.widthDots && bridgeSettings.widthDots >= 8 ? bridgeSettings.widthDots : 384,
      bridgeSettings.labelHeightMm ? Math.round(bridgeSettings.labelHeightMm * 8) : undefined,
    );
    const client = new EdgeBridgeClient(
      httpBridgeTransport(bridgeSettings.bridgeUrl, { token: bridgeSettings.token }),
      bridgeSettings.instance,
    );
    const bytes = new Uint8Array(await png.arrayBuffer());
    const { jobId } = await client.printOnce(bytes, "label.png");
    await client.waitForJob(jobId);
    return await recordAndReturn(directive, deps, "Edge bridge");
  }

  const isSerial = target?.driver === "browser-serial";
  if (!target || (target.driver !== "browser-bluetooth" && !isSerial)) {
    return { printed: false, skipped: "no-browser-printer" };
  }
  if (isSerial ? !isWebSerialAvailable() : !isWebBluetoothAvailable()) {
    return { printed: false, skipped: isSerial ? "no-web-serial" : "no-web-bluetooth" };
  }

  const settings = (target.settings ?? {}) as BluetoothPrinterSettings;
  if (!settings.widthDots) return { printed: false, skipped: "no-width" };

  let deviceName = "Label printer";
  if (isSerial) {
    await printOneOverSerial(directive.content, settings);
  } else {
    ({ deviceName } = await printOneOverBluetooth(directive.content, settings));
  }

  return await recordAndReturn(directive, deps, deviceName);
}

/** Paper exists now. Telling the module is best-effort: a failure here leaves
 *  stale bookkeeping, not a lost label, so it is reported separately rather than
 *  thrown over a print that physically succeeded. Shared by every pipe. */
async function recordAndReturn(
  directive: PrintDirective,
  deps: { post: (path: string, body: unknown) => Promise<unknown> },
  deviceName: string,
): Promise<PrintDirectiveResult> {
  let recordError: string | undefined;
  if (directive.record && directive.record.ids.length > 0) {
    try {
      await deps.post(directive.record.path, { item_ids: directive.record.ids });
    } catch (e) {
      recordError = e instanceof Error ? e.message : String(e);
    }
  }
  return { printed: true, deviceName, recordError };
}

/** Pull a directive out of an action result, if there is one. Shape-checked
 *  rather than trusted: an action can return anything. */
export function printDirectiveOf(result: unknown): PrintDirective | null {
  const ui = (result as { ui?: { print?: unknown } } | undefined)?.ui?.print;
  if (!ui || typeof ui !== "object") return null;
  const d = ui as Partial<PrintDirective>;
  if (!d.content || typeof d.content !== "object") return null;
  const c = d.content as Partial<LabelContent>;
  if (typeof c.qrPayload !== "string" || c.qrPayload === "") return null;
  const rec = d.record;
  const record =
    rec && typeof rec.path === "string" && Array.isArray(rec.ids)
      ? { path: rec.path, ids: rec.ids.filter((i): i is string => typeof i === "string") }
      : undefined;
  return { content: { qrPayload: c.qrPayload, caption: c.caption }, record };
}
