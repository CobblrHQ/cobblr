// Work out what a spreadsheet says, by rule, before anything is asked of a
// model: which row is the header (it is often under a title and a blank line),
// what each column holds, which values repeat enough to be a list of choices,
// and which columns carry the thing's name, its key, where it is kept and what
// kind of thing it is. Pure: grids in, a description out.
//
// Nothing is dropped without a reason. Every column comes back, even one with
// a header and no values. Every row that is not a record (a title, a blank
// line, a repeated header, a total, a section heading) comes back in
// `skipped` with the reason, and a section heading's text is carried onto the
// rows under it as a column of its own, because "Fridge" written once above
// six rows is the location of those six things.

import { productCodeKind } from "@cobblr/platform-contract/identifier-check";
import type { Cell, RawSheet } from "./sheet-read.js";

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

// VOCAB-ENUMERATION OK: a spreadsheet column's own roles, declared here; not the field-role vocabulary
export type ColumnRole = "name" | "key" | "quantity" | "location" | "category" | "photo" | "notes";

export type DateOrder = "ymd" | "mdy" | "dmy";

export interface UnderstoodColumn {
  /** Position in the sheet; -1 for a column made from section headings. */
  index: number;
  /** Spreadsheet letter ("C"), empty for a derived column. */
  letter: string;
  header: string;
  /** The header as written: [group, leaf] under a merged group header. */
  header_parts: string[];
  derived?: "section";
  type: ColumnType;
  role: ColumnRole | null;
  choices?: string[];
  unit?: string | null;
  currency?: string | null;
  code_kind?: "isbn" | "gtin";
  date_order?: DateOrder;
  /** Every date in the column reads both ways (03/04 is March or April). */
  date_ambiguous?: boolean;
  /** Values read like "Garage / Shelf 2": a place inside a place. */
  path?: boolean;
  filled: number;
  distinct: number;
  unique: boolean;
  samples: string[];
  /** Values that do not fit the column's type, kept as written. */
  odd: { count: number; samples: string[] };
}

/** A quantity keeps the words it was written with ("3 cans") beside the
 *  amount and the normalised unit, so showing it again never says "3 can". */
export type Value = string | number | boolean | string[] | { amount: number; unit: string | null; text: string } | null;

export interface UnderstoodRow {
  /** 1-based row number as the spreadsheet shows it. */
  row: number;
  values: Value[];
}

/** `excluded`: a person left the row out in the dry run. */
export type SkipReason = "title" | "blank" | "repeated-header" | "total" | "section" | "excluded";

export interface SkippedRow {
  row: number;
  reason: SkipReason;
  text?: string;
}

export interface UnderstoodSheet {
  name: string;
  hidden: boolean;
  truncated: boolean;
  empty: boolean;
  title: string | null;
  /** 1-based; null for an empty sheet. */
  header_row: number | null;
  columns: UnderstoodColumn[];
  rows: UnderstoodRow[];
  skipped: SkippedRow[];
}

export interface UnderstandOptions {
  /** How to read 03/04/2025 when nothing in the column settles it. */
  locale?: string;
}

// ─── cell readers ────────────────────────────────────────────────────────────

const CURRENCY_RE = /[$€£¥₹]|\b(USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY)\b/i;

function textOf(c: Cell): string {
  // A whole number keeps every digit: a 13-digit ISBN stored as a number
  // DISPLAYS as 9.78044E+12 in a narrow General column.
  if (typeof c.v === "number" && Number.isInteger(c.v) && Math.abs(c.v) >= 1e7 && !CURRENCY_RE.test(c.text)) {
    return String(c.v);
  }
  return c.text;
}

