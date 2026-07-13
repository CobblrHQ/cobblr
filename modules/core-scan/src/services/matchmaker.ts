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

// A HANG GUARD, not a latency knob: the matchmaker
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
  /** Semantic DECODE role (P3), e.g. `decode:year` — lets a scanned-identifier
   *  decode fill this field by declared role, not English name. Not sent to the
   *  model (routing/extraction is unaffected); consumed by the decode-fill pass. */
  decode_role?: string;
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
   *  was inferred, pack-size reasoning. No filler. */
  notes?: string;
  /** When the item data implies a count ("1 Pack Of 9 Skein", "10 Pack"),
   *  the unit quantity to pre-fill. Omitted when nothing implies one. */
  quantity?: number;
  /** Field names in `fields` that were COMPLETED from the model's own knowledge
   *  of a confidently-identified entity (a known book's ISBN/publisher/year),
   *  NOT read off the photo/catalog data. Provenance so a wrong guess stays
   *  visible; only set on a high-confidence match to a specific known work. */
  inferred?: string[];
  /** Capture-first: copied from the chosen menu entry when this candidate routes
   *  to a not-yet-installed flagship bundle — the bundle to materialize. */
  bundle_external_id?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Sanitize the model's `inferred` list (fields it backfilled from knowledge of a
 *  known entity) against the fields it actually filled: keep only string names
 *  that exist in `filled`, de-duped. A name the model lists but never filled (or a
 *  field not on the table) is dropped, so the provenance marker can never point at
 *  an absent value. Non-array input → []. Pure; unit-tested. */
