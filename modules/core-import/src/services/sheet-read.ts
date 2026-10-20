// Read a spreadsheet file into plain grids of cells: every sheet, every row,
// merged cells filled in. No guessing about meaning here; that is
// sheet-understand.ts. Pure apart from the parser.
//
// Merged cells are the commonest shape of a hand-kept list: a group header
// ("Build volume") spread over three columns, or one brand written once down
// the side of five rows. A parser hands back the value in the top-left cell
// only, so without the fill every other cell of the merge reads as blank, and
// the columns under a group header would have no header at all.

import { unguardCsvText } from "@cobblr/platform-contract/csv";
import * as XLSX from "xlsx";

export type CellValue = string | number | boolean | Date;

export interface Cell {
  /** The typed value: a number stays a number, a date a Date. */
  v: CellValue;
  /** What the sheet SHOWS: "$1,299.00", "0012345", "03/04/2025". */
  text: string;
  /** The cell was filled from a merge rather than written there. */
  merged?: true;
}

export interface RawSheet {
  name: string;
  /** Hidden in the workbook (still read, flagged so a person can decide). */
  hidden: boolean;
  rows: Array<Array<Cell | null>>;
}

export const MAX_ROWS_PER_SHEET = 20_000;
export const MAX_COLUMNS = 200;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type SheetFormat = "xlsx" | "xls" | "ods" | "csv" | "tsv";

export class SheetReadError extends Error {
  constructor(public code: "unsupported" | "unreadable" | "too-big" | "empty", message: string) {
    super(message);
  }
}

export function formatOf(filename: string): SheetFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "xls") return "xls";
  if (ext === "ods") return "ods";
  if (ext === "csv") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext === "txt") return "csv";
  return null;
}

/** Which text encoding a file is in. A byte order mark says so; without one,
 *  a file of UTF-16 has a zero byte beside nearly every Latin letter, which
 *  no UTF-8 or Western code page text has. */
export function encodingOf(buf: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8";
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  const n = Math.min(buf.length - (buf.length % 2), 4096);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++;
    if (buf[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (pairs >= 2 && odd >= pairs * 0.3 && even === 0) return "utf-16le";
  if (pairs >= 2 && even >= pairs * 0.3 && odd === 0) return "utf-16be";
  return "utf-8";
}

/** A text file as the text it holds, or a refusal. An Excel "Unicode text"
 *  file is UTF-16, and read as UTF-8 it became names of letters and zero
 *  bytes and a record nobody wrote (#7615). */
export function decodeText(buf: Uint8Array): string {
  const encoding = encodingOf(buf);
  let text: string;
  if (encoding === "utf-8") {
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    // A file saved by an old spreadsheet in a Western code page decodes with
    // replacement characters; latin1 is the honest second reading.
    text = utf8.includes("\uFFFD") ? new TextDecoder("latin1").decode(buf) : utf8;
  } else {
    text = new TextDecoder(encoding, { fatal: false }).decode(buf);
  }
  text = text.replace(/^\uFEFF/, "");
  if (text.includes("\u0000")) {
    throw new SheetReadError("unreadable", "That file isn't plain text: it has zero bytes in it. Save it from your spreadsheet as CSV UTF-8 and upload it again.");
  }
  return text;
}

/** A date cell as the calendar day it shows, at UTC midnight (the parser's
 *  own convention for the Dates it builds). A number cell with a date format
 *  is read from its day number, so the answer never depends on the server's
 *  time zone: a Date read with local getters west of UTC is the day before. */
function dayOf(c: XLSX.CellObject): Date | null {
  if (c.v instanceof Date) return c.v;
  if (c.t !== "n" || typeof c.v !== "number" || !c.z || !XLSX.SSF.is_date(c.z)) return null;
  const p = XLSX.SSF.parse_date_code(c.v);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, Math.floor(p.S)));
}

function cellOf(c: XLSX.CellObject | undefined): Cell | null {
  if (!c || c.v === undefined || c.v === null) return null;
  if (c.t === "e" || c.t === "z") return null;
  const day = dayOf(c);
  // DAY-OK: dayOf builds a cell's date in UTC, so its UTC day is the cell's day.
  if (day) return { v: day, text: (c.w ?? day.toISOString().slice(0, 10)).trim() };
  const v = c.v as CellValue;
  if (typeof v === "string" && v.trim() === "") return null;
  const text = (c.w ?? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))).trim();
  return { v: typeof v === "string" ? v.trim() : v, text };
}

