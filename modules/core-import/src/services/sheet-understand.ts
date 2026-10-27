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
import { readDisposition } from "@cobblr/platform-contract/disposition";
import { parseMeasure } from "@cobblr/platform-contract/measure";
import type { Cell, RawSheet } from "./sheet-read.js";

export type ColumnType =
  | "text"
  | "long-text"
  | "number"
  | "money"
  | "quantity"
  | "measure"
  | "date"
  | "boolean"
  | "choice"
  | "tags"
  | "code"
  | "url"
  | "image";

// VOCAB-ENUMERATION OK: a spreadsheet column's own roles, declared here; not the field-role vocabulary
export type ColumnRole = "name" | "key" | "quantity" | "location" | "category" | "photo" | "notes" | "disposition";

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
  /** Where the header came from when the sheet had none: its values, or a
   *  model shown the first rows. Absent when the sheet named it. */
  named_by?: "values" | "ai";
  /** How many values read as what became of the thing ("Sold for $100",
   *  "Parted out"). */
  fates?: number;
}

/** A quantity keeps the words it was written with ("3 cans") beside the
 *  amount and the normalised unit, so showing it again never says "3 can". */
export type Value = string | number | boolean | string[] | { amount: number; unit: string | null; text: string } | null;

export interface UnderstoodRow {
  /** 1-based row number as the spreadsheet shows it. */
  row: number;
  values: Value[];
  /** Each cell as the sheet writes it, "" for an empty one: what a text
   *  field keeps, whatever the column's values looked like (a serial 000123
   *  in a column of numbers stays 000123, #7614). */
  texts?: string[];
}

/** `excluded`: a person left the row out in the dry run. `not-owned`: the
 *  row says the thing is gone, and the person asked for only what they have. */
export type SkipReason = "title" | "blank" | "repeated-header" | "total" | "section" | "excluded" | "not-owned";

export interface SkippedRow {
  row: number;
  reason: SkipReason;
  text?: string;
}

/** One figure from a sheet's own summary rows ("Price Totals $4,873.00"), to
 *  check the import against rather than to import. */
export interface SummaryFact {
  row: number;
  label: string;
  value: number;
  money: boolean;
}

export interface UnderstoodSheet {
  name: string;
  hidden: boolean;
  empty: boolean;
  title: string | null;
  /** 1-based; null for an empty sheet or one with no header row. */
  header_row: number | null;
  /** The sheet starts with its data: no row names the columns, so they are
   *  named from what they hold ("ISBN", "Date") or by letter. */
  headerless: boolean;
  columns: UnderstoodColumn[];
  rows: UnderstoodRow[];
  skipped: SkippedRow[];
  summary: SummaryFact[];
}

export interface UnderstandOptions {
  /** How to read 03/04/2025 when nothing in the column settles it. */
  locale?: string;
}

// ─── cell readers ────────────────────────────────────────────────────────────

const CURRENCY_RE = /[$€£¥₹]|\b(USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY)\b/i;

