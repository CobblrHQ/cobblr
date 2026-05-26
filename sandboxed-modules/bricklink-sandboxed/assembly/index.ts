// bricklink-sandboxed — wasm port of bricklink-connector.
//
// Three routes:
//   parse-wanted-list  — accepts { xml }, returns parsed items.
//   parse-order        — accepts { csv }, returns parsed lines.
//   diff-wanted-list   — accepts { items }, buckets each as
//                        have/partial/need/no-catalog-match. Uses
//                        CATALOGS_QUERY_ENTRIES (lego.part) +
//                        PAIRINGS_FIND_BY_TARGETS + a cross-module
//                        TENANT_QUERY against inventory_parts
//                        (declared in manifest.reads.inventory).
//
// XML/CSV parsing is hand-rolled with indexOf/substring — AS doesn't
// ship a regex engine, and the BL format is simple enough that
// O(N) scans suffice. The same parsers ran as TypeScript in the
// in-process connector; the algorithms map 1:1.

import {
  log,
  activityLog,
  tenantQuery,
  pairingsFindByTargets,
  catalogsQueryEntries,
  getRequestBody,
  respond,
  jsonStr,
} from "./sdk";

// SDK helpers must stay reachable so AS doesn't DCE them. The host
// runtime probes for cobblr_alloc to pin response buffers.
export { cobblr_alloc, cobblr_dealloc } from "./sdk";

// ─── /parse-wanted-list ──────────────────────────────────────────

export function parse_wanted_list(): void {
  const reqEnv = getRequestBody();
  const body = extractStringField(reqEnv, "body");
  const xml = extractStringField(body, "xml");
  if (xml.length === 0) {
    respond('{"error":"xml field required"}', 400);
    return;
  }
  const items = parseWantedListItems(xml);
  const json = serializeWantedItems(items);
  activityLog("parse_wanted_list", "parsed " + items.length.toString() + " item(s)");
  respond(
    '{"items":' + json + ',"counts":' + countsJson(items) + "}",
    200,
  );
}

// ─── /parse-order ────────────────────────────────────────────────

export function parse_order(): void {
  const reqEnv = getRequestBody();
  const body = extractStringField(reqEnv, "body");
  const csv = extractStringField(body, "csv");
  if (csv.length === 0) {
    respond('{"error":"csv field required"}', 400);
    return;
  }
  const lines = parseOrderCsv(csv);
  const json = serializeOrderLines(lines);
  activityLog("parse_order", "parsed " + lines.length.toString() + " line(s)");
  respond(
    '{"lines":' + json + ',"summary":' + summarizeOrder(lines) + "}",
    200,
  );
}

// ─── /diff-wanted-list ───────────────────────────────────────────
//
// Reads a parsed wanted-list off the request body (`items` array,
// each `{ item_type, item_id, color_id, min_qty }`), looks up
// catalog entries, walks pairings to inventory:part rows, queries
// inventory_parts via the cross-module read, and buckets each
// wanted item.

