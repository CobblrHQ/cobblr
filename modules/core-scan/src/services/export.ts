// Scan-inbox bulk EXPORT — the pure BUILD half (no I/O, unit-testable). The
// mirror of import.ts: turns Cobblr core_scan_inbox_items rows into the
// INBOX_EXPORT_INTEROP v1 envelope (JSON or CSV) that import.ts consumes — so a
// scan inbox round-trips Cobblr→Cobblr (and out to an external system, which reads the
// same shape). Contract: the inbox-export interop spec (v1).
//
// Photos are injected by the caller as a resolver (fileId → a PhotoRef), because
// only the router knows the request origin + secret (to mint the no-auth, per-file
// image token a `link`-mode export bakes into each URL) AND can read the bytes an
// `embed`-mode export base64s inline. A `link` ref keeps the file small but needs
// the destination to reach this instance; an `embed` ref is self-contained (works
// LAN-only / air-gapped) at the cost of size. `none` → the resolver returns null.

/** How the caller chose to carry each photo. `url` = a fetchable link (link
 *  mode); `embed` = the bytes inline as base64 (baked-in mode). */
export type PhotoRef = { url: string } | { embed: EmbeddedPhoto };
export type PhotoResolver = (fileId: string) => PhotoRef | null;
export interface EmbeddedPhoto {
  mime: string;
  /** base64 (not data-URI) of the raw bytes. */
  data: string;
}