/** A price of nothing, as people write it: "Free", "Free in Trade", "Gift". */
const FREE_RE = /^(free|gratis|gift(ed)?|no charge|n\/c)\b/i;

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
  fate: /\b(fate|disposition|what happened|outcome|status|gone|sold|still own(ed)?)\b/,
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
  const fates = texts.filter((t) => {
    const d = readDisposition(t);
    return d !== null && d !== "owned";
  }).length;
  if (fates) col.fates = fates;

  const share = (pred: (c: Cell, t: string) => boolean) => cells.filter((c, i) => pred(c, texts[i]!)).length / filled;
  const oddOf = (pred: (c: Cell, t: string) => boolean) => {
    const odd = texts.filter((t, i) => !pred(cells[i]!, t));
    col.odd = { count: odd.length, samples: [...new Set(odd)].slice(0, 3) };
  };
  const FIT = 0.8;

  const isCode = (_c: Cell, t: string) => productCodeKind(t) !== null || (/^\d{11}$/.test(t) && productCodeKind(`0${t}`) !== null);
  // Identifier headings describe spelling, even when their values look like
  // numbers, dates or checkboxes. Valid product codes still get checked.
  if (H.key.test(h) && share(isCode) < FIT) return col;

  const isBool = (c: Cell) => parseBoolean(c) !== null;
  const boolDistinct = new Set(cells.map((c) => parseBoolean(c)).filter((b) => b !== null));
  if (share(isBool) >= FIT && (boolDistinct.has(true) || texts.every((t) => /^(false|no|n)$/i.test(t.trim()))) && (distinct <= 4 || typeof cells[0]!.v === "boolean")) {
    // A column of bare 1s and 0s is as likely a count as a checkbox.
    const numericOnly = texts.every((t) => t === "0" || t === "1");
    if (!numericOnly || /\?$/.test(d.header.trim())) {
      col.type = "boolean";
      oddOf(isBool);
      return col;
    }
  }

  const realDates = cells.filter((c) => c.v instanceof Date).length;
  const isUrl = (_c: Cell, t: string) => /^https?:\/\/\S+$/i.test(t);
  const isNum = (c: Cell, t: string) => typeof c.v === "number" || parseNumber(t) !== null;
  const isNumOrFree = (c: Cell, t: string) => isNum(c, t) || FREE_RE.test(t);
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

  // "Free" is a price, so a price column with free things in it is still
  // money; only where something IS a price, never a column of the word alone.
  const priced = cells.some((c, i) => isNum(c, texts[i]!)) && (texts.some((t) => CURRENCY_RE.test(t)) || H.money.test(h));
  if (share(isNum) >= FIT || (priced && share(isNumOrFree) >= FIT)) {
    const withCurrency = texts.filter((t) => CURRENCY_RE.test(t)).length;
    if (withCurrency / filled >= 0.3 || H.money.test(h)) {
      col.type = "money";
      const sym = texts.map((t) => CURRENCY_RE.exec(t)?.[0]).find(Boolean);
      col.currency = sym ? currencyCode(sym) : null;
    } else {
      col.type = "number";
    }
    oddOf(col.type === "money" ? isNumOrFree : isNum);
    return col;
  }

  // Measured values with a unit, said or implied: "4k7", "100n", "16 V". A
  // column of them is a measure field, so the values are found by value.
  const isMeasure = (_c: Cell, t: string) => !!parseMeasure(t)?.unit;
  if (share(isMeasure) >= FIT) {
    const units = texts.map((t) => parseMeasure(t)?.unit).filter((u): u is string => Boolean(u));
    col.type = "measure";
    col.unit = mostCommon(units);
    oddOf(isMeasure);
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
  // What became of each thing, where the column says anything at all (a blank
  // is still here): mostly sold, given away, parted out… Settled before the
  // name, so a sheet of fates is never taken for the names of things.
  give(
    "disposition",
    withData.find((c) => (c.fates ?? 0) >= 2 && (c.fates ?? 0) >= c.filled * (H.fate.test(h(c)) ? 0.5 : 0.8)),
  );
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
      return typeof c.v === "number" ? c.v : (parseNumber(t) ?? t);
    case "money": {
      if (typeof c.v === "number") return c.v;
      const n = parseNumber(t);
      if (n !== null) return n;
      const free = FREE_RE.exec(t);
      // "Free in Trade" is nothing paid, and the words say how.
      if (free) return free[0].length === t.trim().length ? 0 : { amount: 0, unit: null, text: t };
      return t;
    }
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

/** Whether the row taken as the header reads like the data under it: a
 *  checked code, a date or a number where the column holds them, or a value
 *  the column repeats further down. Two such cells and it is data. */
function looksLikeData(rows: RawSheet["rows"], header: number, lastUsed: number): boolean {
  const row = rows[header] ?? [];
  const below = rows.slice(header + 1, Math.min(lastUsed + 1, header + 31));
  let evidence = 0;
  row.forEach((cell, c) => {
    if (!cell) return;
    const t = cell.text.trim();
    const column = below.map((r) => r?.[c]).filter((x): x is Cell => Boolean(x));
    if (productCodeKind(t) && column.some((x) => productCodeKind(x.text))) evidence++;
    else if (dateParts(t) && column.some((x) => dateParts(x.text) || x.v instanceof Date)) evidence++;
    else if (column.some((x) => x.text.trim().toLowerCase() === t.toLowerCase())) evidence++;
  });
  return evidence >= 2;
}

/** A header row BELOW the data, as a list kept by adding to the top shows it:
 *  a row of labels as wide as the data, whose columns hold numbers or dates in
 *  the rows above it, and none of whose labels is a value its column repeats
 *  (a row of data that happens to be all words has neighbours that agree with
 *  it). -1 when there is none. */
function headerBelowData(rows: RawSheet["rows"], firstUsed: number, lastUsed: number): number {
  const widest = Math.max(...rows.slice(firstUsed, lastUsed + 1).map(width));
  const typed = (x: Cell) => typeof x.v === "number" || x.v instanceof Date || parseNumber(x.text) !== null || dateParts(x.text) !== null;
  for (let r = firstUsed + 1; r <= lastUsed; r++) {
    const row = rows[r];
    if (width(row) < Math.max(2, Math.ceil(widest * 0.8)) || !headerLike(row, widest)) continue;
    const near = [...rows.slice(Math.max(firstUsed, r - 40), r), ...rows.slice(r + 1, r + 41)];
    const above = rows.slice(Math.max(firstUsed, r - 40), r);
    let namesTyped = 0;
    let repeats = false;
    (row ?? []).forEach((cell, c) => {
      if (!cell) return;
      const t = cell.text.trim().toLowerCase();
      if (near.some((x) => x?.[c]?.text.trim().toLowerCase() === t)) repeats = true;
      const under = above.map((x) => x?.[c]).filter((x): x is Cell => Boolean(x));
      if (under.length >= 2 && under.filter(typed).length >= under.length * 0.5) namesTyped++;
    });
    if (!repeats && namesTyped >= 1) return r;
  }
  return -1;
}

// A row of a sheet's own arithmetic: "Price Totals", "Average Cost",
// "Total Still Owned". Recognised by its words where the data ends; a row
// that is only the word Total is one anywhere.
const SUMMARY_WORDS = /\b((grand|sub)\s*)?totals?\b|\bsum\b|\baverage\b|\bavg\b|\bmean\b|\bcount\b/i;
const TOTAL_ONLY = /^(grand\s+)?(sub)?totals?:?$|^sum:?$/i;

function numberIn(c: Cell): number | null {
  return typeof c.v === "number" ? c.v : parseNumber(c.text);
}

function summaryLike(row: Array<Cell | null>, anywhere: boolean): boolean {
  const first = row.find(Boolean);
  if (!first || !isLabel(first) || !row.some((c) => c && numberIn(c) !== null)) return false;
  return anywhere ? TOTAL_ONLY.test(first.text.trim()) : SUMMARY_WORDS.test(first.text);
}

/** Each label in a summary row with the number that follows it. */
function summaryFacts(row: Array<Cell | null>, rowNumber: number): SummaryFact[] {
  const out: SummaryFact[] = [];
  let label: string | null = null;
  for (const c of row) {
    if (!c) continue;
    const n = numberIn(c);
    if (n !== null && label) {
      out.push({ row: rowNumber, label, value: n, money: CURRENCY_RE.test(c.text) });
      label = null;
    } else if (n === null && isLabel(c)) {
      label = c.text.trim();
    }
  }
  return out;
}

/** Names for the columns of a sheet with no header row, where the values
 *  leave no doubt; the rest keep their letter. */
function nameFromValues(columns: UnderstoodColumn[]): void {
  const taken = new Set(columns.map((c) => c.header.toLowerCase()));
  for (const col of columns) {
    if (col.derived || !/^Column [A-Z]+$/.test(col.header)) continue;
    const name =
      col.type === "code" ? (col.code_kind === "isbn" ? "ISBN" : "Barcode")
      : col.type === "image" ? "Photo"
      : col.type === "url" ? "Link"
      : col.type === "date" ? "Date"
      : col.type === "money" ? "Price"
      : null;
    if (!name || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    col.header = name;
    col.header_parts = [];
    col.named_by = "values";
  }
}

/** Roles again, after a column was renamed (the header is half of how a role
 *  is recognised). */
export function reassignRoles(sheet: UnderstoodSheet): void {
  for (const c of sheet.columns) if (!c.derived) c.role = null;
  assignRoles(sheet.columns, sheet.rows.length);
}

export function understandSheet(raw: RawSheet, opts: UnderstandOptions = {}): UnderstoodSheet {
  const base: UnderstoodSheet = {
    name: raw.name,
    hidden: raw.hidden,
    empty: true,
    title: null,
    header_row: null,
    headerless: false,
    columns: [],
    rows: [],
    skipped: [],
    summary: [],
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
  // A first row that reads like the rows under it is data, not a header: a
  // book list saved without its header row starts "Dune, Frank Herbert,
  // 978-0-441-17271-9, Science fiction…", and taking that row as the header
  // would lose the first book without a word.
  const firstUsed = rows.findIndex((r) => width(r) > 0);
  // A list kept by adding at the top can have its header BELOW the data, with
  // its totals under that: the header is looked for there before the sheet is
  // taken to have none.
  let below = false;
  if (header < 0 || looksLikeData(rows, header, lastUsed)) {
    const found = headerBelowData(rows, firstUsed, lastUsed);
    if (found >= 0) {
      header = found;
      below = true;
    } else {
      base.headerless = true;
      header = firstUsed - 1;
    }
  }

  // A group header ("Build volume" merged over X, Y, Z) sits on the row above
  // the leaf headers, or the first header-like row IS the group row.
  let group = -1;
  const hasHorizontalMerge = (row: Array<Cell | null> | undefined) => (row ?? []).some((c, i) => c?.merged && row?.[i - 1]?.text === c.text);
  if (base.headerless || below) {
    // no header on top, so no group header either
  } else if (hasHorizontalMerge(rows[header]) && headerLike(rows[header + 1], maxWidth) && !isTitleOnly(rows[header])) {
    group = header;
    header = header + 1;
  } else if (header > 0 && hasHorizontalMerge(rows[header - 1]) && !isTitleOnly(rows[header - 1])) {
    group = header - 1;
  }

  const titleCells = rows
    .slice(0, below ? 0 : group >= 0 ? group : header)
    .flatMap((r) => (r ?? []).filter((c): c is Cell => Boolean(c) && !c!.merged))
    .map((c) => c.text);
  base.title = titleCells[0] ?? null;
  for (let r = 0; r < (below ? 0 : group >= 0 ? group : header); r++) {
    if (width(rows[r]) > 0) base.skipped.push({ row: r + 1, reason: "title", text: rowText(rows[r]) });
  }
  base.header_row = base.headerless ? null : header + 1;

  // Columns: every position that has a header or any value.
  const dataIndexes: number[] = [];
  for (let r = below ? firstUsed : header + 1; r <= lastUsed; r++) if (r !== header) dataIndexes.push(r);
  const colCount = Math.max(...rows.slice(below ? firstUsed : Math.max(header, 0), lastUsed + 1).map((r) => (r ? r.length : 0)));
  const drafts: ColumnDraft[] = [];
  const seen = new Map<string, number>();
  const firstDataCol = (() => {
    for (let c = 0; c < colCount; c++) if (dataIndexes.some((r) => rows[r]?.[c])) return c;
    return 0;
  })();

  // Data rows, section headings and the rows that are not records.
  const dataRows: Array<{ row: number; cells: Array<Cell | null>; section: string | null }> = [];
  let section: string | null = null;
  let sawSection = false;
  const headerKey = base.headerless ? "\u0000" : (rows[header] ?? []).map((c) => c?.text.toLowerCase() ?? "").join("\u0001");
  for (const r of dataIndexes) {
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
    if (summaryLike(row, true)) {
      base.skipped.push({ row: r + 1, reason: "total", text: rowText(row) });
      base.summary.push(...summaryFacts(row, r + 1));
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
  // The block of arithmetic where the data ends: kept out of the records and
  // read, so the import can be checked against the sheet's own sums.
  const tail: typeof dataRows = [];
  while (dataRows.length > 1 && summaryLike(dataRows[dataRows.length - 1]!.cells, false)) tail.unshift(dataRows.pop()!);
  for (const t of tail) {
    base.skipped.push({ row: t.row, reason: "total", text: rowText(t.cells) });
    base.summary.push(...summaryFacts(t.cells, t.row));
  }

  for (let c = 0; c < colCount; c++) {
    const leaf = base.headerless ? "" : (rows[header]?.[c]?.text ?? "");
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
  if (base.headerless) nameFromValues(base.columns);
  assignRoles(base.columns, dataRows.length);
  base.rows = dataRows.map((d, i) => ({
    row: d.row,
    values: base.columns.map((col, k) => valueOf(drafts[k]!.cells[i] ?? null, col)),
    texts: base.columns.map((_, k) => {
      const c = drafts[k]!.cells[i];
      return c ? textOf(c) : "";
    }),
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
