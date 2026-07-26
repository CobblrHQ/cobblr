// Driver factory. Built-ins are code; if/when core-print grows user-installable
// declarative drivers (à la digifab), they slot in here behind the same factory.

import type { PrintDriver, PrinterConfig } from "./types.js";
import { CupsDriver } from "./cups.js";
import { MockDriver } from "./mock.js";
import { BrowserBluetoothDriver } from "./browser-bluetooth.js";
import { EdgePrintDriver, type EdgeRelay } from "./edge-print.js";

// browser-serial: a Bluetooth CLASSIC printer driven from the browser over Web
// Serial. Same server posture as browser-bluetooth (the server cannot reach it);
// it was missing from this list, so creating one 400d as an unknown driver and
// the whole serial connect flow died at its final step.
export const DRIVER_KINDS = ["cups", "browser-bluetooth", "browser-serial", "mock"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

export function isDriverKind(s: string): s is DriverKind {
  return (DRIVER_KINDS as readonly string[]).includes(s);
}

/** A `cobblr-edge://…` manager URL routes through the on-site edge bridge rather
 *  than a direct address — the transport, not the nominal driver, changes. */
export function isEdgeManagerUrl(baseUrl: string): boolean {
  return /^cobblr-edge:/i.test(baseUrl);
}

/** True for printers the SERVER cannot reach AT ALL: the browser holds the radio,
 *  so a wire or automation can never print to them and the UI must say so.
 *  A different axis from the edge transport above — an edge-bridged printer IS
 *  server-reachable (the bridge relays), a Bluetooth one genuinely is not. */
export function isClientSideDriver(kind: string): boolean {
  return kind === "browser-bluetooth" || kind === "browser-serial";
}

export function buildDriver(kind: string, cfg: PrinterConfig, relay?: EdgeRelay | null): PrintDriver {
  // A cobblr-edge:// manager rides the bridge whatever the nominal driver — the
  // bridge speaks IPP to CUPS locally. `mock` stays mock (tests/dev never bridge),
  // and browser-bluetooth is excluded because there is no server-side path to relay.
  if (kind !== "mock" && !isClientSideDriver(kind) && isEdgeManagerUrl(cfg.baseUrl)) {
    return new EdgePrintDriver(cfg, relay ?? null);
  }
  switch (kind) {
    case "cups":
      return new CupsDriver(cfg);
    case "browser-bluetooth":
      return new BrowserBluetoothDriver(cfg);
    case "browser-serial":
      return new BrowserBluetoothDriver(cfg, "a serial port");
    case "mock":
      return new MockDriver(cfg);
    default:
      throw new Error(`unknown print driver: ${kind}`);
  }
}
