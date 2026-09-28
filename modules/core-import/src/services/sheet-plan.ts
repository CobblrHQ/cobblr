// Decide where an understood sheet goes and what importing it would do, down
// to the row, without writing anything. Pure: an understood sheet and a
// picture of the workspace in, a plan out. The same plan is what the dry run
// shows and what the import carries out, so what a person agreed to and what
// happens cannot drift apart.
//
// Where a sheet goes: a collection the workspace already has, one it could
// install, or a new collection named after the sheet, ranked by the words the
// sheet uses for itself (its name, its title, the file) against each
// collection's own words, by how many columns land on fields the collection
// already has, and by what the rows are. The general inventory is the floor.
//
// Every column gets a destination. None is dropped by default: a column with
// no field to land on gets a new field, named and typed from the column.

import { rankFits, type FitTable } from "@cobblr/platform-contract/table-fit";
import { parseNumber, parseQuantity, type ColumnType, type UnderstoodColumn, type UnderstoodSheet, type Value } from "./sheet-understand.js";

// ─── the workspace, as the planner sees it ───────────────────────────────────

export interface TargetField {
  name: string;
  label: string;
  type: string;
  /** A column on the module's own table rather than a custom field. */
  native: boolean;
  choices?: string[] | null;
  field_role?: string | null;
  unit?: string | null;
}

export interface Target {
  /** Stable id for the choice: the kind for a collection that exists,
   *  "install:<bundle>:<instance>" for one to install, "new:<instance>" for a
   *  new collection. */
  id: string;
  kind: string;
  module: string;
  instance: string;
  label: string;
  noun: string;
  /** `enable`: the workspace's general module is not on yet (a new
   *  workspace); choosing this turns it on. */
  status: "existing" | "install" | "new" | "enable";
  bundle_external_id?: string;
  /** A module to turn on first: the target's own module when `enable`, or the
   *  module a new collection is made in when that module is not on yet. */
  enable_module?: { name: string; label: string };
  fields: TargetField[];
  scan_keywords?: string[];
  /** The workspace's general table: where anything lands when nothing fits. */
  general?: boolean;
  /** The module keeps a count and a unit on its own table. */
  counts?: boolean;
  /** Where this collection files things by kind: its category list or its
   *  category choice field, whichever it has (the platform category axis). */
  category?: {
    label: string;
    values: string[];
    /** The field a record keeps its category in, when the list is a choice
     *  field; absent when the module keeps its own category list. */
    field?: string;
  } | null;
}