export function diff_wanted_list(): void {
  const reqEnv = getRequestBody();
  const body = extractStringField(reqEnv, "body");
  // Pull item_id list. The body is the entire JSON the caller
  // POST'd; we scan for all "item_id":"..." occurrences. Same
  // technique the url-archive module uses to extract pending rows.
  const itemIds = extractAllItemIds(body);
  if (itemIds.length === 0) {
    respond('{"entries":[],"counts":{"have":0,"partial":0,"need":0,"unmatched":0}}', 200);
    return;
  }
  // 1. Find catalog entries by external_id IN itemIds (semantic
  //    type lego.part). The host returns entries the workspace's
  //    rebrickable-parts catalog has indexed.
  const catalogResult = catalogsQueryEntries(
    '{"semantic_type":"lego.part","external_id_in":' + jsonArrayStr(itemIds) + ',"limit":' + itemIds.length.toString() + "}",
  );
  const catalogEntryIds = extractAllJsonFieldValues(catalogResult, "id");
  if (catalogEntryIds.length === 0) {
    // No catalog matches → every wanted item is unmatched.
    respond('{"entries":[],"counts":{"have":0,"partial":0,"need":0,"unmatched":' + itemIds.length.toString() + "}}", 200);
    return;
  }
  // 2. Find inventory:part rows pointing at those catalog entries.
  const pairResult = pairingsFindByTargets(
    "inventory:part",
    "core-catalogs:entry",
    jsonArrayStr(catalogEntryIds),
    "matches",
  );
  const partIds = extractAllJsonFieldValues(pairResult, "sourceId");
  let have = 0;
  let partial = 0;
  let need = 0;
  if (partIds.length === 0) {
    // No inventory matches → every wanted item is need.
    need = itemIds.length;
  } else {
    // 3. Cross-module read: SELECT id, qty FROM inventory_parts
    //    WHERE id IN (...). We can SELECT inventory_parts because
    //    the manifest declares reads.inventory = ["parts"].
    //    Build a simple IN-clause via placeholders.
    let placeholders = "";
    for (let i = 0; i < partIds.length; i++) {
      if (i > 0) placeholders += ",";
      placeholders += "?::uuid";
    }
    const sqlText = "SELECT id::text AS id, qty::text AS qty FROM inventory_parts WHERE id IN (" + placeholders + ")";
    const invResult = tenantQuery(sqlText, jsonArrayStr(partIds));
    // Sum qty across rows. Each row is { id, qty } as strings.
    const qtyTotal = sumQtyField(invResult);
    // Heuristic bucket: if total stock >= total wanted, have; if
    // > 0, partial; else need. The in-process module's
    // per-color matching is intentionally simplified here.
    let totalWanted = 0;
    // Count wanted by re-extracting min_qty values; fall back
    // to N items each = 1 if min_qty isn't present.
    const minQtys = extractAllJsonFieldValues(body, "min_qty");
    for (let i = 0; i < minQtys.length; i++) {
      const n = parseI32(minQtys[i]);
      totalWanted += n > 0 ? n : 1;
    }
    if (totalWanted === 0) totalWanted = itemIds.length;
    if (qtyTotal >= totalWanted) {
      have = itemIds.length;
    } else if (qtyTotal > 0) {
      partial = itemIds.length;
    } else {
      need = itemIds.length;
    }
  }
  const unmatched = itemIds.length - have - partial - need;
  activityLog(
    "diff_wanted_list",
    "have=" + have.toString() + " partial=" + partial.toString() + " need=" + need.toString(),
  );
  respond(
    '{"counts":{"have":' + have.toString() +
      ',"partial":' + partial.toString() +
      ',"need":' + need.toString() +
      ',"unmatched":' + unmatched.toString() + "}}",
    200,
  );
}

// ─── BL wanted-list parser ────────────────────────────────────────

class WantedItem {
  item_type: string;
  item_id: string;
  color_id: i32;
  min_qty: i32;
  constructor(t: string, id: string, c: i32, q: i32) {
    this.item_type = t;
    this.item_id = id;
    this.color_id = c;
    this.min_qty = q;
  }
}

function parseWantedListItems(xml: string): WantedItem[] {
  const items: WantedItem[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<ITEM>", cursor);
    if (open < 0) break;
    const close = xml.indexOf("</ITEM>", open);
    if (close < 0) break;
    const block = xml.substring(open + 6, close);
    const itemType = readTag(block, "ITEMTYPE", "P");
    const itemId = readTag(block, "ITEMID", "");
    if (itemId.length === 0) {
      cursor = close + 7;
      continue;
    }
    const colorRaw = readTag(block, "COLOR", "");
    const colorId = colorRaw.length === 0 ? -1 : parseI32(colorRaw);
    const minQtyRaw = readTag(block, "MINQTY", "1");
    const minQty = parseI32(minQtyRaw);
    items.push(new WantedItem(itemType, itemId, colorId, minQty > 0 ? minQty : 1));
    cursor = close + 7;
  }
  return items;
}

function readTag(block: string, tag: string, fallback: string): string {
  const open = "<" + tag + ">";
  const close = "</" + tag + ">";
  const oi = block.indexOf(open);
  if (oi < 0) return fallback;
  const ci = block.indexOf(close, oi + open.length);
  if (ci < 0) return fallback;
  return block.substring(oi + open.length, ci).trim();
}

