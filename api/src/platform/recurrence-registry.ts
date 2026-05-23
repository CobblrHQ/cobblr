// In-process registry of per-entity recurrence scanners. Modules
// register at boot via platform().recurrence.registerScanner(kind, fn);
// core-recurrence's scheduler iterates the registered scanners on
// each tick.

import type { RecurrenceScanner } from "@cobblr/platform-contract";

const scanners = new Map<string, RecurrenceScanner>();

export function registerScanner(kind: string, scanner: RecurrenceScanner): void {
  scanners.set(kind, scanner);
}

export function listScanners(): Array<{ kind: string; scanner: RecurrenceScanner }> {
  return Array.from(scanners.entries()).map(([kind, scanner]) => ({ kind, scanner }));
}
