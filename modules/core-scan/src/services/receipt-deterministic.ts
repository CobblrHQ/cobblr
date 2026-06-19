// Deterministic receipt parsing — NO AI. Two tiers feed the orchestrator in
// receipt.ts ahead of the AI fallback:
//
//   • CSV  — a vendor's CSV export. Header-mapped (description/qty/price/amount),
//            rock-solid, zero guessing.
//   • PDF table — pdf-parse v2's getTable() pulls ruled/columnar tables out of a
//            text PDF as rows of cells; we map them the same way. Header-first,
//            with a conservative headerless fallback. Returns null (→ AI) the
//            moment it isn't confident, so a wrong deterministic read never wins.
//
// Both go through one rows→items mapper so CSV and PDF behave identically.

import { buildReceipt, isoDate, num, str, type ParsedReceipt } from "./receipt-shared.js";

const SYMBOL_CURRENCY: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/** Best-effort fill of vendor/date/currency/total from a receipt's full text,
 *  for the deterministic table path (the line-item table rarely carries the
 *  header meta). Only fills fields the parse left null. */
export function enrichReceiptMeta(receipt: ParsedReceipt, text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] && lines[0].length <= 60 ? lines[0] : null;
  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  const totalMatch = text.match(/\b(?:grand\s+)?total\b[^0-9]{0,12}([$€£¥]?\s?[\d,]+\.\d{2})/i);
  const curMatch = text.match(/[$€£¥]|\b(USD|EUR|GBP|CAD|AUD|JPY)\b/);
  const cur = curMatch ? (SYMBOL_CURRENCY[curMatch[0]] ?? curMatch[0].toUpperCase()) : null;
  return {
    ...receipt,
    vendor: receipt.vendor ?? firstLine,
    date: receipt.date ?? (dateMatch ? isoDate(dateMatch[1]) : null),
    total: receipt.total ?? (totalMatch ? num(totalMatch[1]) : null),
    currency: receipt.currency ?? cur,
  };
}

// ── column classification (shared by CSV + PDF tables) ───────────────────────

type Col = "desc" | "qty" | "unit" | "amount";

/** Classify a header cell. Order matters: the more specific multi-word headers
 *  ("unit price", "line total") are tested before the bare word. */
function classifyHeader(cell: string): Col | null {
  const c = cell.toLowerCase().trim();
  if (!c) return null;
  // "unit price"/"unit cost" must win over qty (which would otherwise eat the
  // bare word "unit"), so test it FIRST.
  if (/unit\s*price|unit\s*cost|price\s*each|\brate\b|u\/?price/.test(c)) return "unit";
  if (/(^|\b)(qty|quantity|count)(\b|$)|\bunits\b/.test(c)) return "qty";
  if (/description|item|product|name|details?|particular/.test(c)) return "desc";
  if (/amount|line\s*total|ext(ended)?\s*price|subtotal|\bnet\b|\btotal\b|\bprice\b|\bcost\b/.test(c))
    return "amount";
  return null;
}

/** Find a header row + its column→index map. A row qualifies as a header when it
 *  names a description column AND at least one price/qty column. */
function detectHeader(rows: string[][]): { headerIdx: number; map: Partial<Record<Col, number>> } | null {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const map: Partial<Record<Col, number>> = {};
    rows[i]!.forEach((cell, idx) => {
      const col = classifyHeader(cell);
      if (col && map[col] === undefined) map[col] = idx;
    });
    if (map.desc !== undefined && (map.amount !== undefined || map.unit !== undefined || map.qty !== undefined)) {
      return { headerIdx: i, map };
    }
  }
  return null;
}

function priceLike(cell: string): boolean {
  return /\d/.test(cell) && /^[\s$€£¥]*-?\(?[\d,]+\.?\d*\)?[\s$€£¥]*$/.test(cell.trim());
}

/** Map header-aligned rows to line items. */
function mapWithHeader(rows: string[][], headerIdx: number, map: Partial<Record<Col, number>>): ParsedReceipt | null {
  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]!;
    const description = map.desc !== undefined ? str(cells[map.desc]) : null;
    if (!description) continue;
    // Skip summary rows (subtotal / tax / shipping / total) — captured separately.
    if (/^(sub\s*total|total|tax|vat|gst|shipping|freight|discount|balance)\b/i.test(description)) continue;
    const unit = map.unit !== undefined ? num(cells[map.unit]) : null;
    const amount = map.amount !== undefined ? num(cells[map.amount]) : null;
    const qty = map.qty !== undefined ? num(cells[map.qty]) : null;
    items.push({ description, qty: qty ?? 1, unit_price: unit, line_total: amount ?? null });
  }
  return buildReceipt({ items });
}

/** Headerless fallback: rows where a trailing cell is a price and the leading
 *  cells are text. Conservative — needs ≥2 such rows, else returns null. */
function mapHeaderless(rows: string[][]): ParsedReceipt | null {
  const items: Array<{ description: string; qty: number; unit_price: number | null; line_total: number | null }> = [];
  for (const cells of rows) {
    if (cells.length < 2) continue;
    // last price-like cell = line total; first text cell(s) = description.
    let amountIdx = -1;
    for (let j = cells.length - 1; j >= 0; j--) {
      if (priceLike(cells[j]!)) { amountIdx = j; break; }
    }
    if (amountIdx <= 0) continue;
    const desc = cells.slice(0, amountIdx).filter((c) => str(c) && !priceLike(c)).join(" ").trim();
    if (!desc) continue;
    if (/^(sub\s*total|total|tax|vat|gst|shipping|freight|discount|balance)\b/i.test(desc)) continue;
    // a bare small integer among the leading cells = qty
    const qtyCell = cells.slice(0, amountIdx).find((c) => /^\d{1,4}$/.test(c.trim()));
    items.push({
      description: desc,
      qty: qtyCell ? num(qtyCell) ?? 1 : 1,
      unit_price: null,
      line_total: num(cells[amountIdx]),
    });
  }
  if (items.length < 2) return null;
  return buildReceipt({ items });
}

function rowsToReceipt(rows: string[][], allowHeaderless: boolean): ParsedReceipt | null {
  const clean = rows.filter((r) => r.some((c) => str(c)));
  if (clean.length === 0) return null;
  const header = detectHeader(clean);
  if (header) return mapWithHeader(clean, header.headerIdx, header.map);
  return allowHeaderless ? mapHeaderless(clean) : null;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Tolerant RFC-4180 CSV → rows of cells (handles quotes, escaped quotes,
 *  commas/newlines inside quotes, CRLF). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Parse a CSV export into a receipt. Header REQUIRED (a CSV with no recognisable
 *  columns falls through to AI rather than guessing positionally). */
export function parseCsvReceipt(text: string): ParsedReceipt | null {
  if (!text.trim()) return null;
  const rows = parseCsvRows(text);
  if (rows.length < 2) return null;
  return rowsToReceipt(rows, false);
}

// ── PDF tables ───────────────────────────────────────────────────────────────

/** Parse pdf-parse getTable() output (an array of tables, each = rows of cells)
 *  into a receipt. Tries each discovered table; the first that yields line items
 *  wins. Returns null when no table looks like line items (→ AI fallback). */
export function parsePdfTableReceipt(tables: string[][][]): ParsedReceipt | null {
  for (const table of tables) {
    const r = rowsToReceipt(table, true);
    if (r && r.items.length > 0) return r;
  }
  return null;
}
