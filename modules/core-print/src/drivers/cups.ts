// CUPS driver — IPP over HTTP via the `ipp` library (the same battle-tested
// path used against a real Rollo). We POST a Print-Job to
// {baseUrl}/printers/{queue}; no system `lp` binary, just network access to the
// CUPS listener (port 631). Works same-host, cross-host, on the LAN
// (self-hosted), or through an edge-bridge that forwards to CUPS (cloud).

import ippLib from "ipp";
import { assertSafePrinterUrl } from "./ssrf.js";
import type { PrintDriver, PrintDoc, PrintJobResult, PrinterConfig } from "./types.js";

// Minimal typed shim over the (callback-based, loosely-typed) `ipp` lib.
interface IppRes {
  statusCode?: string;
  "job-attributes-tag"?: { "job-id"?: number; "job-uri"?: string };
}
const ipp = ippLib as unknown as {
  Printer: new (url: string) => {
    execute: (op: string, msg: Record<string, unknown>, cb: (err: Error | null, res?: IppRes) => void) => void;
  };
};

export class CupsDriver implements PrintDriver {
  constructor(private cfg: PrinterConfig) {}

  private printerUri(): string {
    const clean = this.cfg.baseUrl.replace(/\/+$/, "");
    return `${clean}/printers/${encodeURIComponent(this.cfg.queue)}`;
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await assertSafePrinterUrl(this.cfg.baseUrl);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return new Promise((resolve) => {
      try {
        const printer = new ipp.Printer(this.printerUri());
        printer.execute(
          "Get-Printer-Attributes",
          {
            "operation-attributes-tag": {
              "requesting-user-name": this.cfg.username ?? "cobblr",
              "requested-attributes": ["printer-state"],
            },
          },
          (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }),
        );
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
      }
    });
  }

  async print(doc: PrintDoc, opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult> {
    await assertSafePrinterUrl(this.cfg.baseUrl);
    const printer = new ipp.Printer(this.printerUri());
    const msg: Record<string, unknown> = {
      "operation-attributes-tag": {
        "requesting-user-name": this.cfg.username ?? "cobblr",
        "job-name": opts?.jobName ?? doc.filename,
        "document-format": doc.contentType || "application/octet-stream",
      },
      data: Buffer.from(doc.bytes),
    };
    if (opts?.copies && opts.copies > 1) {
      msg["job-attributes-tag"] = { copies: opts.copies };
    }
    return new Promise<PrintJobResult>((resolve, reject) => {
      printer.execute("Print-Job", msg, (err, res) => {
        if (err) return reject(err);
        const jobId = res?.["job-attributes-tag"]?.["job-id"];
        if (jobId == null) {
          return reject(new Error(`CUPS returned no job id (status: ${res?.statusCode ?? "unknown"})`));
        }
        // Print-Job doesn't carry job-state; a freshly accepted job is pending.
        resolve({ jobId: String(jobId), state: "pending" });
      });
    });
  }
}