function serializeWantedItems(items: WantedItem[]): string {
  let out = "[";
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ",";
    const it = items[i];
    out += "{\"item_type\":" + jsonStr(it.item_type) +
      ",\"item_id\":" + jsonStr(it.item_id) +
      ",\"color_id\":" + it.color_id.toString() +
      ",\"min_qty\":" + it.min_qty.toString() + "}";
  }
  out += "]";
  return out;
}

function countsJson(items: WantedItem[]): string {
  let parts = 0;
  let sets = 0;
  let minifigs = 0;
  for (let i = 0; i < items.length; i++) {
    const t = items[i].item_type;
    if (t === "P") parts++;
    else if (t === "S") sets++;
    else if (t === "M") minifigs++;
  }
  return '{"items":' + items.length.toString() +
    ',"parts":' + parts.toString() +
    ',"sets":' + sets.toString() +
    ',"minifigs":' + minifigs.toString() + "}";
}

// ─── BL order CSV parser ─────────────────────────────────────────

class OrderLine {
  item_id: string;
  item_type: string;
  qty: i32;
  unit_price: f64;
  constructor(id: string, t: string, q: i32, p: f64) {
    this.item_id = id;
    this.item_type = t;
    this.qty = q;
    this.unit_price = p;
  }
}

function parseOrderCsv(csv: string): OrderLine[] {
  const lines: OrderLine[] = [];
  const normalized = csv.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // First line: header. Find column indices for the four fields
  // we strongly type (item_id, item_type, qty, unit_price). The
  // BL CSV uses fairly stable column names; we accept a few aliases.
  const firstNl = normalized.indexOf("\n");
  if (firstNl < 0) return lines;
  const header = normalized.substring(0, firstNl);
  const headerCells = splitCsvRow(header);
  let idxItemId: i32 = -1;
  let idxItemType: i32 = -1;
  let idxQty: i32 = -1;
  let idxPrice: i32 = -1;
  for (let i = 0; i < headerCells.length; i++) {
    const c = headerCells[i].toLowerCase().replaceAll(" ", "_");
    if (c === "item_no" || c === "item_id" || c === "design") idxItemId = i;
    else if (c === "item_type" || c === "type") idxItemType = i;
    else if (c === "qty" || c === "quantity") idxQty = i;
    else if (c === "each" || c === "unit_price" || c === "price_each") idxPrice = i;
  }
  if (idxItemId < 0 || idxQty < 0) return lines;
  let cursor = firstNl + 1;
  while (cursor < normalized.length) {
    const next = normalized.indexOf("\n", cursor);
    const rowEnd = next < 0 ? normalized.length : next;
    if (rowEnd > cursor) {
      const row = normalized.substring(cursor, rowEnd);
      if (row.length > 0) {
        const cells = splitCsvRow(row);
        if (idxItemId < cells.length && idxQty < cells.length) {
          const itemId = cells[idxItemId];
          const itemType = idxItemType >= 0 && idxItemType < cells.length ? cells[idxItemType] : "P";
          const qty = parseI32(cells[idxQty]);
          const unitPrice = idxPrice >= 0 && idxPrice < cells.length ? parseF64(cells[idxPrice]) : 0.0;
          if (itemId.length > 0 && qty > 0) {
            lines.push(new OrderLine(itemId, itemType, qty, unitPrice));
          }
        }
      }
    }
    if (next < 0) break;
    cursor = next + 1;
  }
  return lines;
}

function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i);
    if (inQ) {
      if (c === 0x22) {
        if (i + 1 < row.length && row.charCodeAt(i + 1) === 0x22) {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += String.fromCharCode(c);
      }
    } else {
      if (c === 0x22) {
        inQ = true;
      } else if (c === 0x2c) {
        out.push(cur);
        cur = "";
      } else {
        cur += String.fromCharCode(c);
      }
    }
  }
  out.push(cur);
  return out;
}

function serializeOrderLines(lines: OrderLine[]): string {
  let out = "[";
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out += ",";
    const l = lines[i];
    out += "{\"item_id\":" + jsonStr(l.item_id) +
      ",\"item_type\":" + jsonStr(l.item_type) +
      ",\"qty\":" + l.qty.toString() +
      ",\"unit_price\":" + l.unit_price.toString() +
      ",\"line_total\":" + (<f64>l.qty * l.unit_price).toString() + "}";
  }
  out += "]";
  return out;
}

