// The scan matchmaker. The scanner is GLOBAL to a workspace — one session can
// scan yarn, then groceries, then car parts — so there's no single target to
// pre-fill. This joins two open sets: the LEFT half (what the scanner saw) and
// the RIGHT half (the user's tables = enabled instances + their fields), and
// asks the model to (a) rank the best-fitting tables and (b) fill each table's
// fields from the item. The UI shows the top candidates as tap chips.
//
// Design + rationale: docs/BACKLOG.md "Scan matchmaker". The intelligence is
// declarative: a table's field defs (label/help/choices) ARE the extraction
// targets, and the instance's noun/name is the routing signal — so a new bundle
// becomes scannable just by shipping its fields, no scanner code changes.

import { platform, extractJsonObject, repairJson, parseJsonReply } from "@cobblr/platform-contract";

// A HANG GUARD, not a latency knob (the companion app scan lesson): the matchmaker
// runs detached server-side — nobody is blocked on it — and a queued
// claude-bridge call routinely takes 25-60s. At 20s every bridge call lost
// the race, returned [] and stamped matched_at with ZERO candidates (the
// completed call then populated the core-ai cache, which is why a manual
// re-run later looked fine). Be generous; the in-flight guard prevents pileups.
const MATCH_DEADLINE_MS = 120_000;
// Only take the JSON-recovery retry (a 2nd model call) when at least this much of
// the shared deadline is left — so a slow first call can't trigger a second that
// doubles total latency. On a fast provider the first call returns in seconds,
// leaving the whole budget; on the slow subscription bridge a slow first call
// burns it, and the retry is skipped (graceful fall-back to []).
const RETRY_MIN_MS = 30_000;

/** One field the model can extract a value for. */
interface MenuField {
  name: string;
  label: string;
  type: string;
  help?: string;
  choices?: string[];
}

/** One routable destination in the workspace (a table). */
export interface ScanMenuEntry {
  /** Owning module, e.g. "inventory" / "assets". */
  module: string;
  /** Instance slug when this is a named instance (yarn/hooks); null = the
   *  module's default table (generic inventory part / asset). */
  instance: string | null;
  /** Entity kind the fields live under (yarn:item / inventory:part). */
  kind: string;
  /** Human noun for prompts + chips ("yarn", "part", "asset"). */
  noun: string;
  /** Display label ("Yarn", "Inventory"). */
  label: string;
  fields: MenuField[];
  /** Domain terms a bundle declares for this table ("yarn","skein","ball-band")
   *  — an explicit routing hint that sharpens ambiguous matches (a bolt → "Parts
   *  Bin" vs "Car Parts"). Optional; routing still works off noun + fields. */
  scan_keywords?: string[];
  /** Capture-first: when this menu entry comes from a NOT-yet-installed flagship
   *  bundle (so the workspace can be matched against bundles it could become),
   *  the bundle to install on materialize. Absent for the user's live instances.
   *  This is the "link" — a capture knows which bundle would hold it. */
  bundle_external_id?: string;
}

/** What the scanner perceived (the left half). */
export interface PerceivedItem {
  name: string;
  manufacturer?: string | null;
  category?: string | null;
  description?: string | null;
  entityType?: "asset" | "part" | null;
  barcode?: string | null;
  sku?: string | null;
  /** The enrichment's provenance/reasoning notes — often carries product
   *  detail (specs read off the package) the bare name doesn't. */
  notes?: string | null;
  /** Where the user was standing when they scanned (a location name). */
  scanArea?: string | null;
  /** The full lookup metadata blob (weights, pack sizes, colours…) —
   *  raw extraction fodder for field-fill. */
  metadata?: Record<string, unknown> | null;
  /** Vision read of the user's OWN photo of the scanned item — what is
   *  physically present. Outranks listing-derived assumptions. */
  photoObservations?: string | null;
}

