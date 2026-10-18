import { bodyOf } from "../sheet-import";
import type { ImportRun, SheetsBody, SheetsPlan, UndoReport } from "../sheet-import";
import { request } from "./client";

export const importApi = {
  /** Bring your spreadsheet: what each sheet would become, written nowhere. */
  sheetsPlan: (slug: string, body: SheetsBody) =>
    request<SheetsPlan>("POST", `/orgs/${slug}/modules/core-import/sheets/plan`, bodyOf(body)),
  /** Carry the plan out, as one run that can be undone. */
  sheetsImport: (slug: string, body: SheetsBody) =>
    request<{ run_id: string; total: number }>("POST", `/orgs/${slug}/modules/core-import/sheets/import`, bodyOf(body)),
  sheetsImports: (slug: string) => request<{ items: ImportRun[] }>("GET", `/orgs/${slug}/modules/core-import/sheets/imports`),
  sheetsImportRun: (slug: string, id: string) => request<ImportRun>("GET", `/orgs/${slug}/modules/core-import/sheets/imports/${id}`),
  sheetsImportUndo: (slug: string, id: string, force = false) =>
    request<UndoReport>("POST", `/orgs/${slug}/modules/core-import/sheets/imports/${id}/undo`, force ? { force: true } : {}),
};