function summarizeOrder(lines: OrderLine[]): string {
  let parts = 0;
  let sets = 0;
  let total: f64 = 0.0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    total += <f64>l.qty * l.unit_price;
    if (l.item_type === "P") parts++;
    else if (l.item_type === "S") sets++;
  }
  return '{"line_count":' + lines.length.toString() +
    ',"parts":' + parts.toString() +
    ',"sets":' + sets.toString() +
    ',"total":' + total.toString() + "}";
}

// ─── JSON-walker helpers ─────────────────────────────────────────

function extractStringField(jsonStrIn: string, key: string): string {
  const marker = '"' + key + '":';
  const at = jsonStrIn.indexOf(marker);
  if (at < 0) return "";
  let i = at + marker.length;
  while (i < jsonStrIn.length) {
    const c = jsonStrIn.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++;
      continue;
    }
    break;
  }
  if (i >= jsonStrIn.length || jsonStrIn.charCodeAt(i) !== 0x22) return "";
  i++;
  let out = "";
  while (i < jsonStrIn.length) {
    const c = jsonStrIn.charCodeAt(i);
    if (c === 0x5c && i + 1 < jsonStrIn.length) {
      const next = jsonStrIn.charCodeAt(i + 1);
      if (next === 0x22) out += '"';
      else if (next === 0x5c) out += "\\";
      else if (next === 0x2f) out += "/";
      else if (next === 0x6e) out += "\n";
      else if (next === 0x72) out += "\r";
      else if (next === 0x74) out += "\t";
      else out += String.fromCharCode(next);
      i += 2;
      continue;
    }
    if (c === 0x22) return out;
    out += String.fromCharCode(c);
    i++;
  }
  return out;
}

// All "key":"value" string-typed occurrences anywhere in the doc.
function extractAllJsonFieldValues(jsonStrIn: string, key: string): string[] {
  const marker = '"' + key + '":"';
  const out: string[] = [];
  let from = 0;
  while (true) {
    const at = jsonStrIn.indexOf(marker, from);
    if (at < 0) break;
    let i = at + marker.length;
    let val = "";
    while (i < jsonStrIn.length) {
      const c = jsonStrIn.charCodeAt(i);
      if (c === 0x5c && i + 1 < jsonStrIn.length) {
        val += String.fromCharCode(jsonStrIn.charCodeAt(i + 1));
        i += 2;
        continue;
      }
      if (c === 0x22) break;
      val += String.fromCharCode(c);
      i++;
    }
    out.push(val);
    from = i + 1;
  }
  return out;
}

function extractAllItemIds(jsonStrIn: string): string[] {
  return extractAllJsonFieldValues(jsonStrIn, "item_id");
}

function jsonArrayStr(items: string[]): string {
  let out = "[";
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ",";
    out += jsonStr(items[i]);
  }
  out += "]";
  return out;
}

function sumQtyField(jsonStrIn: string): i32 {
  // Look for "qty":"N" string-typed occurrences (Postgres cast as
  // ::text). Parse each.
  const qtys = extractAllJsonFieldValues(jsonStrIn, "qty");
  let total: i32 = 0;
  for (let i = 0; i < qtys.length; i++) {
    total += parseI32(qtys[i]);
  }
  return total;
}

function parseI32(s: string): i32 {
  let v: i32 = 0;
  let i = 0;
  let neg = false;
  if (s.length > 0 && s.charCodeAt(0) === 0x2d) {
    neg = true;
    i = 1;
  }
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    v = v * 10 + (c - 0x30);
    i++;
  }
  return neg ? -v : v;
}

function parseF64(s: string): f64 {
  // Strip a leading $ sign (BL CSVs are usually bare numbers but
  // defensive).
  let trimmed = s;
  if (trimmed.length > 0 && trimmed.charCodeAt(0) === 0x24) trimmed = trimmed.substring(1);
  return F64.parseFloat(trimmed);
}

// jsonStr is imported from the SDK; suppress AS's unused warning
// by referencing the log helper here (also used in handlers).
function _suppressUnused(): void {
  log("");
}
