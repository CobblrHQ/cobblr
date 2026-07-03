// Scan-inbox bulk import — the PARSE/TRANSLATE half (pure, no I/O, unit-testable).
// Accepts the companion app inbox export natively (JSON envelope or CSV) and any
// other system's CSV via a caller-supplied column `mapping`. Contract:
// companion app docs/INBOX_EXPORT_INTEROP.md (v1). Forward-compat by design:
// unknown fields are ignored, never fatal.

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

/** One normalized item, translated per §3 of the interop doc — ready to become
 *  a core_scan_inbox_items row + suggested_metadata payload. */
export interface NormalizedImportItem {
  /** 1-based data-row index in the source file (for error reporting). */
  row: number;
  provenance: { source: string; source_id: string; source_instance: string | null } | null;
  status: "pending" | "discarded";
  source_kind: "barcode" | "photo" | "url" | "note";
  barcode: string | null;
  suggested_name: string | null;
  suggested_sku: string | null;
  ai_confidence: number | null;
  ai_notes: string | null;
  quantity: number;
  scan_area: string | null;
  source_url: string | null;
  photo_identify_url: string | null;
  photo_display_url: string | null;
  /** Everything hint-shaped rides in suggested_metadata: hint_category,
   *  user_hint (matchmaker prior), barcode_aliases, wos pack/box states,
   *  notes/research_hint, originally_captured_at, import_provenance. */
  metadata: Record<string, unknown>;
}

export interface ParsedImport {
  source: string | null;
  source_instance: string | null;
  items: NormalizedImportItem[];
  errors: ImportRowError[];
  /** CSV only: the headers seen, and which canonical fields they resolved to
   *  (null = unmapped) — drives the UI's column mapper. */
  columns?: Array<{ header: string; field: string | null }>;
}

// ── RFC 4180 CSV ─────────────────────────────────────────────────────────────

/** Parse CSV text into rows of cells. Handles quoted cells with embedded
 *  commas, doubled quotes, and newlines (LF or CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const push = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      push();
      i++;
      continue;
    }
    if (c === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 2;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  // Trailing cell/row (no final newline).
  if (cell.length > 0 || row.length > 0) endRow();
  // Drop a fully-empty trailing row (file ended with a newline).
  if (rows.length && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  return rows;
}

// ── Header → canonical field resolution ──────────────────────────────────────

/** The canonical (companion app export) CSV headers, per §1 of the interop doc. */
const WOS_HEADERS: Record<string, string> = {
  source_id: "source_id",
  status: "status",
  barcode: "barcode",
  additional_barcodes: "additional_barcodes",
  suggested_name: "suggested_name",
  suggested_sku: "suggested_sku",
  suggested_serial_number: "suggested_serial_number",
  suggested_entity_type: "suggested_entity_type",
  category_domain: "category_domain",
  category_sub: "category_sub",
  ai_confidence: "ai_confidence",
  ai_notes: "ai_notes",
  quantity: "quantity",
  pack_size: "pack_size",
  pack_state: "pack_state",
  filament_state: "filament_state",
  scan_area: "scan_area",
  box_state: "box_state",
  notes: "notes",
  research_hint: "research_hint",
  source_url: "source_url",
  identify_photo_url: "identify_photo_url",
  display_photo_url: "display_photo_url",
  created_at: "created_at",
  updated_at: "updated_at",
};

/** Resolve a CSV header to a canonical field: caller `mapping` first (exact
 *  header match, e.g. {"Product Name": "suggested_name"}), then the companion app
 *  header set (case/space-insensitive). Null = unmapped (ignored, surfaced). */
export function resolveHeader(header: string, mapping?: Record<string, string>): string | null {
  if (mapping && Object.prototype.hasOwnProperty.call(mapping, header)) {
    const target = mapping[header]!;
    return WOS_HEADERS[target] ?? target; // allow mapping to a canonical name directly
  }
  const norm = header.trim().toLowerCase().replace(/\s+/g, "_");
  return WOS_HEADERS[norm] ?? null;
}

// ── Normalization (shared by CSV + JSON paths) ───────────────────────────────

const asStr = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