/** A ranked routing suggestion with field-fill. */
export interface MatchCandidate {
  module: string;
  instance: string | null;
  kind: string;
  /** Chip label, e.g. "Yarn" or "Inventory (part)". */
  label: string;
  /** 0..1 fit. */
  confidence: number;
  /** Suggested entity name for this routing. */
  name: string;
  /** Field values keyed by the table's field-def `name`. Only fields the model
   *  was confident about; everything else omitted. */
  fields: Record<string, string | number | boolean>;
  /** TOP candidate only: 2–4 terse sentences reconciling ALL the item data
   *  (title vs attributes vs barcode DB vs photo hints) — what matched, what
   *  was inferred, pack-size reasoning. No filler (companion app prompt style). */
  notes?: string;
  /** When the item data implies a count ("1 Pack Of 9 Skein", "10 Pack"),
   *  the unit quantity to pre-fill. Omitted when nothing implies one. */
  quantity?: number;
  /** Capture-first: copied from the chosen menu entry when this candidate routes
   *  to a not-yet-installed flagship bundle — the bundle to materialize. */
  bundle_external_id?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Assemble the workspace "scan menu" by reading the user's instances + each
 * instance's field defs over the internal API (same bearer the caller holds,
 * so isolation + role gating apply). Only domain modules that hold scannable
 * physical things are included (inventory / assets / machines).
 */
export async function assembleScanMenu(
  baseUrl: string,
  slug: string,
  token: string,
): Promise<ScanMenuEntry[]> {
  const auth = { Authorization: `Bearer ${token}` };
  const SCANNABLE = new Set(["inventory", "assets", "machines"]);
  // Default-instance entity kinds per module (named instances use <name>:item).
  const DEFAULT_KIND: Record<string, string> = {
    inventory: "inventory:part",
    assets: "assets:asset",
    machines: "machines:machine",
  };

  let instances: Array<{ module_name: string; instance_name: string; display_name: string; is_default: boolean; item_count?: number | null; config?: Record<string, unknown> }> = [];
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/instances`, { headers: auth });
    if (res.ok) instances = ((await res.json()) as { items?: typeof instances }).items ?? [];
  } catch {
    return [];
  }

  // Mirror the nav's rule (useNavModules.defaultModuleEntriesToHide): once a
  // module has NAMED instances, its auto-created EMPTY default is clutter the
  // user never sees — don't offer "Inventory (part)" as a scan target when
  // the workspace only ever uses "Yarn"/"Hooks". count null or >0 → keep
  // (never hide live data).
  const byModule = new Map<string, typeof instances>();
  for (const inst of instances) {
    const arr = byModule.get(inst.module_name) ?? [];
    arr.push(inst);
    byModule.set(inst.module_name, arr);
  }
  const hideDefaults = new Set<string>();
  for (const [moduleName, insts] of byModule) {
    const def = insts.find((i) => i.is_default);
    const hasNamed = insts.some((i) => !i.is_default);
    if (hasNamed && def && def.item_count === 0) hideDefaults.add(moduleName);
  }

  const overridesByTarget = new Map<string, { item_noun?: string; scan_keywords?: string[] }>();
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/entity-kind-overrides`, { headers: auth });
    if (res.ok) {
      const items = ((await res.json()) as { items?: Array<{ target_kind: string; target_id: string; config?: { item_noun?: string; scan_keywords?: string[] } }> }).items ?? [];
      for (const o of items) {
        if (o.target_kind === "instance" && o.config) overridesByTarget.set(o.target_id, o.config);
      }
    }
  } catch {
    /* overrides are best-effort — nouns fall back to the module's default. */
  }

  const entries: ScanMenuEntry[] = [];
  for (const inst of instances) {
    if (!SCANNABLE.has(inst.module_name)) continue;
    if (inst.is_default && hideDefaults.has(inst.module_name)) continue;
    const kind = inst.is_default
      ? DEFAULT_KIND[inst.module_name] ?? `${inst.module_name}:item`
      : `${inst.instance_name}:item`;
    const override = overridesByTarget.get(`${inst.module_name}:${inst.instance_name}`);
    const noun = override?.item_noun || (inst.module_name === "assets" ? "asset" : "part");
    const scanKeywords = Array.isArray(override?.scan_keywords)
      ? override!.scan_keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
      : undefined;

    let fields: MenuField[] = [];
    try {
      const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/field-defs?kind=${encodeURIComponent(kind)}`, { headers: auth });
      if (res.ok) {
        const defs = ((await res.json()) as { items?: Array<{ name: string; display_label: string; type: string; help?: string | null; choices?: string[] | null }> }).items ?? [];
        fields = defs
          .filter((d) => d.type !== "computed")
          .map((d) => ({
            name: d.name,
            label: d.display_label,
            type: d.type,
            ...(d.help ? { help: d.help } : {}),
            ...(d.choices && d.choices.length ? { choices: d.choices } : {}),
          }));
      }
    } catch {
      /* no fields → the table is still routable by its noun. */
    }

    entries.push({
      module: inst.module_name,
      instance: inst.is_default ? null : inst.instance_name,
      kind,
      noun,
      label: inst.display_name,
      fields,
      ...(scanKeywords && scanKeywords.length ? { scan_keywords: scanKeywords } : {}),
    });
  }
  return entries;
}

/**
 * Capture-first merged menu. Returns the user's LIVE instances when the
 * workspace has any — so established-workspace scan routing is byte-for-byte
 * unchanged. When the workspace has NO scannable instances yet (a blank,
 * just-signed-up workspace), it falls back to the FLAGSHIP BUNDLE menu
 * (GET /quickstart/bundle-menu) so a capture still routes + extracts fields
 * against the shapes the workspace could become — each entry tagged with the
 * bundle to install on materialize. The same declarative matchmaker handles
 * both: a not-yet-installed bundle is just a menu entry with field defs.
 */
export async function assembleMergedMenu(
  baseUrl: string,
  slug: string,
  token: string,
): Promise<ScanMenuEntry[]> {
  const live = await assembleScanMenu(baseUrl, slug, token);
  if (live.length > 0) return live;
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/quickstart/bundle-menu`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return live;
    const body = (await res.json()) as { items?: ScanMenuEntry[] };
    return Array.isArray(body.items) ? body.items : [];
  } catch {
    return live;
  }
}