export function parseNumber(raw: string): number | null {
  let t = raw.trim().replace(CURRENCY_RE, "").replace(/\s/g, "");
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/%$/, "");
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// VOCAB-ENUMERATION OK: unit words as written in a cell ("2 pack"), a declared list, not field roles
const UNITS = [
  "mg", "g", "kg", "lb", "lbs", "oz", "ml", "cl", "l", "fl oz", "gal", "pcs", "pc", "pieces", "piece", "ea", "each",
  "mm", "cm", "m", "ft", "in", "pack", "packs", "can", "cans", "bottle", "bottles", "roll", "rolls", "spool", "spools",
  "box", "boxes", "bag", "bags", "jar", "jars", "x",
];
const QTY_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(${UNITS.map((u) => u.replace(" ", "\\s")).join("|")})\\.?$`, "i");

export function parseQuantity(raw: string): { amount: number; unit: string | null } | null {
  const t = raw.trim();
  const m = QTY_RE.exec(t);
  if (m) return { amount: Number(m[1]!.replace(",", ".")), unit: normaliseUnit(m[2]!) };
  const n = parseNumber(t);
  return n === null || CURRENCY_RE.test(t) ? null : { amount: n, unit: null };
}

function normaliseUnit(u: string): string {
  const l = u.toLowerCase().replace(/\s+/g, " ");
  if (l === "l") return "L";
  if (l === "lbs") return "lb";
  if (l === "pc" || l === "pcs" || l === "piece" || l === "pieces" || l === "ea" || l === "each" || l === "x") return "pcs";
  if (l === "boxes") return "box";
  if (/^(can|bottle|roll|spool|bag|jar|pack)s$/.test(l)) return l.slice(0, -1);
  return l;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

/** The parts of a written date, before deciding which number is the month. */
function dateParts(raw: string): { a: number; b: number; y: number } | { iso: string } | null {
  const t = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) {
    const s = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return s ? { iso: s } : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t);
  if (m) return { a: Number(m[1]), b: Number(m[2]), y: fullYear(Number(m[3])) };
  // "12 Mar 2024", "March 12, 2024", "Mar 2024"
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const s = mo >= 0 ? iso(fullYear(Number(m[3])), mo + 1, Number(m[1])) : null;
    return s ? { iso: s } : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    const s = mo >= 0 ? iso(fullYear(Number(m[3])), mo + 1, Number(m[2])) : null;
    return s ? { iso: s } : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    const s = mo >= 0 ? iso(Number(m[2]), mo + 1, 1) : null;
    return s ? { iso: s } : null;
  }
  return null;
}

export function parseDate(c: Cell | string, order: DateOrder): string | null {
  if (typeof c !== "string" && c.v instanceof Date) {
    const d = c.v;
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const p = dateParts(typeof c === "string" ? c : c.text);
  if (!p) return null;
  if ("iso" in p) return p.iso;
  return order === "dmy" ? iso(p.y, p.b, p.a) : iso(p.y, p.a, p.b);
}

const TRUE_WORDS = new Set(["yes", "y", "true", "x", "✓", "✔", "☑", "done", "1"]);
const FALSE_WORDS = new Set(["no", "n", "false", "✗", "✘", "☐", "0", "-"]);

export function parseBoolean(c: Cell | string): boolean | null {
  if (typeof c !== "string" && typeof c.v === "boolean") return c.v;
  const t = (typeof c === "string" ? c : c.text).trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return null;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i;

// ─── header detection ────────────────────────────────────────────────────────

function width(row: Array<Cell | null> | undefined): number {
  return row ? row.filter(Boolean).length : 0;
}

function isLabel(c: Cell): boolean {
  if (typeof c.v !== "string") return false;
  const t = c.text;
  if (!t || t.length > 60) return false;
  if (parseNumber(t) !== null) return false;
  if (dateParts(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

function headerLike(row: Array<Cell | null> | undefined, maxWidth: number): boolean {
  const cells = (row ?? []).filter((c): c is Cell => Boolean(c));
  if (cells.length < Math.min(2, maxWidth)) return false;
  if (cells.length < Math.ceil(maxWidth * 0.5)) return false;
  const labels = cells.filter(isLabel);
  if (labels.length / cells.length < 0.8) return false;
  const own = cells.filter((c) => !c.merged);
  return new Set(own.map((c) => c.text.toLowerCase())).size >= Math.max(1, own.length - 1);
}

function isTitleOnly(row: Array<Cell | null> | undefined): boolean {
  const cells = (row ?? []).filter((c): c is Cell => Boolean(c));
  return cells.length > 0 && new Set(cells.map((c) => c.text)).size === 1;
}

function letterOf(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function joinHeader(group: string, leaf: string): string {
  const paren = /\s*(\([^)]*\))\s*$/.exec(group);
  const base = paren ? group.slice(0, paren.index).trim() : group;
  if (leaf.toLowerCase().includes(base.toLowerCase())) return leaf;
  return paren ? `${base} ${leaf} ${paren[1]}` : `${base} ${leaf}`;
}

// ─── the column reader ───────────────────────────────────────────────────────

interface ColumnDraft {
  index: number;
  header: string;
  header_parts: string[];
  derived?: "section";
  cells: Array<Cell | null>;
}

const LENGTH_UNITS = new Set(["mm", "cm", "m", "ft", "in"]);

const PLACE_WORDS =
  /\b(fridge|freezer|pantry|cupboard|cabinet|shelf|shelves|garage|drawer|basement|cellar|closet|kitchen|room|bedroom|bathroom|office|attic|shed|loft|box|bin|rack|tote|storage|workshop|studio|hall|hallway|desk|counter|bench|wall|unit|locker|safe|car|van|truck|trailer|warehouse)\b/i;

const H = {
  key: /\b(sku|barcode|upc|ean|gtin|isbn|serial|serial number|serial no|s n|asset tag|asset id|part number|part no|mpn|item code|product code|code|id)\b/,
  name: /\b(name|title|item|product|thing|what)\b/,
  nameWeak: /\b(model|description|desc)\b/,
  quantity: /\b(qty|quantity|count|stock|on hand|how many|units|number of|no of|pcs)\b/,
  location: /\b(location|where|room|shelf|bin|place|stored|storage|box|drawer|cabinet|rack|area|spot|kept|home)\b/,
  category: /\b(category|categories|type|kind|group|genre|class|department|dept|family)\b/,
  photo: /\b(photo|photos|image|images|picture|pictures|pic|img|thumbnail)\b/,
  notes: /\b(notes?|comments?|remarks?|details|description|desc)\b/,
  tags: /\b(tags?|labels?|keywords?)\b/,
  money: /\b(price|cost|paid|value|msrp|spent|retail|worth)\b/,
};

function norm(header: string): string {
  return header.toLowerCase().replace(/#/g, " number ").replace(/[^a-z0-9]+/g, " ").trim();
}

function describeColumn(d: ColumnDraft, dateOrderHint: DateOrder): UnderstoodColumn {
  const cells = d.cells.filter((c): c is Cell => Boolean(c));
  const texts = cells.map(textOf);
  const filled = cells.length;
  const distinctSet = new Set(texts.map((t) => t.toLowerCase()));
  const distinct = distinctSet.size;
  const h = norm(d.header);
  const col: UnderstoodColumn = {
    index: d.index,
    letter: d.index >= 0 ? letterOf(d.index) : "",
    header: d.header,
    header_parts: d.header_parts,
    ...(d.derived ? { derived: d.derived } : {}),
    type: "text",
    role: null,
    filled,
    distinct,
    unique: filled > 0 && distinct === filled,
    samples: [...new Set(texts)].slice(0, 3),
    odd: { count: 0, samples: [] },
  };
  if (filled === 0) return col;

  const share = (pred: (c: Cell, t: string) => boolean) => cells.filter((c, i) => pred(c, texts[i]!)).length / filled;
  const oddOf = (pred: (c: Cell, t: string) => boolean) => {
    const odd = texts.filter((t, i) => !pred(cells[i]!, t));
    col.odd = { count: odd.length, samples: [...new Set(odd)].slice(0, 3) };
  };
  const FIT = 0.8;

  const isBool = (c: Cell) => parseBoolean(c) !== null;
  const boolDistinct = new Set(cells.map((c) => parseBoolean(c)).filter((b) => b !== null));
  if (share(isBool) >= FIT && boolDistinct.has(true) && (distinct <= 4 || typeof cells[0]!.v === "boolean")) {
    // A column of bare 1s and 0s is as likely a count as a checkbox.
    const numericOnly = texts.every((t) => t === "0" || t === "1");
    if (!numericOnly || /\?$/.test(d.header.trim())) {
      col.type = "boolean";
      oddOf(isBool);
      return col;
    }
  }

  const realDates = cells.filter((c) => c.v instanceof Date).length;
  const isCode = (_c: Cell, t: string) => productCodeKind(t) !== null || (/^\d{11}$/.test(t) && productCodeKind(`0${t}`) !== null);
  const isUrl = (_c: Cell, t: string) => /^https?:\/\/\S+$/i.test(t);
  const isNum = (c: Cell, t: string) => typeof c.v === "number" || parseNumber(t) !== null;
  const isQty = (_c: Cell, t: string) => parseQuantity(t) !== null;

  if (realDates / filled >= FIT) {
    col.type = "date";
    col.date_order = dateOrderHint;
    oddOf((c) => parseDate(c, dateOrderHint) !== null);
    return col;
  }

  if (share(isCode) >= FIT && !H.money.test(h) && !H.quantity.test(h)) {
    col.type = "code";
    const kinds = texts.map((t) => productCodeKind(t) ?? productCodeKind(`0${t}`));
    col.code_kind = kinds.filter((k) => k === "isbn").length >= kinds.filter((k) => k === "gtin").length ? "isbn" : "gtin";
    oddOf(isCode);
    return col;
  }

  if (share(isUrl) >= FIT) {
    const images = texts.filter((t) => IMAGE_EXT_RE.test(t)).length;
    col.type = images / filled >= 0.5 || H.photo.test(h) ? "image" : "url";
    oddOf(isUrl);
    return col;
  }

  if (share(isNum) >= FIT) {
    const withCurrency = texts.filter((t) => CURRENCY_RE.test(t)).length;
    if (withCurrency / filled >= 0.3 || H.money.test(h)) {
      col.type = "money";
      const sym = texts.map((t) => CURRENCY_RE.exec(t)?.[0]).find(Boolean);
      col.currency = sym ? currencyCode(sym) : null;
    } else {
      col.type = "number";
    }
    oddOf(isNum);
    return col;
  }

  if (share(isQty) >= FIT) {
    const units = texts.map((t) => parseQuantity(t)?.unit).filter((u): u is string => Boolean(u));
    if (units.length > 0) {
      col.type = "quantity";
      col.unit = mostCommon(units);
      oddOf(isQty);
      return col;
    }
  }

  // Dates written as text: settle the order from the column itself.
  const parts = texts.map(dateParts);
  if (parts.filter(Boolean).length / filled >= FIT) {
    const pairs = parts.filter((p): p is { a: number; b: number; y: number } => Boolean(p && "a" in p));
    const firstOver12 = pairs.some((p) => p.a > 12);
    const secondOver12 = pairs.some((p) => p.b > 12);
    const order: DateOrder = firstOver12 && !secondOver12 ? "dmy" : secondOver12 && !firstOver12 ? "mdy" : dateOrderHint;
    col.type = "date";
    col.date_order = pairs.length ? order : "ymd";
    if (pairs.length && !firstOver12 && !secondOver12) col.date_ambiguous = true;
    oddOf((c) => parseDate(c, order) !== null);
    return col;
  }

  col.path = texts.filter((t) => /\S\s*(\/|>|›|»)\s*\S/.test(t)).length / filled >= 0.5;

  const avgLen = texts.reduce((n, t) => n + t.length, 0) / filled;
  const tokens = texts.flatMap((t) => (/[,;|]/.test(t) ? t.split(/\s*[,;|]\s*/) : [t])).filter(Boolean);
  const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
  const separated = texts.filter((t) => /[,;|]/.test(t)).length / filled;
  const tagHeader = H.tags.test(h) && separated >= 0.2;
  if (!col.path && avgLen <= 60 && (tagHeader || (separated >= 0.3 && tokenSet.size <= 30 && tokens.length >= tokenSet.size * 1.5))) {
    col.type = "tags";
    col.choices = byFrequency(tokens);
    return col;
  }
  if (!col.path && distinct >= 2 && distinct <= 12 && filled >= distinct * 2 && avgLen <= 30) {
    col.type = "choice";
    col.choices = byFrequency(texts);
    return col;
  }
  if (avgLen > 60 || (texts.some((t) => t.includes("\n")) && avgLen > 30)) col.type = "long-text";
  return col;
}

function currencyCode(sym: string): string {
  const s = sym.toUpperCase();
  return ({ $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" } as Record<string, string>)[s] ?? s;
}

function mostCommon(xs: string[]): string {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** Distinct values, most used first, each in the spelling seen most. */
function byFrequency(xs: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const x of xs) {
    const k = x.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length).map(mostCommon);
}

function assignRoles(cols: UnderstoodColumn[], rowCount: number): void {
  const taken = new Set<ColumnRole>();
  const give = (role: ColumnRole, c: UnderstoodColumn | undefined) => {
    if (!c || c.role || taken.has(role)) return;
    c.role = role;
    taken.add(role);
  };
  const withData = cols.filter((c) => c.filled > 0);
  const h = (c: UnderstoodColumn) => norm(c.header);

  // Key: a column that names one thing per row. A code column first, then by
  // header, and only when no value repeats.
  const keyish = withData.filter((c) => c.unique && c.filled >= rowCount * 0.5);
  give("key", keyish.find((c) => c.type === "code") ?? keyish.find((c) => H.key.test(h(c)) && c.type !== "long-text"));

  give("photo", withData.find((c) => c.type === "image") ?? withData.find((c) => c.type === "url" && H.photo.test(h(c))));

  const texty = (c: UnderstoodColumn) => c.type === "text" || c.type === "long-text";
  give(
    "name",
    withData.find((c) => texty(c) && H.name.test(h(c))) ??
      withData.find((c) => c.type === "text" && H.nameWeak.test(h(c)) && c.distinct >= c.filled * 0.5) ??
      withData.find((c) => c.type === "text" && !c.path && !c.derived && c.distinct >= c.filled * 0.7),
  );

  // Without a header saying so, only an amount of STUFF is a quantity: "500 g"
  // or "3 cans" is how much you have, "0.4 mm" is a size.
  give(
    "quantity",
    withData.find((c) => (c.type === "number" || c.type === "quantity") && H.quantity.test(h(c))) ??
      withData.find((c) => c.type === "quantity" && !H.money.test(h(c)) && !LENGTH_UNITS.has(c.unit ?? "")),
  );

  const placey = (c: UnderstoodColumn) => (c.choices ?? c.samples).filter((v) => PLACE_WORDS.test(v)).length >= Math.max(1, (c.choices ?? c.samples).length * 0.5);
  give(
    "location",
    withData.find((c) => !c.derived && H.location.test(h(c)) && c.type !== "number") ??
      withData.find((c) => c.path && !c.derived) ??
      withData.find((c) => c.derived === "section" && placey(c)),
  );

  give(
    "category",
    withData.find((c) => (c.type === "choice" || c.type === "text" || c.type === "tags") && H.category.test(h(c))) ??
      withData.find((c) => c.derived === "section"),
  );

  give("notes", withData.find((c) => texty(c) && H.notes.test(h(c))) ?? withData.find((c) => c.type === "long-text"));
}

function valueOf(c: Cell | null, col: UnderstoodColumn): Value {
  if (!c) return null;
  const t = textOf(c);
  switch (col.type) {
    case "boolean":
      return parseBoolean(c) ?? t;
    case "number":
    case "money":
      return typeof c.v === "number" ? c.v : (parseNumber(t) ?? t);
    case "quantity": {
      const q = parseQuantity(t);
      return q ? { ...q, text: t } : t;
    }
    case "date":
      return parseDate(c, col.date_order ?? "ymd") ?? t;
    case "tags":
      return t.split(/\s*[,;|]\s*/).filter(Boolean);
    case "code": {
      const digits = t.replace(/[-\s]/g, "");
      return /^\d{11}$/.test(digits) && productCodeKind(`0${digits}`) ? `0${digits}` : t;
    }
    default:
      return t;
  }
}

export function defaultDateOrder(locale: string | undefined): DateOrder {
  return /^en-(US|PH)|^(fil|es-US)/i.test(locale ?? "en-US") ? "mdy" : "dmy";
}

// ─── the sheet ───────────────────────────────────────────────────────────────

export function understandSheet(raw: RawSheet, opts: UnderstandOptions = {}): UnderstoodSheet {
  const base: UnderstoodSheet = {
    name: raw.name,
    hidden: raw.hidden,
    truncated: raw.truncated,
    empty: true,
    title: null,
    header_row: null,
    columns: [],
    rows: [],
    skipped: [],
  };
  const rows = raw.rows;
  const lastUsed = rows.reduce((n, r, i) => (width(r) > 0 ? i : n), -1);
  if (lastUsed < 0) return base;

  const probe = rows.slice(0, Math.min(rows.length, 60));
  const maxWidth = Math.max(...probe.map(width));

  // The header: the first row, near the top, that is mostly short labels and
  // about as wide as the data. A one-column list has no room for a title row
  // to be mistaken for its header, so its first label row is the header.
  let header = -1;
  for (let r = 0; r <= Math.min(lastUsed, 25); r++) {
    if (maxWidth > 1 && isTitleOnly(rows[r])) continue;
    if (headerLike(rows[r], maxWidth)) {
      header = r;
      break;
    }
  }
  if (header < 0) header = rows.findIndex((r) => width(r) > 0);

  // A group header ("Build volume" merged over X, Y, Z) sits on the row above
  // the leaf headers, or the first header-like row IS the group row.
  let group = -1;
  const hasHorizontalMerge = (row: Array<Cell | null> | undefined) => (row ?? []).some((c, i) => c?.merged && row?.[i - 1]?.text === c.text);
  if (hasHorizontalMerge(rows[header]) && headerLike(rows[header + 1], maxWidth) && !isTitleOnly(rows[header])) {
    group = header;
    header = header + 1;
  } else if (header > 0 && hasHorizontalMerge(rows[header - 1]) && !isTitleOnly(rows[header - 1])) {
    group = header - 1;
  }

  const titleCells = rows
    .slice(0, group >= 0 ? group : header)
    .flatMap((r) => (r ?? []).filter((c): c is Cell => Boolean(c) && !c!.merged))
    .map((c) => c.text);
  base.title = titleCells[0] ?? null;
  for (let r = 0; r < (group >= 0 ? group : header); r++) {
    if (width(rows[r]) > 0) base.skipped.push({ row: r + 1, reason: "title", text: rowText(rows[r]) });
  }
  base.header_row = header + 1;

  // Columns: every position that has a header or any value.
  const colCount = Math.max(...rows.slice(header, lastUsed + 1).map((r) => (r ? r.length : 0)));
  const drafts: ColumnDraft[] = [];
  const seen = new Map<string, number>();
  const firstDataCol = (() => {
    for (let c = 0; c < colCount; c++) if (rows.slice(header + 1, lastUsed + 1).some((r) => r?.[c])) return c;
    return 0;
  })();

  // Data rows, section headings and the rows that are not records.
  const dataRows: Array<{ row: number; cells: Array<Cell | null>; section: string | null }> = [];
  let section: string | null = null;
  let sawSection = false;
  const headerKey = (rows[header] ?? []).map((c) => c?.text.toLowerCase() ?? "").join("\u0001");
  for (let r = header + 1; r <= lastUsed; r++) {
    const row = rows[r] ?? [];
    const w = width(row);
    if (w === 0) {
      base.skipped.push({ row: r + 1, reason: "blank" });
      continue;
    }
    if (row.map((c) => c?.text.toLowerCase() ?? "").join("\u0001") === headerKey) {
      base.skipped.push({ row: r + 1, reason: "repeated-header" });
      continue;
    }
    const first = row.find(Boolean)!;
    if (/^(grand\s+)?(sub)?totals?:?$|^sum:?$/i.test(first.text) && row.some((c) => c && typeof c.v === "number")) {
      base.skipped.push({ row: r + 1, reason: "total", text: rowText(row) });
      continue;
    }
    const sectionLike =
      maxWidth >= 3 &&
      isLabel(first) &&
      (w === 1 ? row.indexOf(first) === firstDataCol : isTitleOnly(row) && row.filter((c) => c?.merged).length === w - 1);
    if (sectionLike) {
      section = first.text;
      sawSection = true;
      base.skipped.push({ row: r + 1, reason: "section", text: first.text });
      continue;
    }
    dataRows.push({ row: r + 1, cells: row, section });
  }

  for (let c = 0; c < colCount; c++) {
    const leaf = rows[header]?.[c]?.text ?? "";
    const grp = group >= 0 ? (rows[group]?.[c]?.text ?? "") : "";
    const cells = dataRows.map((d) => d.cells[c] ?? null);
    if (!leaf && !grp && !cells.some(Boolean)) continue;
    let name = leaf && grp && grp !== leaf ? joinHeader(grp, leaf) : leaf || grp || `Column ${letterOf(c)}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} ${n}`;
    drafts.push({ index: c, header: name, header_parts: [grp, leaf].filter((x, i, a) => x && a.indexOf(x) === i), cells });
  }
  if (sawSection) {
    drafts.push({
      index: -1,
      header: "Section",
      header_parts: [],
      derived: "section",
      cells: dataRows.map((d) => (d.section ? { v: d.section, text: d.section } : null)),
    });
  }

  const hint = defaultDateOrder(opts.locale);
  base.columns = drafts.map((d) => describeColumn(d, hint));
  assignRoles(base.columns, dataRows.length);
  base.rows = dataRows.map((d, i) => ({
    row: d.row,
    values: base.columns.map((col, k) => valueOf(drafts[k]!.cells[i] ?? null, col)),
  }));
  base.empty = dataRows.length === 0;
  return base;
}

function rowText(row: Array<Cell | null> | undefined): string {
  return [...new Set((row ?? []).filter((c): c is Cell => Boolean(c)).map((c) => c.text))].join(" · ");
}

export function understandWorkbook(sheets: RawSheet[], opts: UnderstandOptions = {}): UnderstoodSheet[] {
  return sheets.map((s) => understandSheet(s, opts));
}