/** The subset of a core_scan_inbox_items row the exporter reads. */
export interface ScanRowForExport {
  id: string;
  status: string;
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  suggested_metadata: Record<string, unknown> | null;
  ai_notes: string | null;
  ai_confidence: number | string | null;
  target_kind: string | null;
  scan_area: string | null;
  quantity: number | null;
  suggested_candidates: unknown;
  suggested_location_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ExportItem {
  source_id: string;
  status: string;
  barcode: string | null;
  additional_barcodes: string[];
  suggested_name: string | null;
  suggested_sku: string | null;
  suggested_serial_number: string | null;
  suggested_entity_type: string | null;
  suggested_category: { domain: string | null; sub: string | null };
  ai_confidence: number | null;
  ai_notes: string | null;
  quantity: number;
  pack_size: string | null;
  pack_state: string | null;
  filament_state: string | null;
  scan_area: string | null;
  box_state: string | null;
  notes: string | null;
  research_hint: string | null;
  source_url: string | null;
  /** `link`-mode / external-catalog photos as fetchable URLs (null in a
   *  baked-in export). */
  photo_urls: { identify: string | null; display: string | null };
  /** `embed`-mode photos: raw bytes base64'd inline, so the export needs no
   *  network to restore them. Null unless at least one photo was baked in. */
  photos_embedded: { identify: EmbeddedPhoto | null; display: EmbeddedPhoto | null } | null;
  created_at: string;
  updated_at: string;
  /** Cobblr-native richness the interop schema has no slot for — routing
   *  candidates + full scan metadata. import.ts (and other consumers) ignore unknown item
   *  fields (§7 forward-compat), so this is a lossless carrier for a future
   *  Cobblr→Cobblr importer that wants to restore candidates verbatim rather
   *  than re-run the matchmaker. */
  x_cobblr: {
    suggested_manufacturer: string | null;
    suggested_location_note: string | null;
    suggested_candidates: unknown;
    metadata: Record<string, unknown> | null;
  };
}

export interface ExportEnvelope {
  schema_version: 1;
  source: "cobblr";
  source_instance: string | null;
  exported_at: string;
  scope: { type: "filter"; status: string; batch_id: string | null };
  count: number;
  items: ExportItem[];
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

function metaObj(row: ScanRowForExport): Record<string, unknown> {
  return (row.suggested_metadata ?? {}) as Record<string, unknown>;
}

const refUrl = (r: PhotoRef | null): string | null => (r && "url" in r ? r.url : null);
const refEmbed = (r: PhotoRef | null): EmbeddedPhoto | null => (r && "embed" in r ? r.embed : null);

/** Build one interop item from a Cobblr scan row. `resolve` returns a PhotoRef
 *  (a url or embedded bytes) for a stored file id, or null. */
export function rowToItem(row: ScanRowForExport, resolve: PhotoResolver): ExportItem {
  const meta = metaObj(row);
  const sourceStates = (meta.source_states ?? {}) as Record<string, unknown>;
  const cat = (meta.hint_category ?? {}) as { domain?: unknown; sub?: unknown };
  const aliases = Array.isArray(meta.barcode_aliases)
    ? (meta.barcode_aliases as unknown[]).map((b) => String(b).trim()).filter(Boolean)
    : [];
  let confidence: number | null = null;
  if (row.ai_confidence !== null && row.ai_confidence !== undefined && String(row.ai_confidence).trim() !== "") {
    const c = Number(row.ai_confidence);
    if (Number.isFinite(c)) confidence = c;
  }
  // identify = the photo the user took (a stored file).
  const idRef = row.image_file_id ? resolve(row.image_file_id) : null;
  // display = a downloaded catalog file if we have one (resolvable), else the
  // external catalog URL (already public + fetchable — never embedded), else none.
  const dispRef: PhotoRef | null = row.catalog_image_file_id
    ? resolve(row.catalog_image_file_id)
    : row.catalog_image_url
      ? { url: str(row.catalog_image_url)! }
      : null;
  const embedId = refEmbed(idRef);
  const embedDisplay = refEmbed(dispRef);
  return {
    source_id: row.id,
    status: row.status,
    barcode: str(row.barcode_text),
    additional_barcodes: aliases,
    suggested_name: str(row.suggested_name),
    suggested_sku: str(row.suggested_sku),
    suggested_serial_number: str(meta.suggested_serial_number),
    suggested_entity_type: str(meta.hint_entity_type) ?? str(row.target_kind),
    suggested_category: { domain: str(cat.domain), sub: str(cat.sub) },
    ai_confidence: confidence,
    ai_notes: str(row.ai_notes),
    quantity: Number.isInteger(row.quantity) && (row.quantity as number) >= 1 ? (row.quantity as number) : 1,
    pack_size: str(sourceStates.pack_size),
    pack_state: str(sourceStates.pack_state),
    filament_state: str(sourceStates.filament_state),
    scan_area: str(row.scan_area),
    box_state: str(sourceStates.box_state),
    notes: str(meta.notes),
    research_hint: str(meta.research_hint),
    source_url: str(row.source_url),
    photo_urls: { identify: refUrl(idRef), display: refUrl(dispRef) },
    photos_embedded:
      embedId || embedDisplay ? { identify: embedId, display: embedDisplay } : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    x_cobblr: {
      suggested_manufacturer: str(row.suggested_manufacturer),
      suggested_location_note: str(row.suggested_location_note),
      suggested_candidates: row.suggested_candidates ?? null,
      metadata: row.suggested_metadata ?? null,
    },
  };
}

export function buildEnvelope(
  rows: ScanRowForExport[],
  resolve: PhotoResolver,
  opts: { sourceInstance: string | null; exportedAt: string; status: string; batchId: string | null },
): ExportEnvelope {
  const items = rows.map((r) => rowToItem(r, resolve));
  return {
    schema_version: 1,
    source: "cobblr",
    source_instance: opts.sourceInstance,
    exported_at: opts.exportedAt,
    scope: { type: "filter", status: opts.status, batch_id: opts.batchId },
    count: items.length,
    items,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Canonical header order — the flattened source-state shape import.ts's resolveHeader
 *  understands (category domain/sub and identify/display photo URLs flattened
 *  to their own columns; x_cobblr is JSON-only). */
export const CSV_HEADERS = [
  "source_id", "status", "barcode", "additional_barcodes", "suggested_name",
  "suggested_sku", "suggested_serial_number", "suggested_entity_type",
  "category_domain", "category_sub", "ai_confidence", "ai_notes", "quantity",
  "pack_size", "pack_state", "filament_state", "scan_area", "box_state",
  "notes", "research_hint", "source_url", "identify_photo_url",
  "display_photo_url", "created_at", "updated_at",
] as const;

/** RFC 4180: quote a cell only if it contains comma, quote, CR or LF; double
 *  embedded quotes. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(rows: ScanRowForExport[], photoUrl: (fileId: string) => string | null): string {
  // CSV is a flat, link-only shape — no place for embedded bytes. Wrap the
  // url factory into a resolver that only ever yields url refs.
  const resolve: PhotoResolver = (id) => {
    const u = photoUrl(id);
    return u ? { url: u } : null;
  };
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    const it = rowToItem(row, resolve);
    const cells: Record<(typeof CSV_HEADERS)[number], unknown> = {
      source_id: it.source_id,
      status: it.status,
      barcode: it.barcode,
      additional_barcodes: it.additional_barcodes.join("|"),
      suggested_name: it.suggested_name,
      suggested_sku: it.suggested_sku,
      suggested_serial_number: it.suggested_serial_number,
      suggested_entity_type: it.suggested_entity_type,
      category_domain: it.suggested_category.domain,
      category_sub: it.suggested_category.sub,
      ai_confidence: it.ai_confidence,
      ai_notes: it.ai_notes,
      quantity: it.quantity,
      pack_size: it.pack_size,
      pack_state: it.pack_state,
      filament_state: it.filament_state,
      scan_area: it.scan_area,
      box_state: it.box_state,
      notes: it.notes,
      research_hint: it.research_hint,
      source_url: it.source_url,
      identify_photo_url: it.photo_urls.identify,
      display_photo_url: it.photo_urls.display,
      created_at: it.created_at,
      updated_at: it.updated_at,
    };
    lines.push(CSV_HEADERS.map((h) => csvCell(cells[h])).join(","));
  }
  return lines.join("\r\n");
}