// ── robust JSON parsing of the model reply ───────────────────────────────────
// Cheaper / smaller models (Haiku, local Ollama) garble strict JSON more often —
// trailing commas, truncated output, markdown fences, unescaped quotes in the
// notes prose. A single garble used to ZERO the whole scan (return []). The
// generic recovery (fences/prose/commas/smart-quotes/truncation) lives in
// @cobblr/platform-contract so every AI surface shares it; this wrapper adds the
// one matchmaker-specific salvage and the `candidates` shape check. Pure +
// unit-tested (matchmaker-json.test.ts).

/** Parse the model reply into the raw candidates array, recovering from common
 *  malformations. First the shared layered parse; then the matchmaker-specific
 *  notes-truncation salvage (an unescaped quote in the notes prose breaks the
 *  whole object, but the structured fields all precede `notes`, so dropping the
 *  notes value keeps routing + field extraction). null = nothing salvageable
 *  (the caller may then retry the model once). */
export function parseMatchmakerCandidates(content: string): unknown[] | null {
  const primary = parseJsonReply<{ candidates?: unknown }>(content);
  if (primary && Array.isArray(primary.candidates)) return primary.candidates;
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const cut = obj.search(/,\s*"notes"\s*:/);
  if (cut !== -1) {
    try {
      const p = JSON.parse(repairJson(obj.slice(0, cut))) as { candidates?: unknown };
      if (Array.isArray(p.candidates)) return p.candidates;
    } catch {
      /* nothing salvageable */
    }
  }
  return null;
}

/**
 * The join. Given what the scanner saw + the workspace's tables, return up to
 * three ranked candidates, each with the table's fields filled from the item.
 * Returns [] when there's no AI provider, the menu is empty, or the model fails
 * — the UI then falls back to today's generic part/asset behaviour.
 */
/** Strip a leading count + unit + "of" from a capture so the name reads clean:
 *  "3 skeins of blue worsted wool" → "Blue worsted wool". */
function cleanCaptureName(raw: string): string {
  const s = raw
    .replace(/^\s*\d+\s*(x|×)?\s*/i, "")
    .replace(/^(skeins?|balls?|spools?|rolls?|packs?|boxes?|bottles?|cans?|bags?|units?|pcs?|pieces?)\b\s*/i, "")
    .replace(/^of\s+/i, "")
    .trim();
  const cut = s.split(/[,.;\n]/)[0]?.trim() || s;
  return cut ? cut.charAt(0).toUpperCase() + cut.slice(1) : raw.slice(0, 80);
}