export function readWorkbook(buf: Uint8Array, filename: string): RawSheet[] {
  const format = formatOf(filename);
  if (!format) {
    throw new SheetReadError("unsupported", "That file isn't a spreadsheet. Use .xlsx, .xls, .ods, .csv or .tsv.");
  }
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw new SheetReadError("too-big", `That file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  let wb: XLSX.WorkBook;
  try {
    wb =
      format === "csv" || format === "tsv"
        ? // raw: a CSV cell stays the text it was written as. Letting the
          // parser coerce would turn an ISBN into 9.78044e12 and a code with a
          // leading zero into a smaller number; understanding types it later.
          XLSX.read(decodeText(buf), { type: "string", raw: true, dense: true, sheetRows: MAX_ROWS_PER_SHEET + 1 })
        : XLSX.read(buf, { type: "buffer", cellNF: true, dense: true, sheetRows: MAX_ROWS_PER_SHEET + 1 });
  } catch (err) {
    throw new SheetReadError("unreadable", `That file couldn't be read as a spreadsheet (${(err as Error).message}).`);
  }

  const textFile = format === "csv" || format === "tsv";
  const out: RawSheet[] = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    if (!ws) return;
    const hidden = Boolean(wb.Workbook?.Sheets?.[i]?.Hidden);
    const data = ((ws as unknown as { "!data"?: Array<Array<XLSX.CellObject | undefined> | undefined> })["!data"] ?? []);
    // Past a cap the sheet is refused, never read in part: a plan of the
    // first 20,000 rows looked like the whole file, and the rest were simply
    // gone (#7616).
    // A CSV has one sheet, which only a workbook names.
    const what = textFile ? "That file" : `The sheet "${name}"`;
    if (data.length > MAX_ROWS_PER_SHEET) {
      throw new SheetReadError(
        "too-big",
        `${what} has more than ${MAX_ROWS_PER_SHEET.toLocaleString("en-US")} rows. Split it into smaller files and bring each one in.`,
      );
    }
    const rows: Array<Array<Cell | null>> = [];
    for (let r = 0; r < data.length; r++) {
      const src = data[r] ?? [];
      const past = src.slice(MAX_COLUMNS).findIndex((c) => cellOf(c) !== null);
      if (past >= 0) {
        throw new SheetReadError(
          "too-big",
          `${what} has values past its ${MAX_COLUMNS}th column (row ${r + 1}, column ${MAX_COLUMNS + past + 1}). Move them into fewer columns, or split it, and bring it in again.`,
        );
      }
      const row: Array<Cell | null> = [];
      for (let c = 0; c < Math.min(src.length, MAX_COLUMNS); c++) {
        const cell = cellOf(src[c]);
        // A spreadsheet stores a guarded cell's apostrophe as formatting; a
        // CSV writes it into the text, and here it comes off again.
        if (cell && textFile && typeof cell.v === "string") row.push({ v: unguardCsvText(cell.v), text: unguardCsvText(cell.text) });
        else row.push(cell);
      }
      rows.push(row);
    }
    for (const m of ws["!merges"] ?? []) {
      const top = rows[m.s.r]?.[m.s.c];
      if (!top) continue;
      for (let r = m.s.r; r <= Math.min(m.e.r, rows.length - 1); r++) {
        const row = rows[r]!;
        for (let c = m.s.c; c <= Math.min(m.e.c, MAX_COLUMNS - 1); c++) {
          if (r === m.s.r && c === m.s.c) continue;
          while (row.length <= c) row.push(null);
          if (!row[c]) row[c] = { ...top, merged: true };
        }
      }
    }
    out.push({ name, hidden, rows });
  });
  return out;
}

/** The export address of a Google Sheets link, or null when the link is not
 *  one. Works for the edit link people copy from the address bar and for a
 *  "Publish to the web" link. */
export function sheetsExportUrl(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.hostname !== "docs.google.com") return null;
  const published = /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=xlsx`;
  const doc = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  if (doc) return `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=xlsx`;
  return null;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Read a response body, stopping at the cap instead of after it: a missing
 *  content-length must not let an endless body fill memory. */
async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  const tooBig = () => new SheetReadError("too-big", `That sheet is over ${max / 1024 / 1024} MB.`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw tooBig();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooBig();
      chunks.push(value);
    }
  } finally {
    // import-swallow-ok: releasing the stream after a read that already ended or refused; nothing is written
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Fetch a Google Sheets link as a workbook. A sheet that is not shared
 *  answers with a sign-in page rather than an error, so the content type is
 *  what tells the two apart. */
export async function fetchSheetsLink(link: string, fetcher: Fetcher): Promise<{ buf: Uint8Array; filename: string }> {
  const url = sheetsExportUrl(link);
  if (!url) {
    throw new SheetReadError("unsupported", "That isn't a Google Sheets link. Copy the address of the sheet from your browser.");
  }
  const res = await fetcher(url);
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403 || res.status === 404 || type.includes("text/html")) {
    throw new SheetReadError(
      "unreadable",
      "That sheet isn't shared. In Google Sheets choose Share, then General access: Anyone with the link can view, and paste the link again.",
    );
  }
  if (!res.ok) throw new SheetReadError("unreadable", `Google Sheets answered ${res.status}. Try again in a moment.`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) throw new SheetReadError("too-big", `That sheet is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const buf = await readBounded(res, MAX_FILE_BYTES);
  const disposition = res.headers.get("content-disposition") ?? "";
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  return { buf, filename: named ? decodeURIComponent(named) : "sheet.xlsx" };
}
