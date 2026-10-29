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

// Printing is opt-in, and its routes answer 409 while it is off. A workspace
// without it has no printers, so it is not asked: Print label on any record
// asked anyway and logged a refused request on every press (#8886). The labels
// client keeps the same rule for its own pages.
const printOn = new Map<string, { at: number; on: Promise<boolean> }>();
function printIsOn(slug: string): Promise<boolean> {
  const seen = printOn.get(slug);
  if (seen && Date.now() - seen.at < 30_000) return seen.on;
  const on = request<{ items: Array<{ name: string; enabled?: boolean }> }>("GET", `/orgs/${slug}/modules`)
    .then((r) => r.items.some((m) => m.name === "core-print" && m.enabled === true))
    .catch(() => {
      printOn.delete(slug);
      return true;
    });
  printOn.set(slug, { at: Date.now(), on });
  return on;
}

export const printApi = {
  // ── core-print (CUPS/IPP printers) ──────────────────────────────
  listPrinters: async (slug: string): Promise<{ items: Printer[] }> =>
    (await printIsOn(slug)) ? request<{ items: Printer[] }>("GET", `/orgs/${slug}/modules/core-print/printers`) : { items: [] },
  createPrinter: async (slug: string, body: PrinterInput) => {
    // core-print owns the printer registry and is opt-in. Enable it on demand the
    // first time a workspace adds a printer (idempotent), so printing infra appears
    // exactly when it is needed instead of bloating every workspace.
    await request("POST", `/orgs/${slug}/modules/core-print/enable`, {});
    printOn.delete(slug);
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
