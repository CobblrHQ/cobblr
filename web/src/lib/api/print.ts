import { request } from "./client";

export interface Printer {
  id: string;
  name: string;
  /** "cups" | "edge" | "browser-bluetooth" | "mock" */
  driver: string;
  base_url: string;
  queue: string;
  is_default: boolean;
  notes: string | null;
  has_credentials: boolean;
  /** Driver-specific settings. For browser-bluetooth: dialect, width, calibration. */
  settings?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PrinterInput {
  name: string;
  driver: string;
  base_url: string;
  queue: string;
  credentials?: { username?: string; password?: string; apiKey?: string };
  is_default?: boolean;
  notes?: string;
  settings?: Record<string, unknown>;
}

export const printApi = {
  // ── core-print (CUPS/IPP printers) ──────────────────────────────
  listPrinters: (slug: string) =>
    request<{ items: Printer[] }>("GET", `/orgs/${slug}/modules/core-print/printers`),
  createPrinter: async (slug: string, body: PrinterInput) => {
    // core-print owns the printer registry and is opt-in. Enable it on demand the
    // first time a workspace adds a printer (idempotent), so printing infra appears
    // exactly when it is needed instead of bloating every workspace.
    await request("POST", `/orgs/${slug}/modules/core-print/enable`, {});
    return request<Printer>("POST", `/orgs/${slug}/modules/core-print/printers`, body);
  },
  updatePrinter: (slug: string, id: string, body: Partial<PrinterInput>) =>
    request<Printer>("PATCH", `/orgs/${slug}/modules/core-print/printers/${id}`, body),
  deletePrinter: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-print/printers/${id}`),
  testPrinter: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; detail?: string }>(
      "POST",
      `/orgs/${slug}/modules/core-print/printers/${id}/test`,
      {},
    ),
  printToPrinter: (
    slug: string,
    id: string,
    body: { file_id?: string; document_base64?: string; content_type?: string; filename?: string; copies?: number; job_name?: string },
  ) =>
    request<{ printer_id: string; jobId: string; state: string }>(
      "POST",
      `/orgs/${slug}/modules/core-print/printers/${id}/print`,
      body,
    ),
};