// ── physical-vs-record floor ─────────────────────────────────────────────────
// A scanned PHYSICAL product — it carries a retail barcode, or vision typed it as
// an asset/part — is never a subscription, warranty, bill, or document. Those are
// administrative RECORDS you create by hand, not by scanning a barcode. But the
// matchmaker (especially the keyword heuristic) would route a watch part into
// "Warranties" or a soldering tip into "Subscriptions" on an incidental hit. So
// when the item is unambiguously physical, drop record-nature tables from the
// menu BEFORE matching — a deterministic floor that holds even when the AI is
// down (the AI literally can't pick a table that isn't in its menu).
//
// Nature is derived from the table's OWN identity (noun/label) + its record-
// SPECIFIC fields — NOT a per-bundle keyword list (see the author's "derive from
// fields"). Record bundles are built on the inventory module, so they INHERIT
// physical fields (qty/serial) — field *presence* can't separate them; the
// record-specific fields they ADD (billing_cycle/renewal_date/document_number)
// and their noun do. Medications (dose/form/pharmacy — a scanned pill bottle)
// and Collections (condition/edition — scanned collectibles) carry none of these
// and stay physical, correctly.
const RECORD_NOUNS = [
  "subscription", "warranty", "document", "bill", "policy", "receipt",
  "membership", "renewal", "insurance", "contract", "invoice",
];
const RECORD_FIELDS = new Set([
  "billing_cycle", "renewal_date", "cost_per_cycle", "payment_method", "plan_summary",
  "policy_number", "premium", "coverage", "document_number", "doc_type", "issued_date",
  "expires_date", "issuer", "return_by", "purchased_from",
]);

/** True when this menu table holds administrative RECORDS (subscriptions /
 *  warranties / documents / bills), not physical goods. Noun/label match, or ≥2
 *  record-specific fields (one alone could be incidental). */
export function isRecordTable(entry: ScanMenuEntry): boolean {
  const id = `${entry.noun ?? ""} ${entry.label ?? ""}`.toLowerCase();
  if (RECORD_NOUNS.some((n) => id.includes(n))) return true;
  const hits = entry.fields.reduce((n, f) => n + (RECORD_FIELDS.has((f.name ?? "").toLowerCase()) ? 1 : 0), 0);
  return hits >= 2;
}

/** A scanned item is unambiguously a physical good when it carries a retail
 *  barcode or vision typed it as an asset/part. Unknown nature → not asserted. */
export function isPhysicalItem(item: PerceivedItem): boolean {
  return Boolean(item.barcode && item.barcode.trim()) || item.entityType === "asset" || item.entityType === "part";
}

/** Drop record-nature tables when the item is unambiguously physical. Conservative:
 *  a no-op when the item's nature is unclear, and never returns an empty menu (a
 *  degenerate all-record workspace falls back to the full menu rather than zero
 *  candidates). Idempotent — safe to apply at every matcher entry point. */
export function filterMenuForItem(item: PerceivedItem, menu: ScanMenuEntry[]): ScanMenuEntry[] {
  if (!isPhysicalItem(item)) return menu;
  const kept = menu.filter((e) => !isRecordTable(e));
  return kept.length > 0 ? kept : menu;
}

/**
 * The HEURISTIC floor — a deterministic, zero-cost matcher used when the AI
 * matchmaker is unavailable (no provider, not entitled, errored, or empty). It
 * scores each menu table by keyword overlap between the capture text and the
 * table's noun / scan_keywords / field names / field CHOICES, and extracts a
 * field value whenever a capture token equals one of a field's allowed choices
 * (the choices ARE the vocabulary — "worsted" → weight_class:Worsted). Weaker
 * than the model, but it means free / no-AI workspaces still get a real tracker
 * suggestion instead of a capture that never resolves. Connect AI to sharpen it.
 */
