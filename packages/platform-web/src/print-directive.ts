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
  skipped?: "no-browser-printer" | "no-web-bluetooth" | "no-width";
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
  if (!target || target.driver !== "browser-bluetooth") {
    return { printed: false, skipped: "no-browser-printer" };
  }
  if (!isWebBluetoothAvailable()) return { printed: false, skipped: "no-web-bluetooth" };

  const settings = (target.settings ?? {}) as BluetoothPrinterSettings;
  if (!settings.widthDots) return { printed: false, skipped: "no-width" };

  const { deviceName } = await printOneOverBluetooth(directive.content, settings);

  // Paper exists now. Telling the module is best-effort: a failure here leaves
  // stale bookkeeping, not a lost label, so it is reported separately rather
  // than thrown over a print that physically succeeded.
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
