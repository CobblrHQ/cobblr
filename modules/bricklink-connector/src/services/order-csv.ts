// BrickLink order CSV parser.
//
// When a BL user completes an order they can download a CSV with
// the line items. The header row is BL's standard shape; columns
// are present even when the value isn't (BL leaves empty cells, not
// missing columns). A realistic file:
//
//   Order ID,Lot ID,Item No,Item Type,Color ID,Condition,Qty,Each,Order Total,Item Description,Item Remarks,…
//   12345678,11111111,3001,P,5,U,4,0.05,0.20,Brick 2 x 4,Red,…
//
// We accept loose quoting (BL escapes embedded commas with double-
// quotes) and tolerate CRLF / LF / mixed. We do NOT try to validate
// every field — the consumer (a future commit-order endpoint) cares
// about a subset: item_id + item_type + color + qty + unit price.
// Everything else passes through as `extras` for later use.

export interface ParsedOrderLine {
  /** BL's order-id column when present (multiple rows can share one). */
  order_id: string | null;
  /** Lot-id when present — unique per lot the seller pulled from. */
  lot_id: string | null;
  /** Design / set / fig number. Maps to Rebrickable's `part_num` for
   *  item_type='P' rows. */
  item_id: string;
  /** P=Part, S=Set, M=Minifig, B=Book, etc. — same enum as the
   *  wanted-list parser. */
  item_type: "P" | "S" | "M" | "B" | "G" | "C" | "I" | "O";
  /** BL color id; -1 for items without a color. */
  color_id: number;
  /** N=new, U=used, A=any. */
  condition: "N" | "U" | "A";
  /** Number of units in the line. */
  qty: number;
  /** Per-unit price as a number — never a string. */
  unit_price: number;
  /** qty * unit_price, computed if BL's "Order Total" column is
   *  absent or unparseable. */
  line_total: number;
  /** Human description ("Brick 2 x 4"). */
  description: string | null;
  /** BL "Item Remarks" — usually a color name or condition note. */
  remarks: string | null;
  /** Anything we didn't strongly type, keyed by lowercased header. */
  extras: Record<string, string>;
}

export interface OrderCsvParseResult {
  lines: ParsedOrderLine[];
  warnings: string[];
  /** Aggregated metadata pulled out of the header columns. */
  summary: {
    line_count: number;
    parts: number;
    sets: number;
    total: number;
    order_id: string | null;
  };
}

/** Split a CSV row honoring double-quoted fields (BL's escape style).
 *  Doesn't try to handle every CSV edge case — BL is consistent. */
function splitRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (inQ) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "_");
}

const FIELD_ALIASES: Record<string, string[]> = {
  order_id: ["order_id", "order"],
  lot_id: ["lot_id", "lot"],
  item_id: ["item_no", "item_number", "item_id", "design", "design_id", "part_no"],
  item_type: ["item_type", "type"],
  color_id: ["color_id", "color"],
  condition: ["condition", "new_used"],
  qty: ["qty", "quantity"],
  unit_price: ["each", "unit_price", "price_each"],
  line_total: ["order_total", "line_total", "total"],
  description: ["item_description", "description"],
  remarks: ["item_remarks", "remarks", "notes"],
};

function buildColumnMap(headerCells: string[]): Map<string, number> {
  const norm = headerCells.map(normalize);
  const map = new Map<string, number>();
  for (const [logical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const a of aliases) {
      const idx = norm.indexOf(a);
      if (idx !== -1) {
        map.set(logical, idx);
        break;
      }
    }
  }
  return map;
}

function toItemType(raw: string): ParsedOrderLine["item_type"] {
  const t = raw.trim().toUpperCase();
  if (["P", "S", "M", "B", "G", "C", "I", "O"].includes(t)) {
    return t as ParsedOrderLine["item_type"];
  }
  return "P";
}

function toCondition(raw: string): ParsedOrderLine["condition"] {
  const t = raw.trim().toUpperCase();
  if (t === "N" || t === "U") return t;
  return "A";
}

function parseMoney(raw: string): number {
  if (!raw) return 0;
  // Strip currency symbols + thousands separators (BL is usually
  // bare numbers but defensive).
  const cleaned = raw.replace(/[$€£,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function parseOrderCsv(csv: string): OrderCsvParseResult {
  const warnings: string[] = [];
  const lines: ParsedOrderLine[] = [];

  // BL files are CRLF most of the time; tolerate everything.
  const rows = csv.replace(/\r\n?/g, "\n").split("\n").filter((r) => r.length > 0);
  if (rows.length === 0) {
    return {
      lines: [],
      warnings: ["empty CSV"],
      summary: { line_count: 0, parts: 0, sets: 0, total: 0, order_id: null },
    };
  }
  const headerCells = splitRow(rows[0]!);
  const cols = buildColumnMap(headerCells);
  if (!cols.has("item_id") || !cols.has("qty")) {
    warnings.push(
      `CSV header missing required columns. Need item_id + qty. Got: ${headerCells.join(", ")}`,
    );
    return {
      lines: [],
      warnings,
      summary: { line_count: 0, parts: 0, sets: 0, total: 0, order_id: null },
    };
  }
  const get = (cells: string[], key: string) => {
    const idx = cols.get(key);
    return idx === undefined ? "" : (cells[idx] ?? "").trim();
  };

  for (let r = 1; r < rows.length; r++) {
    const cells = splitRow(rows[r]!);
    const itemId = get(cells, "item_id");
    if (!itemId) {
      warnings.push(`Row ${r + 1}: missing item_id, skipped`);
      continue;
    }
    const qty = Number(get(cells, "qty") || "0");
    if (!Number.isFinite(qty) || qty <= 0) {
      warnings.push(`Row ${r + 1} (item ${itemId}): bad qty ${qty}, skipped`);
      continue;
    }
    const unitPrice = parseMoney(get(cells, "unit_price"));
    const lineTotalRaw = parseMoney(get(cells, "line_total"));
    // Collect any non-mapped columns as extras for downstream use.
    const extras: Record<string, string> = {};
    for (let i = 0; i < headerCells.length; i++) {
      const norm = normalize(headerCells[i] ?? "");
      const mapped = [...cols.entries()].some(([_, idx]) => idx === i);
      if (!mapped && cells[i]) extras[norm] = (cells[i] ?? "").trim();
    }
    lines.push({
      order_id: get(cells, "order_id") || null,
      lot_id: get(cells, "lot_id") || null,
      item_id: itemId,
      item_type: toItemType(get(cells, "item_type") || "P"),
      color_id: Number(get(cells, "color_id") || "-1"),
      condition: toCondition(get(cells, "condition") || "A"),
      qty,
      unit_price: unitPrice,
      line_total: lineTotalRaw > 0 ? lineTotalRaw : qty * unitPrice,
      description: get(cells, "description") || null,
      remarks: get(cells, "remarks") || null,
      extras,
    });
  }

  const total = lines.reduce((s, l) => s + l.line_total, 0);
  const orderId = lines.find((l) => l.order_id)?.order_id ?? null;
  return {
    lines,
    warnings,
    summary: {
      line_count: lines.length,
      parts: lines.filter((l) => l.item_type === "P").length,
      sets: lines.filter((l) => l.item_type === "S").length,
      total: Math.round(total * 100) / 100,
      order_id: orderId,
    },
  };
}
