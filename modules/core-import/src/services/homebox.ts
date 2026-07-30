// Homebox CSV/TSV → normalized records (pure, no I/O, unit-testable). Homebox's
// export uses `HB.`-prefixed columns; a location is a `/`-separated path, labels
// are `;`-separated, and custom fields arrive as `HB.field.<Name>` columns.
// Reference: Homebox docs → Import/Export (the `HB.*` column contract).
//
// This only PARSES + NORMALIZES. Fanning the records out to core-locations /
// inventory / core-tags is the router's job (api/homebox-import.ts), through
// those modules' public APIs — never a cross-module import.

export interface HomeboxItem {
  row: number;
  name: string;
  description: string | null;
  quantity: number;
  /** Location as an ordered path of segments (["Garage","Shelf 1"]); null if blank. */
  location_path: string[] | null;
  labels: string[];
  serial_number: string | null;
  model_number: string | null;
  manufacturer: string | null;
  notes: string | null;
  purchase_price: number | null;
  purchase_from: string | null;
  purchase_time: string | null; // YYYY-MM-DD
  lifetime_warranty: boolean;
  warranty_expires: string | null; // YYYY-MM-DD
  warranty_details: string | null;
  insured: boolean;
  archived: boolean;
  asset_id: string | null;
  import_ref: string | null;
  sold_to: string | null;
  sold_price: number | null;
  sold_time: string | null;
  sold_notes: string | null;
  /** HB.field.<Name> → value, verbatim. */
  custom_fields: Record<string, string>;
}

export interface HomeboxParse {
  items: HomeboxItem[];
  /** Every distinct location path seen, parents included (["A"], ["A","B"] …). */
  location_paths: string[][];
  /** Every distinct label seen. */
  labels: string[];
  /** Every distinct HB.field.<Name> custom-field name seen. */
  custom_field_names: string[];
  warnings: { row: number; message: string }[];
  errors: { row: number; message: string }[];
  detected: { delimiter: "comma" | "tab"; is_homebox: boolean; columns: string[] };
}