export interface KnownLocation {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface ExistingRecord {
  id: string;
  name: string;
  values: Record<string, unknown>;
}

// ─── what a column becomes ───────────────────────────────────────────────────

// VOCAB-ENUMERATION OK: where a column can go, declared once; "location" and "category" here are destinations, not field roles
export type PlainDestination = "name" | "quantity" | "location" | "category" | "tags" | "photo";

export type Destination =
  | { to: PlainDestination }
  | { to: "field"; field: string; label: string; native: boolean }
  | { to: "new-field"; field: string; label: string; type: string; choices?: string[]; unit?: string | null; field_role?: string | null }
  | { to: "skip" };

export interface ColumnPlan {
  /** Position among the understood columns. */
  column: number;
  header: string;
  type: ColumnType;
  role: UnderstoodColumn["role"];
  samples: string[];
  dest: Destination;
  /** Why this destination, in words a person reads. */
  why: string;
  /** Rows whose value will not fit where it is going. */
  misfits: number;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface RecordPlan {
  row: number;
  action: "create" | "update" | "unchanged";
  name: string;
  existing_id?: string;
  /** Everything the record will carry, by destination. */
  fields: Record<string, unknown>;
  qty?: number | null;
  unit?: string | null;
  location_path?: string[];
  category?: string | null;
  tags?: string[];
  photo_url?: string | null;
  changes?: FieldChange[];
  problems: string[];
}

export interface SheetPlan {
  sheet: string;
  include: boolean;
  target: Target;
  /** Every other place this sheet could go, best first. */
  alternatives: Array<Pick<Target, "id" | "label" | "status" | "module">>;
  why_target: string;
  columns: ColumnPlan[];
  records: RecordPlan[];
  counts: { create: number; update: number; unchanged: number; skipped_rows: number };
  install?: { bundle_external_id: string; label: string };
  enable?: { module: string; label: string };
  new_collection?: { module: string; instance: string; label: string };
  fields_to_create: Array<Extract<Destination, { to: "new-field" }>>;
  locations_to_create: string[][];
  categories_to_create: string[];
  tags_used: string[];
  /** What makes this sheet need the admin tier: installs, new fields, a new
   *  collection. Empty when a member can import it as it stands. */
  needs_admin: string[];
  skipped: UnderstoodSheet["skipped"];
}

export interface SheetOverrides {
  include?: boolean;
  target?: string;
  /** By column position. */
  columns?: Record<number, Destination>;
  /** Rows a person left out, by spreadsheet row number. */
  skip_rows?: number[];
  /** What to call a new collection made from this sheet. */
  collection_label?: string;
}

// ─── words ───────────────────────────────────────────────────────────────────

// Words that say a list is a list, not what is on it. One string: they are
// English words, and read one by one they would look like module names.
const STOP = new Set(
  "the a an and of my our list lists inventory stock stuff things thing items item sheet sheets export copy final new updated data table log tracker master all".split(" "),
);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function words(s: string | null | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w))
    .map(singular)
    .filter((w) => !STOP.has(w));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/#/g, " number ").replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Other names a column is kept under, onto the field names modules use. */
const NATIVE_SYNONYMS: Record<string, string[]> = {
  manufacturer: ["brand", "make", "maker", "manufacturer", "mfr", "mfg", "producer", "made by"],
  model_number: ["model", "model number", "model no", "model num"],
  model: ["model", "model number", "model no"],
  serial_number: ["serial", "serial number", "serial no", "s n", "sn", "serial num"],
  cost: ["price", "cost", "paid", "value", "purchase price", "unit price", "unit cost", "each"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
  description: ["description", "details", "desc"],
  supplier_url: ["supplier url", "link", "url", "buy link", "product link", "supplier", "where to buy", "product url"],
  min_qty: ["min", "minimum", "reorder at", "reorder point", "reorder", "min qty", "low stock"],
  unit: ["unit", "uom", "units of measure"],
  warranty_expires: ["warranty", "warranty until", "warranty expires", "warranty end"],
  warranty_until: ["warranty", "warranty until", "warranty expires", "warranty end"],
  purchased_at: ["bought", "purchased", "purchase date", "date bought", "acquired", "date purchased"],
  type: ["type", "kind"],
  short_name: ["short name", "nickname", "alias"],
};

/** Header words onto a field's role, so a bundle's own field is found by what
 *  it means rather than by what it is called. */
/** The header words that mean each field role: a declared table, so a role
 *  with no words here is simply never guessed from a header. */
const ROLE_SYNONYMS: Array<[string, RegExp]> = [
  ["expiry", /\b(best before|expires?|expiry|expiration|use by|sell by|bb|best by)\b/], // VOCAB-ENUMERATION OK: declared header words
  ["acquired-on", /\b(bought|purchased|purchase date|date bought|date purchased|acquired|date added|added on)\b/], // VOCAB-ENUMERATION OK: declared header words
  ["acquired-from", /\b(bought from|store|shop|vendor|seller|purchased from|retailer|where bought)\b/], // VOCAB-ENUMERATION OK: declared header words
  ["year-made", /\b(year|vintage|year made|made in|year built)\b/], // VOCAB-ENUMERATION OK: declared header words
  ["lot", /\b(lot|batch|dye lot|lot number)\b/], // VOCAB-ENUMERATION OK: declared header words
  ["identifier", /\b(sku|barcode|upc|ean|gtin|isbn|asset tag|part number|part no|mpn|item code|product code|code|id|set number)\b/], // VOCAB-ENUMERATION OK: declared header words
];

function roleOfHeader(header: string): string | null {
  const h = norm(header);
  for (const [role, re] of ROLE_SYNONYMS) if (re.test(h)) return role;
  return null;
}

// ─── choosing a target ───────────────────────────────────────────────────────

export interface TargetScore {
  target: Target;
  score: number;
  why: string[];
}

function fitTableOf(t: Target): FitTable {
  return {
    noun: t.noun,
    label: t.label,
    fields: t.fields.filter((f) => !f.native).map((f) => ({ name: f.name, label: f.label, ...(f.choices ? { choices: f.choices } : {}) })),
    ...(t.scan_keywords ? { scan_keywords: t.scan_keywords } : {}),
    ...(t.general ? { is_fallback: true } : {}),
  };
}

export function scoreTargets(sheet: UnderstoodSheet, filename: string, targets: Target[]): TargetScore[] {
  const nameCol = sheet.columns.findIndex((c) => c.role === "name");
  // VOCAB-ENUMERATION OK: a column role (sheet-understand's own vocabulary), not a field role
  const catCol = sheet.columns.findIndex((c) => c.role === "category");
  const own = new Set([...words(sheet.name), ...words(sheet.title), ...words(filename), ...(nameCol >= 0 ? words(sheet.columns[nameCol]!.header) : [])]);
  // A generic default tab name says nothing about what is in it.
  if (/^sheet\s*\d*$/i.test(sheet.name)) for (const w of words(sheet.name)) own.delete(w);

  const tables = targets.map(fitTableOf);
  const topCounts = new Map<number, number>();
  const sample = sheet.rows.slice(0, 25);
  for (const r of sample) {
    const name = nameCol >= 0 ? r.values[nameCol] : null;
    if (typeof name !== "string" || !name) continue;
    const category = catCol >= 0 && typeof r.values[catCol] === "string" ? (r.values[catCol] as string) : undefined;
    const ranked = rankFits({ name, ...(category ? { category } : {}) }, tables);
    const top = ranked[0];
    if (top && top.evidence.plausible) {
      const i = tables.indexOf(top.table);
      topCounts.set(i, (topCounts.get(i) ?? 0) + 1);
    }
  }

  return targets
    .map((t, i) => {
      const why: string[] = [];
      let score = 0;
      if (!t.general) {
        const theirs = new Set([...words(t.label), ...words(t.noun), ...words(t.instance)]);
        const hits = [...own].filter((w) => theirs.has(w));
        if (hits.length) {
          // A new collection is named after the sheet, so it always "matches";
          // it scores just under a real collection that calls itself the same.
          score += t.status === "new" ? 4 : Math.min(10, 5 * hits.length);
          why.push(`the sheet calls itself "${hits.join(", ")}"`);
        }
      } else {
        score += 1;
      }
      const matched = sheet.columns.filter((c) => {
        const f = matchField(c, t.fields.filter((f) => !f.native));
        return f !== null;
      });
      if (matched.length) {
        score += 2 * matched.length;
        why.push(`${matched.length} column${matched.length === 1 ? "" : "s"} match its fields (${matched.map((c) => c.header).slice(0, 3).join(", ")})`);
      }
      const rowsHere = topCounts.get(i) ?? 0;
      if (sample.length && rowsHere) {
        score += Math.round((4 * rowsHere) / sample.length);
        if (rowsHere / sample.length >= 0.3) why.push(`${rowsHere} of the first ${sample.length} rows read like its things`);
      }
      if (t.status === "existing" && score > 1) score += 1;
      return { target: t, score, why };
    })
    .sort((a, b) => b.score - a.score || rank(a.target) - rank(b.target));
}

function rank(t: Target): number {
  return { existing: 0, install: 1, enable: 2, new: 3 }[t.status];
}

/** The best target, or the general table when nothing is sure enough. */
export function chooseTarget(scores: TargetScore[], threshold = 5): TargetScore {
  const best = scores[0]!;
  if (best.score >= threshold || best.target.general) return best;
  return scores.find((s) => s.target.general) ?? best;
}

// ─── columns onto fields ─────────────────────────────────────────────────────

function matchField(c: UnderstoodColumn, fields: TargetField[]): TargetField | null {
  const h = norm(c.header);
  const hs = singular(h);
  const byName = fields.find((f) => [norm(f.name), norm(f.label)].some((n) => n === h || singular(n) === hs));
  if (byName) return byName;
  for (const f of fields) {
    const syn = NATIVE_SYNONYMS[f.name];
    if (syn && syn.includes(h)) return f;
  }
  // By meaning, only onto a collection's own fields: a native column with a
  // role (inventory's serial number is its identifier) is matched by its own
  // names, so an SKU never lands in the serial number.
  const role = roleOfHeader(c.header);
  if (role) {
    const byRole = fields.find((f) => !f.native && f.field_role === role);
    if (byRole) return byRole;
  }
  return null;
}

function slugOf(header: string, taken: Set<string>): string {
  let base = header
    .toLowerCase()
    .replace(/#/g, " number ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!base) base = "column";
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  if (base.endsWith("_note")) base = `${base}s`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

function newFieldFor(c: UnderstoodColumn, taken: Set<string>, heldRoles: Set<string>): Extract<Destination, { to: "new-field" }> {
  const d = newFieldShape(c, taken);
  // A role one field on the collection already holds is not handed out twice.
  if (d.field_role && heldRoles.has(d.field_role)) delete d.field_role;
  if (d.field_role) heldRoles.add(d.field_role);
  return d;
}

function newFieldShape(c: UnderstoodColumn, taken: Set<string>): Extract<Destination, { to: "new-field" }> {
  const field = slugOf(c.header, taken);
  const base = { to: "new-field" as const, field, label: c.header };
  switch (c.type) {
    case "number":
      return { ...base, type: "number" };
    case "money":
      return { ...base, type: "number", unit: c.currency ?? null };
    case "quantity":
      return { ...base, type: "number", unit: c.unit ?? null };
    case "date":
      return { ...base, type: "date", ...(roleOfHeader(c.header) === "expiry" ? { field_role: "expiry" } : {}) }; // VOCAB-ENUMERATION OK: a declared destination or column role
    case "boolean":
      return { ...base, type: "boolean" };
    case "url":
    case "image":
      return { ...base, type: "url" };
    case "choice":
      return { ...base, type: "text", choices: c.choices ?? [], ...(c.role === "category" ? { field_role: "category" } : {}) }; // VOCAB-ENUMERATION OK: a column role (sheet-understand's own vocabulary)
    default: {
      const role = c.role === "key" ? "identifier" : roleOfHeader(c.header); // VOCAB-ENUMERATION OK: a declared destination or column role
      return { ...base, type: "text", ...(role && role !== "expiry" ? { field_role: role } : {}) };
    }
  }
}

export function planColumns(sheet: UnderstoodSheet, target: Target, overrides: SheetOverrides = {}): ColumnPlan[] {
  const taken = new Set(target.fields.map((f) => f.name));
  const heldRoles = new Set(target.fields.map((f) => f.field_role).filter((r): r is string => Boolean(r)));
  const used = new Set<string>();
  const nativeNames = new Set(target.fields.filter((f) => f.native).map((f) => f.name));
  const plans: ColumnPlan[] = [];

  sheet.columns.forEach((c, i) => {
    const forced = overrides.columns?.[i];
    let dest: Destination;
    let why: string;
    const free = target.fields.filter((f) => !used.has(f.name));
    const match = matchField(c, free);
    if (forced) {
      dest = forced;
      why = "chosen";
    } else if (c.role === "name") {
      dest = { to: "name" };
      why = "the name of each thing";
      // VOCAB-ENUMERATION OK: a column role (sheet-understand's own vocabulary), not a field role
    } else if (c.role === "location") {
      dest = { to: "location" }; // VOCAB-ENUMERATION OK: a declared destination or column role
      why = c.derived === "section" ? "the headings the rows sit under are places" : "where each thing is kept";
    } else if (c.role === "photo") {
      dest = { to: "photo" };
      why = "a picture of each thing";
    } else if (c.role === "quantity" && target.counts) {
      dest = { to: "quantity" };
      why = "how many there are";
    } else if (c.role === "category" && target.category) { // VOCAB-ENUMERATION OK: a declared destination or column role
      dest = { to: "category" };
      why = `sorted into ${target.category.label}`;
    } else if (c.type === "tags") {
      dest = { to: "tags" };
      why = "each value becomes a tag";
    } else if (match) {
      dest = { to: "field", field: match.name, label: match.label, native: match.native };
      why = match.native ? `goes in ${match.label}` : `matches the ${match.label} field`;
    } else {
      dest = newFieldFor(c, taken, heldRoles);
      why = `a new ${dest.type === "text" && dest.choices?.length ? "choice" : dest.type} field`;
    }
    if (dest.to === "field") used.add(dest.field);
    if (dest.to === "new-field") used.add(dest.field);
    plans.push({ column: i, header: c.header, type: c.type, role: c.role, samples: c.samples, dest, why, misfits: 0 });
  });

  // One column, one place: a second column landing on a field already taken
  // (two columns both reading as "price") keeps its own new field. What a
  // person chose is settled first, so a guess never displaces a choice.
  const seen = new Set<string>();
  const chosenFirst = [...plans].sort((a, b) => Number(b.why === "chosen") - Number(a.why === "chosen"));
  for (const p of chosenFirst) {
    if (p.dest.to !== "field" && p.dest.to !== "new-field") continue;
    if (seen.has(p.dest.field)) {
      p.dest = newFieldFor(sheet.columns[p.column]!, taken, heldRoles);
      p.why = "a new field (another column already goes in that one)";
    }
    seen.add(p.dest.field);
  }
  // A new field never reuses a native column's name.
  for (const p of plans) if (p.dest.to === "new-field" && nativeNames.has(p.dest.field)) p.dest.field = slugOf(`${p.dest.field}_value`, taken);
  return plans;
}

// ─── rows onto records ───────────────────────────────────────────────────────

function display(v: Value): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return v.text;
  return String(v);
}

/** A value shaped for the field it is going into, or undefined with a reason. */
function fitValue(v: Value, type: string): { value: unknown } | { misfit: string } {
  if (v === null) return { value: undefined };
  if (type === "number") {
    if (typeof v === "number") return { value: v };
    if (typeof v === "object" && !Array.isArray(v)) return { value: v.amount };
    // The same reading the column's own type came from, so "48V" in a
    // sentence is never the number 48.
    const n = parseNumber(display(v)) ?? parseQuantity(display(v))?.amount ?? null;
    return n !== null ? { value: n } : { misfit: `"${display(v)}" is not a number` };
  }
  if (type === "date") {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : { misfit: `"${display(v)}" is not a date` };
  }
  if (type === "boolean") {
    return typeof v === "boolean" ? { value: v } : { misfit: `"${display(v)}" is not yes or no` };
  }
  return { value: display(v) };
}

export function splitPath(v: string): string[] {
  return v
    .split(/\s*(?:\/|>|›|»|\\)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pathKey(path: string[]): string {
  return path.map((p) => p.toLowerCase()).join("\u0001");
}

/** Every existing location by its full path. */
export function locationPaths(locations: KnownLocation[]): Map<string, string> {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const out = new Map<string, string>();
  for (const l of locations) {
    const segs: string[] = [];
    let cur: KnownLocation | undefined = l;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      segs.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(pathKey(segs), l.id);
  }
  return out;
}

/** A place written by its own name alone ("Pegboard") is that place wherever
 *  it sits in the tree, when the name is unique. */
function locationByLeaf(locations: KnownLocation[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const l of locations) {
    const k = l.name.toLowerCase();
    out.set(k, out.has(k) ? null : l.id);
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b || (a === "" && b == null) || (b === "" && a == null);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim() === String(b).trim();
}

export interface PlanInput {
  sheet: UnderstoodSheet;
  filename: string;
  targets: Target[];
  locations: KnownLocation[];
  /** Existing records of the chosen target, when it already exists. */
  existing?: ExistingRecord[];
  overrides?: SheetOverrides;
  /** A target chosen already (the route's first pass), to skip re-scoring. */
  scores?: TargetScore[];
}

export function planSheet(input: PlanInput): SheetPlan {
  const { sheet, overrides = {} } = input;
  const scores = input.scores ?? scoreTargets(sheet, input.filename, input.targets);
  const forced = overrides.target ? scores.find((s) => s.target.id === overrides.target) : undefined;
  const chosen = forced ?? chooseTarget(scores);
  const named = overrides.collection_label?.trim();
  const target = chosen.target.status === "new" && named ? { ...chosen.target, label: named, noun: named } : chosen.target;
  const columns = planColumns(sheet, target, overrides);

  const fieldType = new Map<string, string>(target.fields.map((f) => [f.name, f.type]));
  for (const c of columns) if (c.dest.to === "new-field") fieldType.set(c.dest.field, c.dest.type);

  const paths = locationPaths(input.locations);
  const leaves = locationByLeaf(input.locations);
  const newPaths = new Map<string, string[]>();
  const knownCategories = new Set((target.category?.values ?? []).map((c) => c.toLowerCase()));
  const newCategories = new Map<string, string>();
  const tagsUsed = new Map<string, string>();

  // Matching what is already there: by the key column when there is one,
  // otherwise by name when every name in the sheet is different.
  const keyPlan = columns.find((c) => sheet.columns[c.column]?.role === "key" && (c.dest.to === "field" || c.dest.to === "new-field"));
  const keyField = keyPlan && (keyPlan.dest.to === "field" || keyPlan.dest.to === "new-field") ? keyPlan.dest.field : null;
  const nameIdx = columns.findIndex((c) => c.dest.to === "name");
  const namesInSheet = nameIdx >= 0 ? sheet.rows.map((r) => display(r.values[nameIdx] ?? null).toLowerCase()).filter(Boolean) : [];
  const namesUnique = new Set(namesInSheet).size === namesInSheet.length;
  const byKey = new Map<string, ExistingRecord>();
  const byName = new Map<string, ExistingRecord | null>();
  for (const r of input.existing ?? []) {
    if (keyField) {
      const k = r.values[keyField];
      if (k != null && String(k).trim()) byKey.set(String(k).trim().toLowerCase(), r);
    }
    const n = r.name.toLowerCase();
    byName.set(n, byName.has(n) ? null : r);
  }

  const leftOut = new Set(overrides.skip_rows ?? []);
  const records: RecordPlan[] = sheet.rows.filter((r) => !leftOut.has(r.row)).map((r) => {
    const problems: string[] = [];
    const rec: RecordPlan = { row: r.row, action: "create", name: "", fields: {}, problems };
    columns.forEach((c) => {
      const v = r.values[c.column] ?? null;
      if (v === null || c.dest.to === "skip") return;
      switch (c.dest.to) {
        case "name":
          rec.name = display(v);
          break;
        case "quantity":
          if (typeof v === "number") rec.qty = v;
          else if (typeof v === "object" && !Array.isArray(v)) {
            rec.qty = v.amount;
            if (v.unit) rec.unit = v.unit;
          } else {
            problems.push(`${c.header}: "${display(v)}" is not a count`);
            c.misfits++;
          }
          break;
        case "location": {
          const path = splitPath(display(v));
          if (!path.length) break;
          rec.location_path = path;
          const found = paths.get(pathKey(path)) ?? (path.length === 1 ? leaves.get(path[0]!.toLowerCase()) : undefined);
          if (!found) for (let i = 1; i <= path.length; i++) {
            const prefix = path.slice(0, i);
            if (!paths.has(pathKey(prefix))) newPaths.set(pathKey(prefix), prefix);
          }
          break;
        }
        case "category": {
          const name = display(v);
          rec.category = name;
          if (!knownCategories.has(name.toLowerCase())) newCategories.set(name.toLowerCase(), name);
          break;
        }
        case "tags":
          rec.tags = Array.isArray(v) ? v : [display(v)];
          for (const t of rec.tags) tagsUsed.set(t.toLowerCase(), t);
          break;
        case "photo":
          rec.photo_url = display(v);
          break;
        case "field":
        case "new-field": {
          const fitted = fitValue(v, fieldType.get(c.dest.field) ?? "text");
          if ("misfit" in fitted) {
            // Kept as written in a field of its own name rather than dropped.
            problems.push(`${c.header}: ${fitted.misfit}, kept as text`);
            rec.fields[`${c.dest.field}_as_written`] = display(v);
            c.misfits++;
          } else if (fitted.value !== undefined) {
            rec.fields[c.dest.field] = fitted.value;
          }
          break;
        }
      }
    });
    if (!rec.name) {
      const fallback = keyField && rec.fields[keyField] != null ? String(rec.fields[keyField]) : null;
      rec.name = fallback ?? `Row ${r.row}`;
      problems.push(fallback ? "no name, named by its key" : "no name, named by its row");
    }

    const keyValue = keyField && rec.fields[keyField] != null ? String(rec.fields[keyField]).trim().toLowerCase() : null;
    const match = keyValue ? byKey.get(keyValue) : !keyField && namesUnique ? (byName.get(rec.name.toLowerCase()) ?? undefined) : undefined;
    if (match) {
      rec.existing_id = match.id;
      const changes: FieldChange[] = [];
      if (!same(match.name, rec.name)) changes.push({ field: "name", from: match.name, to: rec.name });
      for (const [k, v] of Object.entries(rec.fields)) if (!same(match.values[k], v)) changes.push({ field: k, from: match.values[k] ?? null, to: v });
      if (rec.qty != null && !same(match.values.qty, rec.qty)) changes.push({ field: "qty", from: match.values.qty ?? null, to: rec.qty });
      if (rec.location_path && !same(match.values.location_name, rec.location_path[rec.location_path.length - 1])) {
        changes.push({ field: "location", from: match.values.location_name ?? null, to: rec.location_path.join(" / ") });
      }
      if (rec.category) {
        const had = target.category?.field ? match.values[target.category.field] : match.values.category_name;
        if (!same(had, rec.category)) changes.push({ field: target.category?.field ?? "category", from: had ?? null, to: rec.category });
      }
      rec.action = changes.length ? "update" : "unchanged";
      if (changes.length) rec.changes = changes;
    }
    return rec;
  });

  const fields_to_create = columns
    .map((c) => c.dest)
    .filter((d): d is Extract<Destination, { to: "new-field" }> => d.to === "new-field");
  // A misfit kept as text needs somewhere to live.
  for (const c of columns) {
    if ((c.dest.to === "field" || c.dest.to === "new-field") && c.misfits > 0) {
      fields_to_create.push({ to: "new-field", field: `${c.dest.field}_as_written`, label: `${c.header} (as written)`, type: "text" });
    }
  }

  const needs_admin: string[] = [];
  if (target.enable_module) needs_admin.push(`turns on ${target.enable_module.label}`);
  if (target.status === "install") needs_admin.push(`installs ${target.label}`);
  if (target.status === "new") needs_admin.push(`makes a new collection, ${target.label}`);
  if (fields_to_create.length) needs_admin.push(`adds ${fields_to_create.length} field${fields_to_create.length === 1 ? "" : "s"}`);

  const alternatives = scores
    .filter((s) => s.target.id !== target.id)
    .map((s) => ({ id: s.target.id, label: s.target.label, status: s.target.status, module: s.target.module }));

  return {
    sheet: sheet.name,
    include: overrides.include ?? (!sheet.hidden && !sheet.empty),
    target,
    alternatives,
    why_target: forced ? "chosen" : chosen.why.join("; ") || (target.general ? "nothing more specific fits" : ""),
    columns,
    records,
    counts: {
      create: records.filter((r) => r.action === "create").length,
      update: records.filter((r) => r.action === "update").length,
      unchanged: records.filter((r) => r.action === "unchanged").length,
      skipped_rows: sheet.skipped.filter((s) => s.reason !== "blank" && s.reason !== "section").length + sheet.rows.filter((r) => leftOut.has(r.row)).length,
    },
    ...(target.status === "install" && target.bundle_external_id ? { install: { bundle_external_id: target.bundle_external_id, label: target.label } } : {}),
    ...(target.enable_module ? { enable: { module: target.enable_module.name, label: target.enable_module.label } } : {}),
    ...(target.status === "new" ? { new_collection: { module: target.module, instance: target.instance, label: target.label } } : {}),
    fields_to_create,
    locations_to_create: [...newPaths.values()].sort((a, b) => a.length - b.length),
    categories_to_create: [...newCategories.values()],
    tags_used: [...tagsUsed.values()],
    needs_admin,
    skipped: [
      ...sheet.skipped,
      ...sheet.rows.filter((r) => leftOut.has(r.row)).map((r) => ({ row: r.row, reason: "excluded" as const, text: nameIdx >= 0 ? display(r.values[columns[nameIdx]!.column] ?? null) : undefined })),
    ].sort((a, b) => a.row - b.row),
  };
}
