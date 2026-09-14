// Which of the inbox's item tools could apply to a row: the ONE rule.
//
// Every row used to be offered every tool: Split into items, Read as a
// receipt, Turn into a bin, Empty box, Item in box, on a barcode-identified
// laser engraver at 0.95 (#3006). "Most products are not a box/container,
// nor a receipt." The row already carries the evidence that says which
// tools could apply, and nothing read it. Like scan-triage's readiness rule,
// this lives in the contract so the desktop card's rail and the phone item
// screen read one answer, served on every row as `tool_hints`; a tool can
// never be folded on one surface and offered first on the other.
//
// Three answers per tool, with the reason the fold shows:
//   likely    render where the tool is today
//   possible  behind one disclosure ("More tools")
//   no        folded on a desktop (it has the room), not rendered on a phone
// Every capability stays reachable; only unrequested offers stop being shown
// first.
//
// The box tools (Empty box / Item in box, the row's box_state) key on WHAT
// WAS SCANNED, not on the product being a container: a code read off
// packaging, or a picture with packaging in frame, makes the box question
// real; a picture of the bare product does not, whatever the product. The
// vision passes say what they see as one key, `packaging`, asked for beside
// the observations they already give, and derived from the prose of a reply
// recorded before the key existed (packagingFromProse).

export type ScanTool = "receipt" | "split" | "bin" | "box_state";
export type ToolRelevance = "likely" | "possible" | "no";
export interface ToolHint {
  relevance: ToolRelevance;
  /** Why, in the words the fold shows ("not a container", "one unit seen"). */
  reason: string;
}
export type ScanToolHints = Record<ScanTool, ToolHint>;

export const SCAN_TOOLS: ScanTool[] = ["receipt", "split", "bin", "box_state"];

/** What a vision pass saw of the packaging: none (a bare product), box (a
 *  carton, blister or retail box in frame), sealed, opened, or unknown. */
export type Packaging = "none" | "box" | "sealed" | "opened" | "unknown";
export const PACKAGING_VALUES: Packaging[] = ["none", "box", "sealed", "opened", "unknown"];

export function asPackaging(v: unknown): Packaging | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (PACKAGING_VALUES as string[]).includes(s) ? (s as Packaging) : null;
}

/** The same value read off the prose of a reply recorded before the key was
 *  asked for ("one loose unit", "a sealed multipack of N", "in its retail
 *  box"). Sealed before box before opened before none: "sealed box" is
 *  sealed, "opened box" is opened, "loose unit, no packaging" is none. */
export function packagingFromProse(text: string | null | undefined): Packaging {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (/\b(no packaging|unpackaged|unboxed|bare|loose|out of (its|the) (box|packaging)|without (its |the )?(box|packaging))\b/.test(t)) return "none";
  if (/\b(sealed|shrink[- ]?wrapped|factory[- ]sealed|unopened)\b/.test(t)) return "sealed";
  if (/\b(opened|torn open|open box|box is open)\b/.test(t)) return "opened";
  if (/\b(boxed|in (its|the|a) (box|carton|packaging)|retail (box|packaging)|blister|clamshell|carton|packaged|packaging)\b/.test(t)) return "box";
  return "unknown";
}

/** The columns and metadata keys the rule reads. Structural, like
 *  ScanTriageRow: the API row and the web row both satisfy it. */
export interface ScanToolRow {
  status?: string | null;
  source_kind?: string | null;
  barcode_text?: string | null;
  image_file_id?: string | null;
  suggested_name?: string | null;
  ai_suggested_at?: string | Date | null;
  suggested_metadata?: unknown;
  suggested_candidates?: unknown;
}

/** What the rule knows beyond the row: the kinds this workspace declares as
 *  containers, and whether a box is open in the row's session (a bin made
 *  there), which makes the box tools worth a fold. */
export interface ScanToolContext {
  containerKinds?: ReadonlySet<string> | readonly string[];
  openBox?: boolean;
}

interface ToolMeta {
  category?: string | null;
  receipt_group_id?: string | null;
  photo_is_receipt?: string | null;
  photo_observations?: string | null;
  photo_observed_for?: string | null;
  photo_distinct?: number | null;
  photo_individuals?: unknown[] | null;
  split_from?: string | null;
  packaging?: string | null;
  identify_failure?: unknown;
  box_state?: string | null;
}

function metaOf(row: ScanToolRow): ToolMeta {
  return (row.suggested_metadata ?? {}) as ToolMeta;
}

function topKind(row: ScanToolRow): string | null {
  let list = row.suggested_candidates;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return null;
    }
  }
  const top = Array.isArray(list) ? (list[0] as { kind?: unknown } | undefined) : undefined;
  return top && typeof top.kind === "string" ? top.kind : null;
}

/** Does this scan look like a storage container, the kind of product a person
 *  would turn into a bin? Conservative, name and category vocabulary only: a
 *  false negative costs one trip to the fold, a false positive puts a "turn
 *  into a bin" offer on a book. Food is never a bin: "Apples Tote" is a bag
 *  of apples on a receipt (2026-09-06), and the category is the workspace's
 *  own word for what this is. */