// ── delimited parsing (RFC-4180-ish; handles quoted cells, doubled quotes, CRLF) ──
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  let i = 0;
  const pushCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { pushCell(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { pushCell(); i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") { endRow(); i += 2; continue; }
    if (c === "\n" || c === "\r") { endRow(); i++; continue; }
    cell += c; i++;
  }
  if (cell.length > 0 || row.length > 0) endRow();
  // Drop a fully-empty trailing row.
  if (rows.length && rows[rows.length - 1]!.every((v) => v === "")) rows.pop();
  return rows;
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/^hb\./, "");
const asStr = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};
const asBool = (v: string | undefined): boolean => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
};
const asDate = (v: string | undefined): string | null => {
  const s = (v ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const asNum = (v: string | undefined): number | null => {
  const s = (v ?? "").replace(/[$€£¥]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Split a Homebox location path on `/` (segments trimmed, blanks dropped). */
export function splitLocationPath(v: string | null): string[] | null {
  if (!v) return null;
  const parts = v.split("/").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}
const splitLabels = (v: string | null): string[] =>
  v ? v.split(";").map((l) => l.trim()).filter(Boolean) : [];

/** Canonical key for a location path (case-insensitive), so the same path from
 *  two rows — or an already-existing location tree — collapses to one node. */
export const locationPathKey = (segs: string[]): string => segs.map((s) => s.toLowerCase()).join(" / ");
const pathKey = locationPathKey;

export function parseHomebox(text: string): HomeboxParse {
  const warnings: { row: number; message: string }[] = [];
  const errors: { row: number; message: string }[] = [];
  const clean = text.replace(/^﻿/, ""); // strip BOM
  const headerLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delim = headerLine.includes("\t") ? "\t" : ",";
  const rows = parseDelimited(clean, delim);
  if (rows.length === 0) {
    return { items: [], location_paths: [], labels: [], custom_field_names: [], warnings, errors: [{ row: 0, message: "empty file" }], detected: { delimiter: "comma", is_homebox: false, columns: [] } };
  }
  const rawHeaders = rows[0]!;
  const headers = rawHeaders.map(norm);
  const isHomebox = rawHeaders.some((h) => /^hb\./i.test(h.trim()));
  const idx = (field: string): number => headers.indexOf(field);
  const nameIdx = idx("name");
  if (nameIdx < 0) {
    errors.push({ row: 0, message: "no HB.name (or name) column, is this a Homebox export?" });
  }
  // Custom-field columns: header `HB.field.<Name>` → normalized `field.<name>`.
  const customCols: { col: number; name: string }[] = [];
  headers.forEach((h, i) => {
    const m = h.match(/^field\.(.+)$/);
    if (m) customCols.push({ col: i, name: rawHeaders[i]!.trim().replace(/^hb\.field\./i, "") });
  });

  const items: HomeboxItem[] = [];
  const seenPaths = new Map<string, string[]>();
  const seenLabels = new Set<string>();
  const seenFields = new Set<string>();

  for (let r = 1; r < rows.length && nameIdx >= 0; r++) {
    const cells = rows[r]!;
    const get = (field: string): string | undefined => {
      const i = idx(field);
      return i >= 0 ? cells[i] : undefined;
    };
    const name = asStr(get("name"));
    if (!name) {
      warnings.push({ row: r, message: "row skipped: no name" });
      continue;
    }
    const locPath = splitLocationPath(asStr(get("location")));
    if (locPath) {
      // Register every prefix so parents get created too.
      for (let d = 1; d <= locPath.length; d++) {
        const prefix = locPath.slice(0, d);
        seenPaths.set(pathKey(prefix), prefix);
      }
    }
    const labels = splitLabels(asStr(get("labels")));
    for (const l of labels) seenLabels.add(l);
    const custom: Record<string, string> = {};
    for (const { col, name: fname } of customCols) {
      const v = asStr(cells[col]);
      if (v !== null) { custom[fname] = v; seenFields.add(fname); }
    }
    const q = asNum(get("quantity"));
    items.push({
      row: r,
      name,
      description: asStr(get("description")),
      quantity: q !== null && Number.isInteger(q) && q >= 0 ? q : 1,
      location_path: locPath,
      labels,
      serial_number: asStr(get("serial_number")),
      model_number: asStr(get("model_number")),
      manufacturer: asStr(get("manufacturer")),
      notes: asStr(get("notes")),
      purchase_price: asNum(get("purchase_price")),
      purchase_from: asStr(get("purchase_from")),
      purchase_time: asDate(get("purchase_time")),
      lifetime_warranty: asBool(get("lifetime_warranty")),
      warranty_expires: asDate(get("warranty_expires")),
      warranty_details: asStr(get("warranty_details")),
      insured: asBool(get("insured")),
      archived: asBool(get("archived")),
      asset_id: asStr(get("asset_id")),
      import_ref: asStr(get("import_ref")),
      sold_to: asStr(get("sold_to")),
      sold_price: asNum(get("sold_price")),
      sold_time: asDate(get("sold_time")),
      sold_notes: asStr(get("sold_notes")),
      custom_fields: custom,
    });
  }

  // Emit location paths shallowest-first so parents precede children on create.
  const location_paths = [...seenPaths.values()].sort((a, b) => a.length - b.length || pathKey(a).localeCompare(pathKey(b)));

  return {
    items,
    location_paths,
    labels: [...seenLabels],
    custom_field_names: [...seenFields],
    warnings,
    errors,
    detected: { delimiter: delim === "\t" ? "tab" : "comma", is_homebox: isHomebox, columns: rawHeaders.map((h) => h.trim()) },
  };
}
/** The Homebox fields Cobblr has no native column for, as a structured bag for
 *  the part's `metadata.homebox` — lossless, and available for a future
 *  structured custom-field mapping. Returns null if there's nothing extra. */
export function homeboxMetadata(it: HomeboxItem): Record<string, unknown> | null {
  const m: Record<string, unknown> = {};
  const pairs: [string, unknown][] = [
    ["import_ref", it.import_ref],
    ["asset_id", it.asset_id],
    ["purchase_from", it.purchase_from],
    ["purchase_time", it.purchase_time],
    ["sold_to", it.sold_to],
    ["sold_price", it.sold_price],
    ["sold_time", it.sold_time],
    ["sold_notes", it.sold_notes],
  ];
  for (const [k, v] of pairs) if (v !== null && v !== undefined && String(v).trim() !== "") m[k] = v;
  if (Object.keys(it.custom_fields).length) m.fields = it.custom_fields;
  return Object.keys(m).length ? m : null;
}
