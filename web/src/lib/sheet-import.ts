// The shapes the spreadsheet import speaks (core-import's /sheets routes), and
// the few words the import sheet uses for them. The server decides; this only
// names what it said.

import { DISPOSITION_LABELS, type Disposition } from "@cobblr/platform-contract/disposition";
import { toCsv } from "@cobblr/platform-contract/csv";

export type ColumnType =
  | "text"
  | "long-text"
  | "number"
  | "money"
  | "quantity"
  | "date"
  | "boolean"
  | "choice"
  | "tags"
  | "code"
  | "url"
  | "image";

export type PlainDestination = "name" | "quantity" | "location" | "category" | "tags" | "photo" | "disposition";

export type Destination =
  | { to: PlainDestination }
  | { to: "field"; field: string; label: string; native: boolean }
  | { to: "new-field"; field: string; label: string; type: string; choices?: string[]; unit?: string | null; field_role?: string | null }
  | { to: "skip" };

export interface TargetField {
  name: string;
  label: string;
  type: string;
  native: boolean;
  choices?: string[] | null;
  field_role?: string | null;
}

export interface SheetTarget {
  id: string;
  kind: string;
  module: string;
  instance: string;
  label: string;
  noun: string;
  status: "existing" | "install" | "new" | "enable";
  fields: TargetField[];
  general?: boolean;
  counts?: boolean;
  retires?: boolean;
  category?: { label: string; values: string[]; field?: string } | null;
}

export interface ColumnPlan {
  column: number;
  header: string;
  type: ColumnType;
  role: string | null;
  samples: string[];
  dest: Destination;
  why: string;
  misfits: number;
  as_written?: number;
  named_by?: "values" | "ai";
}

export interface RecordPlan {
  row: number;
  rows?: number[];
  action: "create" | "update" | "unchanged";
  name: string;
  existing_id?: string;
  fields: Record<string, unknown>;
  qty?: number | null;
  unit?: string | null;
  location_path?: string[];
  category?: string | null;
  tags?: string[];
  photo_url?: string | null;
  changes?: Array<{ field: string; from: unknown; to: unknown }>;
  disposition?: { kind: Disposition; text: string; price: number | null };
  problems: string[];
}

export interface SkippedRow {
  row: number;
  reason: "title" | "blank" | "repeated-header" | "total" | "section" | "excluded" | "not-owned";
  text?: string;
}

export interface SummaryCheck {
  row: number;
  label: string;
  value: number;
  money: boolean;
  /** The sheet's currency (USD), when its money columns say. */
  currency?: string | null;
  computed: number | null;
  agrees: boolean | null;
  basis: string;
}

export interface SheetPlanView {
  sheet: string;
  include: boolean;
  header_row: number | null;
  headerless: boolean;
  target: SheetTarget;
  alternatives: Array<{ id: string; label: string; status: SheetTarget["status"]; module: string }>;
  why_target: string;
  columns: ColumnPlan[];
  records: RecordPlan[];
  row_count: number;
  records_shown: "all" | "some";
  counts: { create: number; update: number; unchanged: number; skipped_rows: number };
  install?: { bundle_external_id: string; label: string };
  enable?: { module: string; label: string };
  new_collection?: { module: string; instance: string; label: string };
  fields_to_create: Array<Extract<Destination, { to: "new-field" }>>;
  locations_to_create: string[][];
  categories_to_create: string[];
  tags_used: string[];
  needs_admin: string[];
  skipped: SkippedRow[];
  summary: SummaryCheck[];
  ownership: { owned: number; gone: number; by: Partial<Record<Disposition, number>> } | null;
  groups: Array<{ rows: number[]; name: string }>;
}

export interface SheetsPlan {
  source: "file" | "link";
  filename: string;
  your_role: string;
  sheets: SheetPlanView[];
}

export interface SheetOverride {
  include?: boolean;
  target?: string;
  columns?: Record<string, Destination>;
  skip_rows?: number[];
  collection_label?: string;
  only_owned?: boolean;
  keep_identical_apart?: boolean;
}

export type SheetsSource = { file_b64: string; filename: string } | { url: string };

export interface SheetsBody {
  source: SheetsSource;
  overrides?: Record<string, SheetOverride>;
}

export function bodyOf(b: SheetsBody): Record<string, unknown> {
  return { ...b.source, ...(b.overrides ? { overrides: b.overrides } : {}) };
}

export interface ImportRunSheet {
  sheet: string;
  label: string;
  kind: string;
  created?: number;
  updated?: number;
  unchanged?: number;
  failed?: number;
  retired?: number;
  checks?: SummaryCheck[];
  problems?: string[];
  /** Every row not taken exactly as written, and why; issue_count is the total. */
  issues?: Array<{ row: number; name: string; problem: string }>;
  issue_count?: number;
  planned?: { create: number; update: number; unchanged: number };
}

/** The rows of one sheet that did not go in exactly as written, as a CSV a
 *  person can open beside their spreadsheet and fix. */
export function issuesCsv(sheet: ImportRunSheet): string {
  return toCsv(["Row", "Name", "What happened"], (sheet.issues ?? []).map((i) => [i.row, i.name, i.problem]));
}

export interface HeldStep {
  kind: string;
  label: string;
  why: string;
}

export interface UndoReport {
  undone: number;
  held: HeldStep[];
  status: "undone" | "partly-undone";
}

export type ImportRunStatus = "preparing" | "queued" | "running" | "done" | "failed" | "undoing" | "undone" | "partly-undone";