export function heuristicMatch(item: PerceivedItem, menuIn: ScanMenuEntry[]): MatchCandidate[] {
  const menu = filterMenuForItem(item, menuIn);
  if (menu.length === 0) return [];
  const hay = `${item.name ?? ""} ${item.description ?? ""} ${item.category ?? ""} ${item.notes ?? ""} ${
    item.metadata ? JSON.stringify(item.metadata) : ""
  }`.toLowerCase();
  const tokens = new Set(hay.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  const hasWord = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (p.length >= 3 && hay.includes(p)) return true;
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && tokens.has(w));
  };

  const scored = menu
    .map((entry) => {
      let score = 0;
      // `strong` = a real "this item IS that thing" signal: the table's NOUN
      // matched, or a field-CHOICE matched (a specific attribute like a yarn
      // weight). A match on only a secondary scan_keyword is weak and incidental
      // ("ribbon" in "Lcd Ribbon Cable" hitting Yarn's ribbon-yarn keyword) — so it
      // takes the noun, a choice, OR ≥2 corroborating keywords to suggest a table.
      let strong = false;
      let keywordHits = 0;
      const fields: Record<string, string | number | boolean> = {};
      // The table's OWN noun/keywords route it (a "yarn" table for a "...yarn"),
      // but they must NOT leak into field-value extraction — otherwise a vendor
      // choice "Local yarn shop" gets picked just because the capture says "yarn".
      const nounWords = new Set(
        [entry.noun, ...(entry.scan_keywords ?? [])]
          .flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/))
          .filter((w) => w.length >= 3),
      );
      if (entry.noun && hasWord(entry.noun)) {
        score += 2;
        strong = true;
      }
      for (const term of entry.scan_keywords ?? []) {
        if (term && hasWord(term)) {
          score += 2;
          keywordHits += 1;
        }
      }
      // A choice matches only on a NON-noun capture token (whole-phrase hits the
      // noun-word guard too: every matched word must be a non-noun word).
      const choiceHit = (ch: string): boolean => {
        const words = ch.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
        return words.some((w) => tokens.has(w) && !nounWords.has(w));
      };
      for (const f of entry.fields) {
        if (hasWord(f.name) || hasWord(f.label)) score += 1;
        if (f.choices) {
          for (const ch of f.choices) {
            if (ch && choiceHit(ch)) {
              score += 3;
              strong = true;
              if (!(f.name in fields)) fields[f.name] = ch; // extract the matched choice
            }
          }
        }
      }
      return { entry, score, fields, keep: strong || keywordHits >= 2 };
    })
    // Only confident routes: a noun/choice match or ≥2 keywords. A lone incidental
    // keyword no longer force-fits an item into the wrong bundle; when nothing
    // qualifies we return [] and the card falls to the generic "Inventory part".
    .filter((s) => s.keep)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (scored.length === 0) return [];
  const qm = hay.match(/(\d+)\s*(skein|ball|spool|roll|pack|box|bottle|can|bag|unit|pcs|piece|x|×)/);
  const quantity = qm ? Number(qm[1]) : undefined;
  const name = cleanCaptureName(item.name ?? "");

  return scored.map(({ entry, score, fields }, i) => ({
    module: entry.module,
    instance: entry.instance,
    kind: entry.kind,
    label: entry.label,
    confidence: Math.min(0.6, 0.3 + score * 0.04),
    name,
    fields,
    ...(Number.isInteger(quantity) && quantity! > 0 && quantity! <= 10_000 ? { quantity } : {}),
    ...(entry.bundle_external_id ? { bundle_external_id: entry.bundle_external_id } : {}),
    ...(i === 0
      ? { notes: "Matched by keywords (no AI). Connect an AI provider for sharper identification + field-fill." }
      : {}),
  }));
}

