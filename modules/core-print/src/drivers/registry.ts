// Driver factory. Built-ins are code; if/when core-print grows user-installable
// declarative drivers (à la digifab), they slot in here behind the same factory.

import type { PrintDriver, PrinterConfig } from "./types.js";
import { CupsDriver } from "./cups.js";
import { MockDriver } from "./mock.js";

export const DRIVER_KINDS = ["cups", "mock"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

export function isDriverKind(s: string): s is DriverKind {
  return (DRIVER_KINDS as readonly string[]).includes(s);
}

export function buildDriver(kind: string, cfg: PrinterConfig): PrintDriver {
  switch (kind) {
    case "cups":
      return new CupsDriver(cfg);
    case "mock":
      return new MockDriver(cfg);
    default:
      throw new Error(`unknown print driver: ${kind}`);
  }
}