export function normalizeInferred(rawInferred: unknown, filled: Record<string, unknown>): string[] {
  if (!Array.isArray(rawInferred)) return [];
  return [...new Set(rawInferred.filter((n): n is string => typeof n === "string" && Object.hasOwn(filled, n)))];
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
  // Scan targets are DECLARED by the owning modules (registerScannable), not
  // hardcoded here — a new scannable module needs no matchmaker edit. Map each
  // module to its default kind + noun. (Audit 2026-06-26 follow-up.)
  const scanByModule = new Map<string, { kind: string; noun: string }>();
  for (const s of platform().entities.listScannable()) {
    scanByModule.set(s.kind.split(":")[0]!, { kind: s.kind, noun: s.noun });
  }

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
    const scanInfo = scanByModule.get(inst.module_name);
    if (!scanInfo) continue;
    if (inst.is_default && hideDefaults.has(inst.module_name)) continue;
    const kind = inst.is_default ? scanInfo.kind : `${inst.instance_name}:item`;
    const override = overridesByTarget.get(`${inst.module_name}:${inst.instance_name}`);
    const noun = override?.item_noun || scanInfo.noun;
    const scanKeywords = Array.isArray(override?.scan_keywords)
      ? override!.scan_keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
      : undefined;

    let fields: MenuField[] = [];
    try {
      const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/field-defs?kind=${encodeURIComponent(kind)}`, { headers: auth });
      if (res.ok) {
        const defs = ((await res.json()) as { items?: Array<{ name: string; display_label: string; type: string; help?: string | null; choices?: string[] | null; decode_role?: string | null }> }).items ?? [];
        fields = defs
          .filter((d) => d.type !== "computed")
          .map((d) => ({
            name: d.name,
            label: d.display_label,
            type: d.type,
            ...(d.help ? { help: d.help } : {}),
            ...(d.choices && d.choices.length ? { choices: d.choices } : {}),
            ...(d.decode_role ? { decode_role: d.decode_role } : {}),
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
  // MERGE live tables with the not-yet-installed bundle menu — never shadow.
  // The old `if (live.length) return live` meant ONE item filed into generic
  // Inventory collapsed the whole suggestion engine: every later capture could
  // only route to "Inventory part", and yarn/plants/subscriptions were never
  // suggested again. Live tables come first (the model + heuristic both bias
  // toward earlier entries); bundle entries whose instance already exists live
  // are dropped as duplicates.
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/quickstart/bundle-menu`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return live;
    const body = (await res.json()) as { items?: ScanMenuEntry[] };
    const bundle = Array.isArray(body.items) ? body.items : [];
    const liveKeys = new Set(live.map((e) => `${e.module}::${e.instance ?? ""}`));
    // Drop a bundle entry that duplicates a live table by KEY *or* by display
    // LABEL. If the workspace already has a "Bookshelf" (say `assets::bookshelf`),
    // don't ALSO offer to install a community "Bookshelf" bundle
    // (`inventory::cobblr-community-bookshelf`) — that surfaced as two chips the
    // user can't tell apart, and confirming the phantom would spin up a duplicate
    // same-named table. You already have one by that name; file into it.
    const liveLabels = new Set(live.map((e) => e.label.trim().toLowerCase()).filter(Boolean));
    return [
      ...live,
      ...bundle.filter(
        (e) =>
          !liveKeys.has(`${e.module}::${e.instance ?? ""}`) && !liveLabels.has(e.label.trim().toLowerCase()),
      ),
    ];
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
    // leading article first — "A spool of black PLA" must still strip to
    // "Black PLA" (the article used to defeat the unit strip entirely)
    .replace(/^\s*(a|an|the)\s+/i, "")
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
  }`
    .toLowerCase()
    // "a BAG of screws" / "3 BOXES of nails": the container word describes the
    // packaging, not the item — drop it so it can't hit an unrelated table's
    // choice vocabulary ("bag" is a Wardrobe accessory choice; screws aren't).
    .replace(/\b(\d+\s*)?(skeins?|balls?|spools?|rolls?|packs?|boxe?s?|bottles?|cans?|bags?|tubes?|jars?|cases?)\s+of\s+/g, "");
  // Light stemming so plural/singular pairs match ("Netflix subscription" hits
  // a "subscriptions" table; "screws" hits a "screw" choice): compare tokens by
  // their stem — trailing -ies→y, -es, -s stripped (conservative; ≥4 chars so
  // "gas"/"its" survive).
  const stem = (w: string): string => {
    if (w.length >= 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length >= 5 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length >= 4 && w.endsWith("s")) return w.slice(0, -1);
    return w;
  };
  const tokens = new Set(hay.split(/[^a-z0-9]+/).filter((t) => t.length >= 3).map(stem));
  const hasWord = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (p.length >= 3 && hay.includes(p)) return true;
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && tokens.has(stem(w)));
  };
  // The capture's HEAD NOUN — the last content token of the NAME after
  // stripping trailing size/pack tails ("Fieldcrest Bath Towels 4 Pack" →
  // "towel"). A keyword matching the head noun is what the item IS, not an
  // incidental word ("Lcd Ribbon Cable" heads "cable", so Yarn's "ribbon"
  // keyword stays weak — the original false-positive guard holds).
  const TAIL = new Set(["pack", "packs", "count", "ct", "pcs", "pc", "set", "sets", "oz", "ml", "lb", "lbs", "kg", "inch", "in", "ft", "each", "roll", "rolls"]);
  const nameTokens = (item.name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  // Pop size/pack TAIL tokens and anything digit-bearing ("20lb", "4pk") —
  // the head noun is the thing itself, never its packaging arithmetic.
  while (nameTokens.length > 1 && (TAIL.has(nameTokens[nameTokens.length - 1]!) || /\d/.test(nameTokens[nameTokens.length - 1]!))) nameTokens.pop();
  const headStem = nameTokens.length ? stem(nameTokens[nameTokens.length - 1]!) : "";
  const hitsHead = (phrase: string): boolean =>
    !!headStem && phrase.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && stem(w) === headStem);

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
          .filter((w) => w.length >= 3)
          .map(stem),
      );
      if (entry.noun && hasWord(entry.noun)) {
        score += 2;
        strong = true;
      }
      // Multi-word keywords match as FULL PHRASES only — "paper towel" must
      // not claim every "towel" via its words (bath towels are linens, not
      // supplies). Single words keep stemmed token matching.
      const kwHit = (term: string): boolean =>
        /\s/.test(term.trim()) ? hay.includes(term.toLowerCase()) : hasWord(term);
      for (const term of entry.scan_keywords ?? []) {
        if (term && kwHit(term)) {
          score += 2;
          keywordHits += 1;
          // A keyword that IS the capture's head noun ("…Bath Towels" →
          // keyword "towel") identifies the thing itself → strong on its own.
          if (hitsHead(term)) strong = true;
        }
      }
      // A choice matches only on a NON-noun capture token (whole-phrase hits the
      // noun-word guard too: every matched word must be a non-noun word).
      const choiceHit = (ch: string): boolean => {
        const words = ch.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem);
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
  /** The scanning user (null for a cron/background match) — routes to their
   *  personal AI connection. */
  userId?: string | null,
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
    "1. Pick the tables for this item, RANKED best-first: the ONE best-fitting " +
    "table (the primary) and AT MOST ONE secondary. Include a secondary ONLY " +
    "when the item genuinely belongs in two DIFFERENT tables (e.g. a graded " +
    "collectible that is both a 'Bookshelf' reading copy AND a 'Collections' " +
    "graded item) — most items have just ONE home, so usually return a single " +
    "table. NEVER list the same table (same module+instance) twice, and never " +
    "pad the list with a marginal or duplicate table to fill a slot: one " +
    "confident table beats two noisy ones, and identical items must route the " +
    "same way. A table " +
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
    "other source. Omit only what nothing in the data supports; never invent. " +
    "COMPLETE A KNOWN ENTITY (backfill): the 'never invent' rule bends ONLY when " +
    "your top candidate is a HIGH-confidence (>=0.8) match to a SPECIFIC, " +
    "identifiable real-world entity you recognize with certainty — a named book, " +
    "film, album, or game by its title + creator, or a product by make + model. " +
    "For that exact known entity you MAY fill additional declared fields you " +
    "reliably KNOW (e.g. a book's isbn, publisher, publication year, page count) " +
    "even when the photo does not show them, and you MUST list every field you " +
    "filled this way (from your own knowledge, not the item data) in `inferred`. " +
    "This is completing a known fact, not inventing: it applies ONLY to a " +
    "confident, specific identity. For a generic, ambiguous, or uncertain item " +
    "keep omitting, and NEVER fabricate a plausible-looking value — a made-up " +
    "isbn is worse than a blank. Strip " +
    "retailer noise from `name` ('Amazon.com:', '1 Pack Of 9 Skein' suffixes " +
    "-> a clean product name).\n" +
    "3. On the FIRST candidate, add `notes` ONLY when something genuinely " +
    "needed reconciling or inferring — a disagreement between the title, " +
    "attributes, and/or photo_observations; a field you inferred rather than " +
    "read; or an unconfirmed pack/count. Then write ONE short, natural " +
    "sentence, information-only (no filler, praise, or hedging). For a clean, " +
    "unambiguous match where nothing needed reconciling, OMIT `notes` entirely " +
    "— do not narrate an obvious agreement. Be careful with counts: a 'Pack of N' in a " +
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
    '"inferred":[<field_name>,...] (top candidate only; the fields you filled from KNOWLEDGE of a confident known entity, not the item data; omit when none),' +
    '"notes":<string, first candidate ONLY when reconciling is needed; else omit>,"quantity":<int, optional>}]}. ' +
    "Inside string values NEVER use the double-quote character — quote words " +
    "with single quotes ('medium weight') — or the JSON will not parse. " +
    "Order candidates best-first. confidence is how well the table fits the item.";

  // Prompt-size guard for the skins-at-scale era: the heuristic scales
  // linearly with menu size, but the MODEL prompt does not — with 100s of
  // installable skins in the catalog the full menu would blow the context (and
  // the model's attention). Keep every LIVE table (the user's real data always
  // routes) and only the most lexically-plausible bundle entries.
  const MENU_PROMPT_CAP = 40;
  let promptMenu = menu;
  if (menu.length > MENU_PROMPT_CAP) {
    const live = menu.filter((e) => !e.bundle_external_id);
    const bundle = menu.filter((e) => e.bundle_external_id);
    const hay = `${item.name ?? ""} ${item.description ?? ""} ${item.category ?? ""} ${
      item.metadata ? JSON.stringify(item.metadata) : ""
    }`.toLowerCase();
    const lexScore = (e: ScanMenuEntry): number => {
      let s = 0;
      const probe = (t: string | undefined, w: number) => {
        for (const word of (t ?? "").toLowerCase().split(/[^a-z0-9]+/))
          if (word.length >= 3 && hay.includes(word)) s += w;
      };
      probe(e.noun, 3);
      probe(e.label, 2);
      for (const k of e.scan_keywords ?? []) probe(k, 2);
      for (const f of e.fields) for (const c of f.choices ?? []) probe(c, 1);
      return s;
    };
    promptMenu = [
      ...live,
      ...bundle
        .map((e) => ({ e, s: lexScore(e) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.max(8, MENU_PROMPT_CAP - live.length))
        .map((x) => x.e),
    ];
  }

  const compactMenu = promptMenu.map((m) => ({
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
        userId: userId ?? undefined,
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
  // Dedupe by target table: the model sometimes emits the SAME menu entry twice
  // (e.g. Bookshelf with 4 fields AND Bookshelf with 2), which surfaced as two
  // identical chips. Keep the richer fill per module::instance so each table
  // appears once and the top-3 slots go to genuinely different tables.
  const emitted = new Map<string, number>();
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
    // Backfill provenance: field names the model filled from its KNOWLEDGE of a
    // confident known entity, sanitized against what it actually filled.
    const inferred = normalizeInferred(cand.inferred, fields);
    // Surface the provenance in the notes line (where the user already looks), so
    // a value filled from knowledge rather than the photo is flagged for a glance.
    const baseNotes = typeof cand.notes === "string" && cand.notes.trim() ? cand.notes.trim().slice(0, 1800) : "";
    const inferredNote = inferred.length ? `Filled from catalog knowledge (double-check): ${inferred.join(", ")}.` : "";
    const notes = [baseNotes, inferredNote].filter(Boolean).join(" ");
    const candidate: MatchCandidate = {
      module: entry.module,
      instance: entry.instance,
      kind: entry.kind,
      label: entry.label,
      confidence: clamp01(typeof cand.confidence === "number" ? cand.confidence : 0.5),
      name: typeof cand.name === "string" && cand.name.trim() ? cand.name.trim() : item.name,
      fields,
      ...(inferred.length ? { inferred } : {}),
      ...(notes ? { notes } : {}),
      ...(Number.isInteger(qty) && qty > 0 && qty <= 10_000 ? { quantity: qty } : {}),
      // Carry the bundle pointer through from the chosen menu entry so a
      // capture against a not-yet-installed bundle remembers what to install.
      ...(entry.bundle_external_id ? { bundle_external_id: entry.bundle_external_id } : {}),
    };
    const dedupeKey = `${entry.module}::${entry.instance ?? ""}`;
    const prevIdx = emitted.get(dedupeKey);
    if (prevIdx != null) {
      // Same table already proposed — keep whichever filled more fields.
      if (Object.keys(candidate.fields).length > Object.keys(out[prevIdx]!.fields).length) out[prevIdx] = candidate;
      continue;
    }
    emitted.set(dedupeKey, out.length);
    out.push(candidate);
    // Primary + at most ONE secondary (matches the tightened prompt + the
    // heuristic's cap): a third table was almost always noise/padding.
    if (out.length >= 2) break;
  }
  // AI returned nothing usable for this menu → heuristic floor, never blank.
  return out.length > 0 ? out : heuristicMatch(item, menu);
}

// ── session/series routing reconciliation (deterministic, no model) ──────────
/** Align the SECONDARY routing across a group of same-series items so they route
 *  IDENTICALLY — "the whole shelf offers a given secondary table, or none of it
 *  does" — instead of the model's per-item coin-flip (some Little House books
 *  getting a stray 'Collections', others not).
 *
 *  Rule: keep a secondary table only if it appears (with ≥1 filled field) on
 *  EVERY item in the group — the INTERSECTION. This guarantees uniformity and
 *  never FABRICATES an empty chip (we only ever drop, never invent a secondary an
 *  item has no data for). Each item's PRIMARY (candidates[0]) is never touched —
 *  routing identity stays the model's call; only the noisy tail is normalised.
 *
 *  Pure + deterministic (unit-tested). Returns, per item id, the reconciled
 *  candidate list — ONLY for items that actually change (so the caller writes
 *  the minimum). Candidates are first deduped by table (keep the richer fill),
 *  mirroring the render, so a legacy row with a duplicate table reconciles too. */
export function reconcileSeriesSecondaries(
  group: Array<{ id: string; candidates: MatchCandidate[] }>,
): Map<string, MatchCandidate[]> {
  const out = new Map<string, MatchCandidate[]>();
  if (group.length < 2) return out;
  const tableKey = (c: MatchCandidate) => `${c.module}::${c.instance ?? ""}`;
  const nFields = (c: MatchCandidate) => Object.keys(c.fields ?? {}).length;

  // Dedupe each item's candidates by table (keep richer), preserving order.
  const dedupe = (cands: MatchCandidate[]): MatchCandidate[] => {
    const byKey = new Map<string, MatchCandidate>();
    for (const c of cands) {
      const k = tableKey(c);
      const prev = byKey.get(k);
      if (!prev || nFields(c) > nFields(prev)) byKey.set(k, c);
    }
    return [...byKey.values()];
  };
  const cleaned = group.map((g) => ({ id: g.id, cands: dedupe(g.candidates) }));

  // Secondary tables present WITH fields on each item, then their intersection.
  const secSets: Array<Set<string>> = cleaned.map(
    (g) => new Set(g.cands.slice(1).filter((c) => nFields(c) > 0).map(tableKey)),
  );
  const keepSec = secSets.reduce<Set<string>>(
    (acc, s) => new Set([...acc].filter((k) => s.has(k))),
    new Set<string>(secSets[0] ?? []),
  );

  for (const g of cleaned) {
    const primary = g.cands[0];
    if (!primary) continue;
    const next = [primary, ...g.cands.slice(1).filter((c) => keepSec.has(tableKey(c)))];
    const orig = group.find((x) => x.id === g.id)!.candidates;
    const unchanged =
      next.length === orig.length && next.every((c, i) => tableKey(c) === tableKey(orig[i]!));
    if (!unchanged) out.set(g.id, next);
  }
  return out;
}