export async function runMatchmaker(
  orgId: string,
  item: PerceivedItem,
  menuIn: ScanMenuEntry[],
  /** The inbox item's UUID — links the AI-log row to the scan (source_id is a
   *  UUID column; passing the barcode/name here breaks the audit insert). */
  sourceId?: string,
): Promise<MatchCandidate[]> {
  // A physical scan never routes to a record table — drop them before the model
  // even sees the menu, so it can't suggest one (and the heuristic fallback below
  // inherits the already-filtered menu).
  const menu = filterMenuForItem(item, menuIn);
  if (menu.length === 0) return [];

  const system =
    "You sort a scanned physical item into the user's catalog of tables and " +
    "extract its fields. You are given the ITEM (what a scanner/vision read, " +
    "including lookup_metadata — the raw catalog/web data: attributes, " +
    "descriptions, pack info) and the user's TABLES (each: a module, an " +
    "optional instance slug, a noun, optional scan_keywords, and fields with " +
    "labels/help/allowed choices). Do three things:\n" +
    "1. Pick the best-fitting tables for this item, RANKED, at most 3. A table " +
    "fits when the item is the kind of thing that table holds (a skein of yarn " +
    "-> a 'yarn' table; a drill -> 'tools'/'assets'). Judge fit PRIMARILY from " +
    "the table's noun and its FIELDS — a field's label, help, and allowed " +
    "choices reveal what the table is for (a table with `fiber:[Wool,Cotton]` " +
    "and `weight:[Worsted,Aran]` is clearly for yarn; one with " +
    "`material:[PLA,PETG]` + `nozzle_temp` is for 3D-printer filament; one with " +
    "`VIN`/`mileage` is for vehicles). scan_keywords, when present, are an " +
    "EXTRA explicit hint — use them to BREAK TIES when two tables fit similarly, " +
    "not as the main signal (most tables won't have them, and route fine " +
    "without). But a specific table holds a specific KIND of thing — its fields " +
    "say which (a Components table of resistors/ICs/capacitors is for DISCRETE " +
    "parts, NOT a finished USB cable; a Filament-Types table is for spools, not " +
    "a 3D-printed widget). If the item is a finished or whole product that merely " +
    "RELATES to a table's domain rather than being the kind it holds, route it to " +
    "the generic default table (instance null) — and do NOT invent a field value " +
    "to justify forcing it into a specific table (a fabricated field is worse " +
    "than the honest generic table). If nothing fits well, " +
    "return the generic default table (instance null) for the closest module.\n" +
    "2. For EACH picked table, fill in field values — MINE EVERY ITEM FIELD: " +
    "the title, lookup_metadata attributes (material/color/size), the " +
    "description, lookup_notes. Map them onto the table's field names (e.g. " +
    "attribute 'color: Country Blue' -> a 'colorway' field; 'material: " +
    "Acrylic' -> a 'fibre' field; 'Worsted' in a yarn title -> a weight " +
    "field). For a field with `choices`, use the closest listed choice or " +
    "omit. When a field's label/help asks for a hex or colour swatch, " +
    "output a CSS hex code for the named colour (e.g. '#6F8FAF' for " +
    "Country Blue), not a word. If lookup_metadata.user_hint is present it " +
    "is the user's own correction — treat it as authoritative over every " +
    "other source. Omit only what nothing in the data supports; never invent. Strip " +
    "retailer noise from `name` ('Amazon.com:', '1 Pack Of 9 Skein' suffixes " +
    "-> a clean product name).\n" +
    "3. On the FIRST candidate only, add `notes`: 2-4 smooth, natural " +
    "sentences reconciling the data — what the barcode DB, attributes, and " +
    "title each contributed, what you inferred, and anything that disagrees " +
    "or is missing. Pleasant, complete prose (not telegraphic fragments), " +
    "but every sentence must carry information — no filler, praise, or " +
    "hedging boilerplate. Be careful with counts: a 'Pack of N' in a " +
    "retailer-style TITLE describes that retailer's LISTING, not " +
    "necessarily the scanned unit — unit barcodes appear on multipack " +
    "listings constantly. Set `quantity` (integer) only when " +
    "packaging-level data confirms it (an explicit pack/size attribute, " +
    "'QTY N' on the label, the description); otherwise leave quantity " +
    "unset and mention the listing count in notes as unconfirmed. " +
    "photo_observations (when present) describe the user's OWN photo of " +
    "the physical item at scan time — for quantity, packaging state, and " +
    "identity disagreements they OUTRANK every listing-derived source. " +
    "Always strip pack suffixes from `name` regardless.\n\n" +
    'Reply with ONLY JSON: {"candidates":[{"module":<string>,"instance":<string|null>,' +
    '"confidence":<0..1>,"name":<string>,"fields":{<field_name>:<value>},' +
    '"notes":<string, first candidate only>,"quantity":<int, optional>}]}. ' +
    "Inside string values NEVER use the double-quote character — quote words " +
    "with single quotes ('medium weight') — or the JSON will not parse. " +
    "Order candidates best-first. confidence is how well the table fits the item.";

  const compactMenu = menu.map((m) => ({
    module: m.module,
    instance: m.instance,
    noun: m.noun,
    label: m.label,
    ...(m.scan_keywords && m.scan_keywords.length ? { scan_keywords: m.scan_keywords } : {}),
    fields: m.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      ...(f.help ? { help: f.help } : {}),
      ...(f.choices ? { choices: f.choices } : {}),
    })),
  }));

  const user =
    "ITEM:\n" +
    JSON.stringify(
      {
        name: item.name,
        brand: item.manufacturer ?? null,
        category: item.category ?? null,
        description: item.description ?? null,
        kind_hint: item.entityType ?? null,
        barcode: item.barcode ?? null,
        sku: item.sku ?? null,
        lookup_notes: item.notes ?? null,
        scanned_in_area: item.scanArea ?? null,
        // Everything the catalog/web lookup returned — mine it for field
        // values (weights, lengths, colours, counts) before giving up on
        // a field. Keys are the lookup's, not the table's.
        lookup_metadata: item.metadata ?? null,
        photo_observations: item.photoObservations ?? null,
      },
      null,
      0,
    ) +
    "\n\nTABLES:\n" +
    JSON.stringify(compactMenu, null, 0);

  // One model call → robust-parse, both calls SHARING a single MATCH_DEADLINE_MS
  // budget. bypass_cache lets the retry take a fresh sample (the cache key is the
  // messages, not the model, so a plain re-invoke returns the same garbled reply).
  const t0 = Date.now();
  const remaining = () => MATCH_DEADLINE_MS - (Date.now() - t0);
  const callOnce = async (bypassCache: boolean, budgetMs: number): Promise<unknown[] | null> => {
    if (budgetMs <= 0) return null;
    const call = platform()
      .ai.invoke({
        orgId,
        capability: "chat",
        input: { messages: [{ role: "system", content: system }, { role: "user", content: user }] },
        source: { kind: "core-scan:matchmaker", id: sourceId ?? "" },
        bypass_cache: bypassCache,
      })
      .then((r) => r.result as { content?: string })
      .catch(() => null);
    const res = await Promise.race([
      call,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
    return res?.content ? parseMatchmakerCandidates(res.content) : null;
  };

  // First shot; if the reply was wholly unparseable (a cheaper model garbling
  // JSON), take ONE fresh retry — a second sample almost always parses, which is
  // what makes a cheap model (Haiku / local Ollama) viable. BUT both calls share
  // the ONE deadline and we only retry when a meaningful slice is left
  // (RETRY_MIN_MS), so a slow first call (e.g. via the subscription bridge) can't
  // trigger a second that doubles latency + times out a synchronous caller; on a
  // fast provider the retry has ample budget and fires.
  let rawList = await callOnce(false, MATCH_DEADLINE_MS);
  if (rawList === null && remaining() > RETRY_MIN_MS) rawList = await callOnce(true, remaining());
  // AI unavailable (no provider / not entitled / errored / timed out) → fall back
  // to the deterministic heuristic so capture-first still suggests a tracker for
  // free / no-AI workspaces. The whole point: capture-first never goes dark.
  if (rawList === null) return heuristicMatch(item, menu);

  // Validate each candidate against the menu — the model may only route to a
  // table we actually offered, and we resolve module/kind/label from the menu
  // (never trust the model for the entity kind we'll write to).
  const byKey = new Map(menu.map((m) => [`${m.module}::${m.instance ?? ""}`, m] as const));
  const out: MatchCandidate[] = [];
  for (const c of rawList) {
    if (!c || typeof c !== "object") continue;
    const cand = c as Record<string, unknown>;
    const module = typeof cand.module === "string" ? cand.module : "";
    const instance = typeof cand.instance === "string" && cand.instance ? cand.instance : null;
    const entry = byKey.get(`${module}::${instance ?? ""}`);
    if (!entry) continue;
    // Keep only fields that exist on the table, coerced to a primitive.
    const allowed = new Set(entry.fields.map((f) => f.name));
    const fields: Record<string, string | number | boolean> = {};
    if (cand.fields && typeof cand.fields === "object") {
      for (const [k, v] of Object.entries(cand.fields as Record<string, unknown>)) {
        if (!allowed.has(k)) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = v;
      }
    }
    const qty = Number(cand.quantity);
    out.push({
      module: entry.module,
      instance: entry.instance,
      kind: entry.kind,
      label: entry.label,
      confidence: clamp01(typeof cand.confidence === "number" ? cand.confidence : 0.5),
      name: typeof cand.name === "string" && cand.name.trim() ? cand.name.trim() : item.name,
      fields,
      ...(typeof cand.notes === "string" && cand.notes.trim()
        ? { notes: cand.notes.trim().slice(0, 2000) }
        : {}),
      ...(Number.isInteger(qty) && qty > 0 && qty <= 10_000 ? { quantity: qty } : {}),
      // Carry the bundle pointer through from the chosen menu entry so a
      // capture against a not-yet-installed bundle remembers what to install.
      ...(entry.bundle_external_id ? { bundle_external_id: entry.bundle_external_id } : {}),
    });
    if (out.length >= 3) break;
  }
  // AI returned nothing usable for this menu → heuristic floor, never blank.
  return out.length > 0 ? out : heuristicMatch(item, menu);
}
