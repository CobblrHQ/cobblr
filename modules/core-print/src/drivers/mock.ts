// Mock print driver — accepts any document, records nothing, returns a fake
// completed job. Backs tests + local dev (no CUPS needed), exactly like
// digifab's mock machine driver.

import type { PrintDriver, PrintDoc, PrintJobResult, PrinterConfig } from "./types.js";

let seq = 0;

export class MockDriver implements PrintDriver {
  constructor(private cfg: PrinterConfig) {}

  async test(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async print(_doc: PrintDoc, _opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult> {
    seq += 1;
    return { jobId: `mock-${seq}`, state: "completed" };
  }
}
