// Driver factory. Built-ins are code; if/when core-print grows user-installable
// declarative drivers (à la digifab), they slot in here behind the same factory.

import type { PrintDriver, PrinterConfig } from "./types.js";
import { CupsDriver } from "./cups.js";
import { MockDriver } from "./mock.js";
import { EdgePrintDriver, type EdgeRelay } from "./edge-print.js";

export const DRIVER_KINDS = ["cups", "mock"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

export function isDriverKind(s: string): s is DriverKind {
  return (DRIVER_KINDS as readonly string[]).includes(s);
}

/** A `cobblr-edge://…` manager URL routes through the on-site edge bridge rather
 *  than a direct address — the transport, not the nominal driver, changes. */
export function isEdgeManagerUrl(baseUrl: string): boolean {
  return /^cobblr-edge:/i.test(baseUrl);
}

export function buildDriver(kind: string, cfg: PrinterConfig, relay?: EdgeRelay | null): PrintDriver {
  // A cobblr-edge:// manager rides the bridge whatever the nominal driver — the
  // bridge speaks IPP to CUPS locally. `mock` stays mock (tests/dev never bridge).
  if (kind !== "mock" && isEdgeManagerUrl(cfg.baseUrl)) {
    return new EdgePrintDriver(cfg, relay ?? null);
  }
  switch (kind) {
    case "cups":
      return new CupsDriver(cfg);
    case "mock":
      return new MockDriver(cfg);
    default:
      throw new Error(`unknown print driver: ${kind}`);
  }
}
