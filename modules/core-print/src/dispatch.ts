// The ONE dispatch path, shared by the HTTP endpoint and the background auto-flush
// worker (docs/design-decisions/label-media-and-accumulation.md D8): build a
// printer's driver from its row, print, and emit the job.submitted / job.failed
// events. Extracted from the print route so a queued auto-flush job can reuse it
// without duplicating the driver wiring.

import type { Kysely, Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { buildDriver } from "./drivers/registry.js";
import { buildEdgeRelay } from "./edge.js";
import type { PrinterConfig, PrintDoc, PrintJobResult } from "./drivers/types.js";
import type { CorePrintDB, CorePrintPrintersTable } from "./db.js";

export type PrinterRow = Selectable<CorePrintPrintersTable>;

/** Build the driver for a printer row: decrypt its creds, wire the edge relay for a
 *  `cobblr-edge://` manager (null for a direct http(s):// CUPS dial). */
export async function configuredDriver(orgId: string, row: PrinterRow) {
  let creds: Record<string, unknown> = {};
  if (row.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  }
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const bridge = (settings.bridge ?? undefined) as PrinterConfig["bridge"];
  const cfg: PrinterConfig = {
    baseUrl: row.base_url,
    queue: row.queue,
    bluetooth: (row.settings ?? undefined) as never,
    bridge,
    username: typeof creds.username === "string" ? creds.username : undefined,
    password: typeof creds.password === "string" ? creds.password : undefined,
    apiKey: typeof creds.apiKey === "string" ? creds.apiKey : undefined,
  };
  // Which bridge = the NAMED channel from settings, never the URL id — that
  // names the instance. See edge.ts for why the two must not share one id.
  return buildDriver(row.driver, cfg, buildEdgeRelay(orgId, row.base_url, bridge?.bridgeName ?? null));
}

/** Load a printer row by id, or null. */
export async function loadPrinterRow(db: Kysely<CorePrintDB>, printerId: string): Promise<PrinterRow | null> {
  const row = await db.selectFrom("core_print_printers").selectAll().where("id", "=", printerId).executeTakeFirst();
  return (row as PrinterRow | undefined) ?? null;
}

/** Send a document to a printer row. Emits job.submitted on success, job.failed on
 *  error, and re-throws so the caller decides what next: the HTTP handler returns
 *  502, the retrying queue backs off and eventually marks the job failed. */
export async function dispatchToPrinter(
  orgId: string,
  row: PrinterRow,
  doc: PrintDoc,
  opts: { copies?: number; jobName?: string } = {},
): Promise<PrintJobResult> {
  const driver = await configuredDriver(orgId, row);
  try {
    const result = await driver.print(doc, opts);
    void platform().events.emit("core-print.job.submitted", {
      orgId,
      printerId: row.id,
      jobId: result.jobId,
      state: result.state,
    });
    return result;
  } catch (e) {
    void platform().events.emit("core-print.job.failed", {
      orgId,
      printerId: row.id,
      error: (e as Error).message,
    });
    throw e;
  }
}