function normalize(raw: Record<string, unknown>, row: number, sourceInstance: string | null, source: string | null, errors: ImportRowError[]): NormalizedImportItem | null {
  const name = asStr(raw.suggested_name);
  const barcode = asStr(raw.barcode);
  const sourceUrl = asStr(raw.source_url);
  const identify = asStr(raw.identify_photo_url) ?? asStr((raw.photo_urls as { identify?: unknown } | undefined)?.identify);
  const display = asStr(raw.display_photo_url) ?? asStr((raw.photo_urls as { display?: unknown } | undefined)?.display);

  // quantity: integer ≥ 1 (default 1); a bad value is a row error but the row
  // still imports with 1 — a wrong quantity shouldn't drop a whole item.
  let quantity = 1;
  const qRaw = raw.quantity;
  if (qRaw !== null && qRaw !== undefined && String(qRaw).trim() !== "") {
    const q = Number(qRaw);
    if (!Number.isInteger(q) || q < 1) errors.push({ row, field: "quantity", message: "expected integer ≥ 1" });
    else quantity = q;
  }

  let confidence: number | null = null;
  const cRaw = asStr(raw.ai_confidence);
  if (cRaw !== null) {
    const c = Number(cRaw);
    if (Number.isFinite(c) && c >= 0 && c <= 1) confidence = c;
    else errors.push({ row, field: "ai_confidence", message: "expected 0..1" });
  }

  // companion app statuses: discarded stays discarded; pending/staged/triaged all land
  // as pending — Cobblr's matchmaker re-runs on them (§3: hints, not bindings).
  const status = asStr(raw.status) === "discarded" ? ("discarded" as const) : ("pending" as const);

  // additional barcodes: JSON array, or pipe-joined in CSV.
  const abRaw = raw.additional_barcodes;
  const aliases = Array.isArray(abRaw)
    ? abRaw.map((b) => String(b).trim()).filter(Boolean)
    : (asStr(abRaw) ?? "").split("|").map((s) => s.trim()).filter(Boolean);

  // category hint (never a hard binding): JSON nested or CSV flattened.
  const cat = (raw.suggested_category ?? {}) as { domain?: unknown; sub?: unknown };
  const domain = asStr(raw.category_domain) ?? asStr(cat.domain);
  const sub = asStr(raw.category_sub) ?? asStr(cat.sub);

  const sourceId = asStr(raw.source_id);
  const provenance = sourceId
    ? { source: source ?? "unknown", source_id: sourceId, source_instance: sourceInstance }
    : null;

  const metadata: Record<string, unknown> = {};
  if (provenance) metadata.import_provenance = provenance;
  if (domain || sub) {
    metadata.hint_category = { domain, sub };
    // The matchmaker's prompt honours lookup_metadata.user_hint as an explicit
    // tie-breaker — the source system's categorisation is exactly that: a
    // prior, not a destination.
    metadata.user_hint = ["source system categorised as", domain, sub ? `/ ${sub}` : null].filter(Boolean).join(" ");
  }
  if (aliases.length) metadata.barcode_aliases = aliases;
  const entityType = asStr(raw.suggested_entity_type);
  if (entityType) metadata.hint_entity_type = entityType;
  const serial = asStr(raw.suggested_serial_number);
  if (serial) metadata.suggested_serial_number = serial;
  const wos: Record<string, unknown> = {};
  for (const k of ["pack_size", "pack_state", "filament_state", "box_state"] as const) {
    const v = asStr(raw[k]);
    if (v) wos[k] = v;
  }
  if (Object.keys(wos).length) metadata.wos = wos;
  const notes = asStr(raw.notes);
  if (notes) metadata.notes = notes;
  const research = asStr(raw.research_hint);
  if (research) metadata.research_hint = research;
  const captured = asStr(raw.created_at);
  if (captured) metadata.originally_captured_at = captured;

  // source_kind: what the scan primarily IS. Barcode wins; then photo; then
  // url; a hint-only row (name/notes, no capture artifact) imports as a note.
  const source_kind = barcode ? ("barcode" as const) : identify ? ("photo" as const) : sourceUrl ? ("url" as const) : ("note" as const);
  if (!barcode && !identify && !sourceUrl && !name && !notes) {
    errors.push({ row, field: "", message: "empty row — no barcode, photo, url, name or notes; skipped" });
    return null;
  }

  return {
    row,
    provenance,
    status,
    source_kind,
    barcode,
    suggested_name: name,
    suggested_sku: asStr(raw.suggested_sku),
    ai_confidence: confidence,
    ai_notes: asStr(raw.ai_notes),
    quantity,
    scan_area: asStr(raw.scan_area),
    source_url: sourceUrl,
    photo_identify_url: identify,
    photo_display_url: display,
    metadata,
  };
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Parse a JSON envelope ({schema_version, source, items:[…]}) or a bare
 *  {items:[…]} / […] body. Unknown envelope/item fields are ignored (§7). */
export function parseJsonImport(body: unknown): ParsedImport {
  const errors: ImportRowError[] = [];
  let items: unknown[] = [];
  let source: string | null = null;
  let sourceInstance: string | null = null;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === "object") {
    const env = body as { items?: unknown; source?: unknown; source_instance?: unknown; schema_version?: unknown };
    if (env.schema_version !== undefined && Number(env.schema_version) !== 1) {
      errors.push({ row: 0, field: "schema_version", message: `unsupported schema_version ${String(env.schema_version)} (this importer speaks v1; unknown ITEM fields are fine, unknown versions are not)` });
      return { source: null, source_instance: null, items: [], errors };
    }
    items = Array.isArray(env.items) ? env.items : [];
    source = asStr(env.source);
    sourceInstance = asStr(env.source_instance);
    if (!Array.isArray(env.items)) errors.push({ row: 0, field: "items", message: "missing items[] array" });
  } else {
    errors.push({ row: 0, field: "", message: "body must be a JSON object or array" });
  }
  const out: NormalizedImportItem[] = [];
  items.forEach((it, idx) => {
    if (!it || typeof it !== "object") {
      errors.push({ row: idx + 1, field: "", message: "item is not an object" });
      return;
    }
    const n = normalize(it as Record<string, unknown>, idx + 1, sourceInstance, source, errors);
    if (n) out.push(n);
  });
  return { source, source_instance: sourceInstance, items: out, errors };
}

/** Parse CSV text (companion app headers or custom via `mapping`). */
export function parseCsvImport(text: string, mapping?: Record<string, string>, source?: string | null, sourceInstance?: string | null): ParsedImport {
  const errors: ImportRowError[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) return { source: source ?? null, source_instance: sourceInstance ?? null, items: [], errors: [{ row: 0, field: "", message: "empty file" }], columns: [] };
  const headers = rows[0]!.map((h) => h.trim());
  const columns = headers.map((h) => ({ header: h, field: resolveHeader(h, mapping) }));
  const out: NormalizedImportItem[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const raw: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      if (c.field) raw[c.field] = cells[i] ?? "";
    });
    const n = normalize(raw, r, sourceInstance ?? null, source ?? null, errors);
    if (n) out.push(n);
  }
  return { source: source ?? null, source_instance: sourceInstance ?? null, items: out, errors, columns };
}
