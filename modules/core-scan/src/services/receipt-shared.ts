// Shared receipt types + coercion helpers — used by both the deterministic
// parsers (receipt-deterministic.ts) and the AI shaper (receipt.ts). Kept in
// its own module so neither imports the other (no cycle).

export interface ReceiptLine {
  description: string;
  qty: number;
  unit_price: number | null;
  line_total: number | null;
}

export interface ParsedReceipt {
  vendor: string | null;
  /** ISO YYYY-MM-DD when the receipt's date is parseable, else null. */
  date: string | null;
  /** ISO-4217 code, uppercased, when stated. */
  currency: string | null;
  total: number | null;
  items: ReceiptLine[];
}

/** How a receipt was read — surfaced on the result + stamped into each inbox
 *  row's metadata so triage (and debugging) knows whether a line came from a
 *  deterministic parse or the AI fallback. */
export type ParseMethod = "csv" | "pdf-table" | "ai-chat" | "ai-vision";

export type ReceiptResult =
  | { ok: true; receipt: ParsedReceipt; method: ParseMethod }
  | { ok: false; reason: string };

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Strip currency symbols, thousands separators, spaces; keep digits/./-.
    // A trailing/leading minus or parens (accounting negatives) → negative.
    const neg = /^\s*\(.*\)\s*$/.test(v) || /-/.test(v);
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Assemble + validate a receipt from loose parts. Returns null when there are
 *  no usable line items (a blank/garbled parse), so the caller can fall through
 *  to the next tier. Drops blank-description lines; defaults qty to 1. */
export function buildReceipt(parts: {
  vendor?: unknown;
  date?: unknown;
  currency?: unknown;
  total?: unknown;
  items: Array<{ description?: unknown; qty?: unknown; unit_price?: unknown; line_total?: unknown }>;
}): ParsedReceipt | null {
  const items: ReceiptLine[] = [];
  for (const it of parts.items) {
    const description = str(it.description);
    if (!description) continue;
    items.push({
      description: description.slice(0, 300),
      qty: num(it.qty) ?? 1,
      unit_price: num(it.unit_price),
      line_total: num(it.line_total),
    });
  }
  if (items.length === 0) return null;
  const currency = str(parts.currency);
  return {
    vendor: str(parts.vendor),
    date: isoDate(parts.date),
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    total: num(parts.total),
    items,
  };
}