export function looksLikeContainer(name: string | null | undefined, category: string | null | undefined): boolean {
  const hay = `${name ?? ""} ${category ?? ""}`.toLowerCase();
  if (!hay.trim()) return false;
  if (/\b(produce|bakery|meat|dairy|deli|seafood|beverages?|drinks?|grocer(y|ies)|food|snacks?|frozen|pantry)\b/.test((category ?? "").toLowerCase())) {
    return false;
  }
  return /\b(storage (box|bin|tote|container|drawer|cube|basket)|organizer|organiser|tote|crate|bin|baskets?|storage & organization)\b/.test(hay);
}

/** "2 pack", "pack of 3", "set of 4", "x2", "× 2", "3-pack", "twin pack". */
const PACK_PHRASE = /\b(\d+\s*[-\s]?pack|pack of \d+|set of \d+|\d+\s*(pk|pcs?|pieces?)|twin pack|multipack|bundle of \d+)\b|(\bx|×)\s?\d+\b/i;

/** The packaging a row's own pictures showed: the stored key first, then the
 *  prose of an observation recorded before the key existed. Null when the row
 *  has no picture that was looked at. */
export function packagingOf(row: ScanToolRow): Packaging | null {
  const m = metaOf(row);
  const stored = asPackaging(m.packaging);
  if (stored) return stored;
  if (!row.image_file_id) return null;
  // The observation must be about the picture the row has now.
  if (m.photo_observed_for && m.photo_observed_for !== row.image_file_id) return null;
  if (typeof m.photo_observations === "string" && m.photo_observations.trim()) return packagingFromProse(m.photo_observations);
  return null;
}

const hint = (relevance: ToolRelevance, reason: string): ToolHint => ({ relevance, reason });

export function scanToolRelevance(row: ScanToolRow, ctx: ScanToolContext = {}): ScanToolHints {
  const m = metaOf(row);
  const hasPicture = !!row.image_file_id;
  const hasBarcode = !!row.barcode_text;
  const named = !!row.suggested_name?.trim();
  const settled = !!row.ai_suggested_at;
  const receiptRow = row.source_kind === "receipt" || !!m.receipt_group_id;
  const isChild = !!m.split_from;
  const observed = !!m.photo_observed_for && m.photo_observed_for === row.image_file_id;
  const distinct = typeof m.photo_distinct === "number" ? m.photo_distinct : Array.isArray(m.photo_individuals) && m.photo_individuals.length >= 2 ? m.photo_individuals.length : null;

  // Read as a receipt: the picture reads as a document, not a thing.
  let receipt: ToolHint;
  if (receiptRow) receipt = hint("no", "this row is a line of a receipt already");
  else if (!hasPicture) receipt = hint("no", "no picture to read");
  else if (m.photo_is_receipt === "yes") receipt = hint("likely", "the picture reads as a receipt");
  else if (hasBarcode && named) receipt = hint("no", "a barcode-identified product");
  else if (named) receipt = hint("no", "identified as a thing, not a document");
  else if (settled) receipt = hint("possible", "a picture nothing could name");
  else receipt = hint("possible", "not read yet");

  // Split into items: more than one thing in the picture, or a pack in the name.
  let split: ToolHint;
  const packInName = named && PACK_PHRASE.test(row.suggested_name!);
  if (isChild) split = hint("no", "already split from a group photo");
  else if (distinct != null && distinct >= 2) split = hint("likely", `${distinct} different things in the picture`);
  else if (packInName) split = hint("likely", "the name says it is a pack");
  else if (!hasPicture) split = hint("no", hasBarcode ? "one product" : "no picture to split");
  else if (observed || distinct === 1) split = hint("no", "one unit seen");
  else if (hasBarcode && named) split = hint("no", "a barcode-identified product");
  else split = hint("possible", "the picture has not been counted yet");

  // Turn into a bin: the thing IS a container.
  let bin: ToolHint;
  const kind = topKind(row);
  const containerKinds = ctx.containerKinds ? new Set(ctx.containerKinds) : null;
  if (kind && containerKinds?.has(kind)) bin = hint("likely", "its table holds other things");
  else if (looksLikeContainer(row.suggested_name, m.category)) bin = hint("likely", "a container by name");
  else if (ctx.openBox) bin = hint("possible", "a bin is open in this session");
  else bin = hint("no", "not a container");

  // Empty box / Item in box: keyed on what was scanned.
  let box: ToolHint;
  const packaging = packagingOf(row);
  if (m.box_state) box = hint("likely", "a box state is set");
  else if (hasBarcode && !hasPicture) box = hint("likely", "the code was read off packaging");
  else if (hasPicture && packaging === "none") box = hint("no", hasBarcode ? "the code is a label on the product itself" : "a bare product, no packaging in frame");
  else if (hasPicture && (packaging === "box" || packaging === "sealed" || packaging === "opened")) box = hint("likely", packaging === "sealed" ? "sealed packaging in frame" : packaging === "opened" ? "opened packaging in frame" : "packaging in frame");
  else if (hasPicture) box = hint("possible", "the packaging is not clear from the picture");
  else if (ctx.openBox) box = hint("possible", "a bin is open in this session");
  else box = hint("possible", "no picture and no barcode to say");

  return { receipt, split, bin, box_state: box };
}

/** The tools a surface renders first, in the order they are listed. */
export function likelyTools(hints: ScanToolHints): ScanTool[] {
  return SCAN_TOOLS.filter((t) => hints[t].relevance === "likely");
}