export interface ImportRun {
  id: string;
  created_at: string;
  filename: string | null;
  status: ImportRunStatus;
  progress_done: number;
  progress_total: number;
  summary: { sheets?: ImportRunSheet[] };
  error: string | null;
  finished_at: string | null;
  undone_at: string | null;
  undo_report: UndoReport | null;
  steps?: Record<string, { made: number; undone: number }>;
}

/** Anything (the dashboard, the command menu, Scan, Integrations, an activity
 *  row) opens the one import sheet the shell mounts; `runId` opens it on a
 *  past import, its undo included. */
export const OPEN_SHEET_IMPORT_EVENT = "cobblr:open-sheet-import";

export function openSheetImport(opts: { runId?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_SHEET_IMPORT_EVENT, { detail: opts }));
}

export const ACCEPTED_SHEETS = ".xlsx,.xlsm,.xls,.ods,.csv,.tsv,.tab,.txt";

export function looksLikeSheetsLink(s: string): boolean {
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\//i.test(s.trim());
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** A destination as a short phrase for the column list. */
export function destinationLabel(d: Destination, target: SheetTarget): string {
  switch (d.to) {
    case "name":
      return "The name";
    case "quantity":
      return "How many";
    case "location":
      return "Where it's kept";
    case "category":
      return target.category?.label ?? "Category";
    case "tags":
      return "Tags";
    case "photo":
      return "Photo";
    case "disposition":
      return "What became of it";
    case "field":
      return d.label;
    case "new-field":
      return `New field: ${d.label}`;
    case "skip":
      return "Leave out";
  }
}

/** Every place a column could go on this target, for the column picker. */
export function destinationChoices(target: SheetTarget, column: ColumnPlan): Array<{ key: string; label: string; dest: Destination }> {
  const out: Array<{ key: string; label: string; dest: Destination }> = [
    { key: "name", label: "The name", dest: { to: "name" } },
  ];
  if (target.counts) out.push({ key: "quantity", label: "How many", dest: { to: "quantity" } });
  out.push({ key: "location", label: "Where it's kept", dest: { to: "location" } });
  if (target.category) out.push({ key: "category", label: target.category.label, dest: { to: "category" } });
  out.push({ key: "tags", label: "Tags", dest: { to: "tags" } });
  out.push({ key: "photo", label: "Photo", dest: { to: "photo" } });
  if (column.role === "disposition" || column.dest.to === "disposition") out.push({ key: "disposition", label: "What became of it", dest: { to: "disposition" } });
  for (const f of target.fields) out.push({ key: `field:${f.name}`, label: f.label, dest: { to: "field", field: f.name, label: f.label, native: f.native } });
  const own = column.dest.to === "new-field" ? column.dest : null;
  out.push({
    key: "new-field",
    // The field the plan will make, by the name it will have ("Acquisition
    // Date" is made as the provenance field Acquired on).
    label: `New field: ${own?.label ?? column.header}`,
    dest: own ?? { to: "new-field", field: slugOf(column.header), label: column.header, type: newFieldType(column.type) },
  });
  out.push({ key: "skip", label: "Leave out", dest: { to: "skip" } });
  return out;
}

export function destinationKey(d: Destination): string {
  if (d.to === "field") return `field:${d.field}`;
  return d.to;
}

function slugOf(header: string): string {
  let s = header.toLowerCase().replace(/#/g, " number ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  if (!/^[a-z]/.test(s)) s = `f_${s || "column"}`;
  return s;
}

function newFieldType(t: ColumnType): string {
  if (t === "number" || t === "money" || t === "quantity") return "number";
  if (t === "date") return "date";
  if (t === "boolean") return "boolean";
  if (t === "url" || t === "image") return "url";
  return "text";
}

/** What a target is, as the choice reads. */
export function targetChoiceLabel(t: { label: string; status: SheetTarget["status"] }): string {
  switch (t.status) {
    case "install":
      return `${t.label} (add this collection)`;
    case "new":
      return `A new collection: ${t.label}`;
    case "enable":
      return `${t.label} (turn it on)`;
    default:
      return t.label;
  }
}

const REASONS: Record<SkippedRow["reason"], string> = {
  title: "a title above the table",
  blank: "a blank line",
  "repeated-header": "the header again",
  total: "a total",
  section: "a heading over the rows below it",
  excluded: "you left it out",
  "not-owned": "no longer yours, and you chose only what you still have",
};

export function skipReason(r: SkippedRow["reason"]): string {
  return REASONS[r];
}

/** A plain rendering of a value the plan carries. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A figure the way the sheet showed it: money with two places. */
export function showFigure(n: number, check: Pick<SummaryCheck, "money" | "currency">): string {
  if (!check.money) return n.toLocaleString();
  if (check.currency) {
    try {
      return n.toLocaleString(undefined, { style: "currency", currency: check.currency });
    } catch {
      // an unknown code reads as a plain amount below
    }
  }
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "53 still yours, 13 no longer (sold 3, parted out 6, …)". */
export function ownershipLine(o: NonNullable<SheetPlanView["ownership"]>): string {
  const parts = (Object.entries(o.by) as Array<[Disposition, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${DISPOSITION_LABELS[d]} ${n}`);
  return `${o.owned} still yours, ${o.gone} no longer${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function isFinished(s: ImportRunStatus): boolean {
  return s === "done" || s === "failed" || s === "undone" || s === "partly-undone";
}
