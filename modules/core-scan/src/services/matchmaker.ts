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
import { routingNoteBare, routingNoteWithCategory } from "./routing-note.js";
import { normaliseCategory, isJunkCategory } from "@cobblr/platform-contract/category-reconcile";

// A HANG GUARD, not a latency knob: the matchmaker
// runs detached server-side — nobody is blocked on it — and a queued
// claude-bridge call routinely takes 25-60s. At 20s every bridge call lost
// the race, returned [] and stamped matched_at with ZERO candidates (the
// completed call then populated the core-ai cache, which is why a manual
// re-run later looked fine). Be generous; the in-flight guard prevents pileups.
const MATCH_DEADLINE_MS = 120_000;
// Only take the JSON-recovery retry (a 2nd model call) when at least this much off
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
  /** This table's GROUPING AXIS: the field declaring `field_role: "category"`,
   *  plus the values it already holds. It is what lets the model say "this is an
   *  ELECTRICAL part" without reaching for a different TABLE to say it. Absent
   *  when the table declares no category field. */
  category_field?: { name: string; label: string; values: string[] };
  /** This table's PACK-COUNT field: the field declaring `field_role: "pack"` —
   *  how many base units are in the scanned package. Filled DETERMINISTICALLY
   *  from the observed pack (metadata.pack_size), never a "usual buy" guess.
   *  Absent when the table declares no pack field. */
  pack_field?: { name: string; label: string };
  /** The workspace's designated catch-all for this module: where an item that
   *  matches no table in particular lands, to then be told apart by its category.
   *  At most one entry per module carries this. */
  is_fallback?: boolean;
  /** This kind is tracked ONE BY ONE (its declared traits include `unique` — a
   *  vehicle, a machine). Drives combine semantics: two captures of the same
   *  unique thing merge details without summing quantity. */
  unique?: boolean;
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
  /** The value for this table's `category_field` — what KIND of thing this is,
   *  WITHIN the table. Either one of the values already in use, or a NEW one the
   *  model proposed because none fit (`category_is_new`). Nothing is created
   *  until the user confirms. This is the axis that stops a difference in kind
   *  from being expressed as a different TABLE. */
  category?: string;
  /** True when `category` is not yet one of the table's existing values — the UI
   *  says "new" on the chip, and confirming adds it to the field's choices. */
  category_is_new?: boolean;
  /** Field names in `fields` that were COMPLETED from the model's own knowledge
   *  of a confidently-identified entity (a known book's ISBN/publisher/year),
   *  NOT read off the photo/catalog data. Provenance so a wrong guess stays
   *  visible; only set on a high-confidence match to a specific known work. */
  inferred?: string[];
  /** Capture-first: copied from the chosen menu entry when this candidate routes
   *  to a not-yet-installed flagship bundle — the bundle to materialize. */
  bundle_external_id?: string;
  /** Set on candidates produced WITHOUT a model call (the keyword floor), so the
   *  UI can say so — a lexical guess must not wear an AI match's face. */
  heuristic?: true;
  /** How a heuristic candidate earned its route: "noun" = real what-the-item-IS
   *  evidence (table noun / head-noun / phrase-in-name), "keywords" = only
   *  corroborating keyword hits (weaker — rendered tentative and excluded from
   *  one-tap Add + File all), "fallback" = the honest catch-all + category. */
  basis?: "noun" | "keywords" | "fallback";
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
 * Which of a module's instances is the scan CATCH-ALL — where an item matching no
 * table in particular lands, to be told apart by its category.
 *
 * The user's explicit pick (`is_scan_fallback`) wins; absent one, the module's
 * DEFAULT instance — **even when it's an empty auto-default that named instances
 * have otherwise hidden**. That last clause is the fix: a workspace with named
 * instances and a hidden default used to get NO fallback, so its unmatched items
 * scattered across the named tables. The default + a category IS the
 * consolidation, and it un-hides the moment anything lands in it.
 */
export function chooseFallbackInstance(
  insts: Array<{ instance_name: string; is_default: boolean; is_scan_fallback?: boolean }>,
): string | null {
  return (
    insts.find((i) => i.is_scan_fallback)?.instance_name ??
    insts.find((i) => i.is_default)?.instance_name ??
    null
  );
}

/**
 * Assemble the workspace "scan menu" by reading the user's instances + each
 * instance's field defs over the internal API (same bearer the caller holds,
 * so isolation + role gating apply). Only domain modules that hold scannable
 * physical things are included (inventory / assets / machines).
 */
/**
 * Pull the proposed categories out of sibling inbox rows.
 *
 * Separate from the query that fetches them so the part that can actually be
 * WRONG is testable without a database. Two ways it silently returns nothing,
 * both of which look like "the feature does nothing" rather than an error:
 *
 *   the value is written into `fields` by resolveCategoryInto and only mirrored
 *   onto the candidate when the axis is declared, so reading one place finds
 *   half of them;
 *
 *   jsonb arrives parsed under `pg`, but a JSON.stringify'd write read straight
 *   back can arrive as a string.
 *
 * Fixture-backed: the shapes here are lifted from real recorded rows.
 */
export function categoriesFromCandidateRows(rows: Array<{ suggested_candidates?: unknown }>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    let list = row?.suggested_candidates as unknown;
    if (typeof list === "string") {
      try {
        list = JSON.parse(list);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const cand = c as { category?: unknown; fields?: { category?: unknown } } | null;
      if (!cand) continue;
      const v = typeof cand.category === "string" ? cand.category : cand.fields?.category;
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

/** How many sibling proposals to carry. The list rides in every prompt, so it
 *  is bounded; a batch that has genuinely produced more distinct categories than
 *  this has a grain problem the prompt is meant to solve, not a memory problem. */
const MAX_CARRIED_CATEGORIES = 40;

/**
 * Let a scan see what its own batch has already proposed.
 *
 * Every item is matched INDEPENDENTLY, and a proposed category is not stored
 * until the user confirms — so during a bulk scan `category_field.values` is
 * empty for all of them, and the prompt's "use one of the values already in use,
 * reuse beats invention" has nothing to reuse. Sixty items, sixty inventions.
 *
 * Measured on 40 recorded items with an empty axis, five monitors scanned
 * together came back as three different categories:
 *
 *   Lenovo Monitor → Electronics    Dell E2220H → Monitors
 *   Dell U2417H    → Electronics    Samsung F27T → Monitors    ASUS VG245 → Electronics
 *
 * Every one of those is at the right GRAIN — that half is the prompt's job and
 * it is doing it. They just disagree, because no two of them could see each
 * other. Normalising cannot repair it either: "Monitors" and "Electronics" are
 * different words for a real choice, not a spelling of one.
 *
 * So the fix is to make the reuse instruction true: hand each item what its
 * siblings proposed, as ordinary axis values. No new prompt, no second pass, no
 * question for the user — the model already knows what to do with a value that
 * is "already in use".
 *
 * Existing values win: a category the workspace has actually committed to is
 * worth more than one a sibling proposed a second ago, and comes first.
 */
export function withProposedCategories(menu: ScanMenuEntry[], proposed: string[]): ScanMenuEntry[] {
  const clean = proposed.filter((c) => typeof c === "string" && c.trim() && !isJunkCategory(c));
  if (!clean.length) return menu;
  return menu.map((entry) => {
    const axis = entry.category_field;
    if (!axis) return entry;
    const seen = new Set(axis.values.map((v) => normaliseCategory(v)).filter(Boolean));
    const extra: string[] = [];
    for (const c of clean) {
      const key = normaliseCategory(c);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      extra.push(c.trim());
      if (axis.values.length + extra.length >= MAX_CARRIED_CATEGORIES) break;
    }
    if (!extra.length) return entry;
    return { ...entry, category_field: { ...axis, values: [...axis.values, ...extra] } };
  });
}

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

  let instances: Array<{ module_name: string; instance_name: string; display_name: string; is_default: boolean; is_scan_fallback?: boolean; item_count?: number | null; config?: Record<string, unknown> }> = [];
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

  // The workspace's designated catch-all per module: where an item that matches
  // no table IN PARTICULAR should land, to then be told apart by its category.
  // The user's pick wins; absent a pick, the module's DEFAULT instance is the
  // catch-all — even when it's otherwise hidden as clutter.
  //
  // (This used to skip a hidden default, on the theory that routing to "a table
  // the user never opens" caused the scatter. It's the opposite: WITH a category
  // axis, the default table + a category IS the consolidation — every unmatched
  // item lands in ONE place, told apart by category, and the table un-hides the
  // moment it holds anything. Without this, a workspace with named instances and a
  // hidden default got NO fallback, so its unmatched items scattered across the
  // named tables by name-similarity — exactly the scatter bug this fixed.)
  const fallbackByModule = new Map<string, string>();
  const fallbackInstance = new Set<string>(); // "<module>::<instance>"
  for (const [moduleName, insts] of byModule) {
    const pick = chooseFallbackInstance(insts);
    if (pick) {
      fallbackByModule.set(moduleName, pick);
      fallbackInstance.add(`${moduleName}::${pick}`);
    }
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
    // Hide an empty auto-default that named instances have superseded — UNLESS it's
    // this module's scan catch-all. The fallback MUST be in the menu, or the model
    // has nowhere to route an unmatched item and it scatters into the named tables.
    if (
      inst.is_default &&
      hideDefaults.has(inst.module_name) &&
      !fallbackInstance.has(`${inst.module_name}::${inst.instance_name}`)
    )
      continue;
    const kind = inst.is_default ? scanInfo.kind : `${inst.instance_name}:item`;
    const override = overridesByTarget.get(`${inst.module_name}:${inst.instance_name}`);
    const noun = override?.item_noun || scanInfo.noun;
    const scanKeywords = Array.isArray(override?.scan_keywords)
      ? override!.scan_keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
      : undefined;

    let fields: MenuField[] = [];
    let categoryField: ScanMenuEntry["category_field"];
    let packField: ScanMenuEntry["pack_field"];
    try {
      const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/field-defs?kind=${encodeURIComponent(kind)}`, { headers: auth });
      if (res.ok) {
        const defs = ((await res.json()) as { items?: Array<{ name: string; display_label: string; type: string; help?: string | null; choices?: string[] | null; decode_role?: string | null; field_role?: string | null }> }).items ?? [];
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
        // The table's GROUPING AXIS, declared — never guessed from a field named
        // "category". Its existing choices ARE the workspace's taxonomy: it grows
        // from the user's own data, and the kernel never learns the word
        // "Electrical". At most one per kind (a partial unique index enforces it).
        const cat = defs.find((d) => d.field_role === "category");
        if (cat) {
          categoryField = { name: cat.name, label: cat.display_label, values: cat.choices ?? [] };
        }
        // The PACK-COUNT axis, declared — filled deterministically from the
        // observed pack, never guessed. At most one per kind.
        const pack = defs.find((d) => d.field_role === "pack");
        if (pack) {
          packField = { name: pack.name, label: pack.display_label };
        }
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
      ...(categoryField ? { category_field: categoryField } : {}),
      ...(packField ? { pack_field: packField } : {}),
      ...(fallbackByModule.get(inst.module_name) === inst.instance_name ? { is_fallback: true } : {}),
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
    // …but a leading DECIMAL is part of the name, not a count: "0.9 degree
    // stepper" must not lose its "0" and become ".9 degree stepper".
    .replace(/^\s*\d+(?!\.\d)\s*(x|×)?\s*/i, "")
    .replace(/^(skeins?|balls?|spools?|rolls?|packs?|boxes?|bottles?|cans?|bags?|units?|pcs?|pieces?)\b\s*/i, "")
    .replace(/^of\s+/i, "")
    .trim();
  // A period ends a clause only when it is NOT a decimal point. Splitting on
  // every "." truncated model numbers to their integer part — "Voron 0.1 3D
  // Printer (partially built)" became "Voron 0" (reported 2026-08-12) — and
  // because the matchmaker writes this name back onto the row, the item was
  // renamed to a number permanently.
  const cut = s.split(/[,;\n]|\.(?!\d)/)[0]?.trim() || s;
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
/**
 * The category the model proposed, resolved against the values the table already
 * uses — case- and punctuation-insensitively.
 *
 * The prompt ASKS the model to reuse an existing value. This ENFORCES it, because
 * a prompt is a request and a taxonomy that quietly grows an "Electrical",
 * "electrical" and "Electrical Parts" is worthless. Only a genuinely unseen value
 * is flagged `isNew`; a near-miss snaps to what's already there.
 *
 * Returns null when the table declared no category axis, or the model said
 * nothing usable — a category is never invented on the model's behalf.
 */
/** Resolve the category AND write it onto the candidate's own fields.
 *
 *  resolveCategory snaps a raw category onto the table's existing vocabulary,
 *  and the result was set on `candidate.category` - a field the COMMIT PATH
 *  never reads. Confirm sends `candidate.fields` as `extras`, so the normalised
 *  value was computed and then dropped, and the raw per-item string is what
 *  landed on the entity. That is why three shirts identified as "apparel",
 *  "apparel" and "clothing" became two different categories on the destination
 *  table (reported 2026-07-30) even though the snapping had already agreed.
 *
 *  Writing it into `fields[axis.name]` puts it where the confirm already looks,
 *  and where growCategoryChoices reads it to grow the vocabulary - so the value
 *  the user is shown is the value that lands, with no new plumbing. */
export function resolveCategoryInto(
  entry: Pick<ScanMenuEntry, "category_field">,
  raw: unknown,
  fields: Record<string, string | number | boolean>,
): { value: string; isNew: boolean } | null {
  const cat = resolveCategory(entry, raw);
  const axis = entry.category_field?.name;
  // Never overwrite a value the identify/AI already filled for the axis field
  // itself - that one was chosen FOR this field, this is a derived fallback.
  if (cat && axis && (fields[axis] === undefined || fields[axis] === "")) fields[axis] = cat.value;
  return cat;
}

export function resolveCategory(
  entry: Pick<ScanMenuEntry, "category_field">,
  raw: unknown,
): { value: string; isNew: boolean } | null {
  const axis = entry.category_field;
  if (!axis) return null;
  const proposed = typeof raw === "string" ? raw.trim() : "";
  if (!proposed || proposed.length > 60) return null;
  // A placeholder is not a category. Filing under "undefined"/"unknown"/"other"
  // looks answered on screen and is worth less than the blank it replaced, which
  // at least prompts the user. Five items in one recorded scan came back
  // "undefined"; that string reached the axis as a real proposed value.
  if (isJunkCategory(proposed)) return null;
  // The SHARED reconciler, so enforcement is as strong as the reconciliation the
  // session header and the chips already do. A local normalizer let a plural or a
  // synonym past as "new", which is how one kind gets two entries.
  const key = normaliseCategory(proposed);
  if (!key) return null;
  const existing = axis.values.find((v) => normaliseCategory(v) === key);
  // A value the table already uses always wins over the model's spelling of it.
  if (existing) return { value: existing, isNew: false };
  return { value: proposed, isNew: true };
}

/** Seed a table's `pack`-role field from the OBSERVED package (metadata.pack_size
 *  — parsed deterministically by enrich / read off the photo). Heuristic-first:
 *  the parsed pack is more trustworthy than a model guess, so it WINS over any
 *  value already in `fields`. A no-op for a table without a pack axis. */
function seedPackSize(
  entry: ScanMenuEntry,
  item: PerceivedItem,
  fields: Record<string, string | number | boolean>,
): void {
  if (!entry.pack_field) return;
  const packSize = (item.metadata as { pack_size?: unknown } | null | undefined)?.pack_size;
  if ((typeof packSize === "number" || typeof packSize === "string") && String(packSize).trim() !== "") {
    fields[entry.pack_field.name] = packSize;
  }
}

/**
 * Pick WHICH module's fallback table an unrouted item lands in. The menu flags
 * one fallback PER MODULE (assets, inventory, machines each have one), and
 * `menu.find(is_fallback)` took whichever sorted first — a 10-pack of wall
 * plates was filed under ASSETS because the assets row preceded inventory in
 * the menu. The module is a judgment about what KIND of record the item is:
 *
 *   1. the caller's module preference (the demoted AI primary's module — the
 *      model already judged part-vs-asset even when its table pick was wrong),
 *   2. the identify's entityType, defaulting to "part" — a scan with no other
 *      signal is a consumable, not an asset or a machine (core-scan's own
 *      vocabulary; the kind-SUFFIX match keeps this module-ignorant),
 *   3. the first flagged fallback (menu order, the old behavior).
 */
export function pickFallbackEntry(
  item: PerceivedItem,
  menu: ScanMenuEntry[],
  preferredModule?: string,
): ScanMenuEntry | undefined {
  const fallbacks = menu.filter((m) => m.is_fallback && !m.bundle_external_id);
  if (fallbacks.length === 0) return undefined;
  return (
    (preferredModule ? fallbacks.find((f) => f.module === preferredModule) : undefined) ??
    fallbacks.find((f) => f.kind.endsWith(`:${item.entityType ?? "part"}`)) ??
    fallbacks[0]
  );
}

/** What the lexical scorer concluded about one (item, table) pair. `plausible`
 *  is the ROUTING verdict: real table-evidence (noun / head-noun / ≥2 keywords),
 *  the bar both the heuristic and the post-AI corroboration gate use. */
export interface LexicalEvidence {
  score: number;
  plausible: boolean;
  keywordHits: number;
  /** Real "this item IS that thing" evidence: the table's noun matched the
   *  name, a keyword/choice hit the head noun, or a phrase keyword appeared in
   *  the name. Distinguishes a named route from one held up only by ≥2
   *  corroborating keyword grazes. */
  strong: boolean;
  fields: Record<string, string | number | boolean>;
}

/** Build the per-item lexical scorer heuristicMatch routes with — exposed as a
 *  factory so runMatchmaker can CORROBORATE an AI pick against the same
 *  deterministic evidence (one bar, two callers). */
export function makeLexicalScorer(item: PerceivedItem): {
  hay: string;
  scoreEntry: (entry: ScanMenuEntry) => LexicalEvidence;
} {
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
  // Single words match TOKENS, never raw substrings: `hay.includes("car")` hit
  // "old CARds", "make" hit "MAKing it easy", "vin" hit "without haVINg" — and
  // two such grazes in one marketing description made a storage tote "plausible"
  // for a Vehicles table (keywords car/make/vin). A compound token still counts
  // when the keyword is a whole morpheme of it ("screw" in "screwdriver", "van"
  // in "minivan"): prefix/suffix with ≥3 chars of remainder, so "car|ds" can
  // never ride again. Multi-word phrases keep the verbatim substring match
  // ("license plate" appearing as-is is real evidence).
  const tokenList = [...tokens];
  const wordHit = (w: string): boolean => {
    const sw = stem(w);
    if (tokens.has(sw)) return true;
    return tokenList.some((t) => (t.startsWith(sw) || t.endsWith(sw)) && t.length - sw.length >= 3);
  };
  const hasWord = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return p.length >= 3 && hay.includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && wordHit(w));
  };
  // The capture's HEAD NOUN — the last content token of the NAME after
  // stripping trailing size/pack tails ("Fieldcrest Bath Towels 4 Pack" →
  // "towel"). A keyword matching the head noun is what the item IS, not an
  // incidental word ("Lcd Ribbon Cable" heads "cable", so Yarn's "ribbon"
  // keyword stays weak — the original false-positive guard holds).
  //
  // A prepositional tail names the item's TARGET, not the item — "stainless
  // screws FOR THE FRAME" is screws, not a frame; "replacement belt FOR Dyson
  // V8" is a belt. Cut at the first for/with/fits so the head noun is the thing
  // itself; a name that IS a prepositional phrase falls back to the full name.
  const rawName = (item.name ?? "").toLowerCase();
  const nameCore = rawName.split(/\b(?:for|with|fits)\b/)[0]!.trim() || rawName;
  const TAIL = new Set(["pack", "packs", "count", "ct", "pcs", "pc", "set", "sets", "oz", "ml", "lb", "lbs", "kg", "inch", "in", "ft", "each", "roll", "rolls"]);
  // Retail names end with the COLOR ("…Rocker Switch White", "…Soft White") —
  // a color is a property, never what the item IS, and treating it as the head
  // noun let a filament table's color choice "White" claim a light switch.
  const COLOR_TAIL = new Set(["white", "black", "red", "blue", "green", "yellow", "gray", "grey", "silver", "gold", "brown", "beige", "ivory", "clear", "orange", "purple", "pink", "tan", "almond"]);
  const nameTokens = nameCore.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  // Pop size/pack TAIL tokens, trailing colors, and anything digit-bearing
  // ("20lb", "4pk") — the head noun is the thing itself, never its packaging
  // arithmetic or its finish.
  while (
    nameTokens.length > 1 &&
    (TAIL.has(nameTokens[nameTokens.length - 1]!) ||
      COLOR_TAIL.has(nameTokens[nameTokens.length - 1]!) ||
      /\d/.test(nameTokens[nameTokens.length - 1]!))
  ) nameTokens.pop();
  // A color can never BE the head noun (a name that is only color words has no
  // head): "what the item is" is never a color, so a color choice must not gain
  // routing strength even when it survives the pop above.
  const headCandidate = nameTokens.length ? nameTokens[nameTokens.length - 1]! : "";
  const headStem = headCandidate && !COLOR_TAIL.has(headCandidate) ? stem(headCandidate) : "";
  const hitsHead = (phrase: string): boolean =>
    !!headStem && phrase.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && stem(w) === headStem);
  // ROUTING strength must come from the NAME — what the item is called — not
  // from a word buried in the metadata blob (raw catalog attributes, photo
  // observations, marketing text). A bundle whose noun is a generic word
  // ("set", "type") matched a light switch because "Type:" and "set" appear in
  // virtually every retail payload; hay-wide matches still SCORE (and count as
  // keyword corroboration), but only name evidence makes a table strong.
  const nameStems = new Set(nameCore.split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem));
  const nameHas = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return nameCore.includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && nameStems.has(stem(w)));
  };

  const scoreEntry = (entry: ScanMenuEntry): LexicalEvidence => {
    let score = 0;
    // `strong` = a real "this item IS that thing" signal: the table's NOUN
    // matched, a keyword or CHOICE matched the capture's HEAD NOUN. A match on
    // only a secondary scan_keyword is weak and incidental ("ribbon" in "Lcd
    // Ribbon Cable" hitting Yarn's ribbon-yarn keyword) — so it takes the noun,
    // a head-noun hit, OR ≥2 corroborating keywords to suggest a table.
    //
    // A field-CHOICE match is a FIELD-FILL signal, NOT table evidence, unless
    // the choice IS the head noun. This scorer routed a "Square D Circuit
    // Breaker" to a tooling table (its end_type choices list "Square") and a
    // "Smart Box" device box to a wardrobe ("Smart casual") — a brand or
    // marketing word grazing an unrelated table's choice vocabulary was treated
    // as proof the item belonged there, and the honest fallback+category could
    // never outscore it. ("…Nike Hoodie" hitting a garment_type choice "Hoodie"
    // stays strong: the choice names what the item IS.)
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
      if (nameHas(entry.noun)) strong = true;
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
        // A keyword that IS the capture's head noun ("…Bath Towels" → keyword
        // "towel") identifies the thing itself → strong on its own. So does a
        // MULTI-WORD keyword appearing verbatim IN THE NAME: "light bulb" there
        // is naming, not grazing ("…Soft White 4-pack" heads to the color, so
        // the head-noun test alone misses it). The same phrase found only in
        // the metadata blob stays a corroborating hit, not a route.
        if (hitsHead(term) || (/\s/.test(term.trim()) && nameHas(term))) strong = true;
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
            score += 1; // a fill hint, no longer a 3-point routing vote
            if (hitsHead(ch)) strong = true; // the choice names the thing itself
            if (!(f.name in fields)) fields[f.name] = ch; // extract the matched choice
          }
        }
      }
    }
    return { score, keywordHits, fields, strong, plausible: strong || keywordHits >= 2 };
  };
  return { hay, scoreEntry };
}

export function heuristicMatch(item: PerceivedItem, menuIn: ScanMenuEntry[]): MatchCandidate[] {
  const menu = filterMenuForItem(item, menuIn);
  if (menu.length === 0) return [];
  const { hay, scoreEntry } = makeLexicalScorer(item);

  const scored = menu
    .map((entry) => ({ entry, ...scoreEntry(entry) }))
    // Only confident routes: a noun / head-noun match or ≥2 keywords. A lone
    // incidental keyword or choice-word graze no longer force-fits an item into
    // the wrong bundle; when nothing qualifies the fallback+category below takes it.
    .filter((s) => s.plausible)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  const qm = hay.match(/(\d+)\s*(skein|ball|spool|roll|pack|box|bottle|can|bag|unit|pcs|piece|x|×)/);
  const quantity = qm ? Number(qm[1]) : undefined;
  const name = cleanCaptureName(item.name ?? "");

  // Nothing matched a specific table. That is NOT nothing to say: the identify
  // pass already produced a category for this item ("electrical wiring device"),
  // and the workspace has a designated fallback table. So route it there and
  // carry that category — deterministically, with no model call. Without this,
  // the no-AI path returns [] and every unmatched item lands in one undifferen-
  // tiated heap, which is the same scatter problem wearing a different hat.
  if (scored.length === 0) {
    const fallback = pickFallbackEntry(item, menu);
    if (!fallback) return [];
    const fallbackFields: Record<string, string | number | boolean> = {};
    seedPackSize(fallback, item, fallbackFields);
    const cat = resolveCategoryInto(fallback, item.category, fallbackFields);
    return [
      {
        module: fallback.module,
        instance: fallback.instance,
        kind: fallback.kind,
        label: fallback.label,
        confidence: 0.3,
        name,
        fields: fallbackFields,
        heuristic: true,
        basis: "fallback",
        ...(Number.isInteger(quantity) && quantity! > 0 && quantity! <= 10_000 ? { quantity } : {}),
        ...(cat ? { category: cat.value, ...(cat.isNew ? { category_is_new: true } : {}) } : {}),
        ...(fallback.bundle_external_id ? { bundle_external_id: fallback.bundle_external_id } : {}),
        notes: cat ? routingNoteWithCategory(fallback.label, cat.value) : routingNoteBare(),
      },
    ];
  }

  return scored.map(({ entry, score, strong, fields }, i) => {
    // Same deterministic pack-fill as the AI path (no-AI workspaces get it too).
    seedPackSize(entry, item, fields);
    // The identify already named a category — reuse it rather than paying anyone
    // to re-derive it. resolveCategory snaps it to the table's existing vocabulary.
    const cat = resolveCategoryInto(entry, item.category, fields);
    return {
      module: entry.module,
      instance: entry.instance,
      kind: entry.kind,
      label: entry.label,
      confidence: Math.min(0.6, 0.3 + score * 0.04),
      name,
      fields,
      heuristic: true as const,
      // "noun" = the route names what the item IS; "keywords" = held up only by
      // corroborating hits — the UI renders that tentative, and File all skips it.
      basis: (strong ? "noun" : "keywords") as "noun" | "keywords",
      ...(Number.isInteger(quantity) && quantity! > 0 && quantity! <= 10_000 ? { quantity } : {}),
      ...(cat ? { category: cat.value, ...(cat.isNew ? { category_is_new: true } : {}) } : {}),
      ...(entry.bundle_external_id ? { bundle_external_id: entry.bundle_external_id } : {}),
      ...(i === 0
        ? { notes: "Matched by keywords (no AI). Connect an AI provider for sharper identification + field-fill." }
        : {}),
    };
  });
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
  /** REPLAY: recompute the routing from what the row ALREADY holds, with no model
   *  call of any kind.
   *
   *  A stored candidate has the same shape as a model reply, so it goes through
   *  the identical refinement below: re-validated against the CURRENT menu,
   *  fields re-filtered to each table's schema, pack size re-seeded, category
   *  re-snapped to the live vocabulary, corroboration gate re-applied. That is
   *  the whole point of a replay — the same knowledge, the newest code.
   *
   *  It used to serve the model call cache-only instead, which fails like an
   *  unavailable provider on a miss and landed on `heuristicMatch`. Since the
   *  cache key is pinned to provider + model, a miss is the NORMAL case, so
   *  "replay" in practice meant "answer with the dumbest available path" and
   *  quietly downgraded the row (reported 2026-08-12). */
  replay?: { storedCandidates: unknown[] },
): Promise<MatchCandidate[]> {
  // A physical scan never routes to a record table — drop them before the model
  // even sees the menu, so it can't suggest one (and the heuristic fallback below
  // inherits the already-filtered menu).
  const menu = filterMenuForItem(item, menuIn);
  // No table to route to. A first match legitimately has nothing to say; a REPLAY
  // must still not empty a row that already had candidates.
  if (menu.length === 0) return replay ? (replay.storedCandidates as MatchCandidate[]) : [];

  const system =
    "You sort a scanned physical item into the user's catalog of tables and " +
    "extract its fields. You are given the ITEM (what a scanner/vision read, " +
    "including lookup_metadata — the raw catalog/web data: attributes, " +
    "descriptions, pack info) and the user's TABLES (each: a module, an " +
    "optional instance slug, a noun, optional scan_keywords, and fields with " +
    "labels/help/allowed choices). Do three things:\n" +
    "1. Pick the tables for this item, RANKED best-first: the ONE best-fitting " +
    "table (the primary) and AT MOST ONE secondary. Include a secondary ONLY " +
    "when the item genuinely belongs in two DIFFERENT tables (e.g. one copy is " +
    "both a reading copy in one table AND a graded collectible in another) — " +
    "most items have just ONE home, so usually return a single " +
    "table. NEVER list the same table (same module+instance) twice, and never " +
    "pad the list with a marginal or duplicate table to fill a slot: one " +
    "confident table beats two noisy ones, and identical items must route the " +
    "same way. A table " +
    "fits when the item is the kind of thing that table holds. Judge fit " +
    "PRIMARILY from the table's noun and its FIELDS — a field's label, help, and " +
    "allowed choices reveal what a table is for (fields like `author` + `isbn` " +
    "say a table is for books; `size` + `care_instructions` say clothing — the " +
    "fields, not the name alone, tell you). scan_keywords, when present, are an " +
    "EXTRA explicit hint — use them to BREAK TIES when two tables fit similarly, " +
    "not as the main signal (most tables won't have them, and route fine " +
    "without). But a specific table holds a specific KIND of thing: a table of " +
    "discrete components is for the individual parts, NOT a finished product " +
    "assembled from them. If the item is a finished or whole product that merely " +
    "RELATES to a table's domain rather than being the kind it holds, route it to " +
    "the FALLBACK table (`is_fallback: true`) — and do NOT invent a field value " +
    "to justify forcing it into a specific table (a fabricated field is worse " +
    "than the honest fallback table). If nothing fits well, " +
    "return the FALLBACK table for the closest module (or its generic default " +
    "table, instance null, if no table is flagged).\n" +
    "1b. A DIFFERENCE IN KIND IS A CATEGORY, NOT A DIFFERENT TABLE. This is the " +
    "most important routing rule. A workspace often has several tables that " +
    "overlap almost entirely — broad catch-alls that all hold roughly the same " +
    "kind of thing. They are NOT how you express that two items differ in kind. " +
    "When a table declares a `category_field`, THAT is where a difference in kind " +
    "belongs: route the item to ONE table and set its category. Choose a " +
    "DIFFERENT table only when the item is a genuinely different kind of RECORD " +
    "(one table's row is a physical object you keep, another's is an order or a " +
    "task) — never merely because a different table's name sounds closer to the " +
    "item's domain. Items of the same domain MUST route the same way: a run of " +
    "like items belongs in one table distinguished by category, not scattered " +
    "across near-synonym tables that all mean roughly 'stuff'.\n" +
    "1c. Setting the category: use one of the `category_field.values` already in " +
    "use when one genuinely fits — reuse beats invention, and the workspace's " +
    "existing vocabulary is the right vocabulary. When none fits, PROPOSE a new " +
    "one: a short, plain, reusable noun phrase for the KIND of thing this is, not " +
    "a description of this one item (the broad kind, never the individual unit " +
    "with its colour/size/brand). Return it in the candidate's `category`. " +
    "Nothing is created until the user confirms.\n" +
    "COARSEN, don't echo. The item's `category` field is a HINT from a product " +
    "database, written to file a CATALOG rather than a home: it splits one " +
    "everyday kind into many narrow sub-types. Collapse the hint UP.\n" +
    "AIM FOR THE AISLE, NOT THE SHELF TAG. The right grain is the heading a shop " +
    "or a menu would use — a word still useful with a thousand items behind it. A " +
    "whole workspace should settle on roughly 5-15 categories in total. Each of " +
    "these lines is ONE category, not three: 'Circuit Breaker Panels', 'Wall " +
    "Plates & Covers' and 'Power Outlets & Sockets' are all Electrical; 'Ground " +
    "Cumin Seeds', 'Garlic Powder' and 'Dried Rosemary' are all Spices; 'Steamer " +
    "Baskets' and 'Mugs' are both Kitchen. If your answer names the exact product " +
    "someone searched for, it is a level or two too fine — go up until it names " +
    "the section they would BROWSE.\n" +
    "Test: could this category still head a whole page of items a year from now? " +
    "If it could only ever hold this item and its near-identical twins, go " +
    "broader. Prefer a value already in `category_field.values` over coining a " +
    "synonym of it. Never answer 'unknown', 'other', 'misc' or 'undefined' — omit " +
    "the category instead and let the user name it.\n" +
    "2. For EACH picked table, fill in field values — MINE EVERY ITEM FIELD: " +
    "the title, lookup_metadata attributes (material/color/size), the " +
    "description, lookup_notes. Map them onto the table's field names (e.g. an " +
    "attribute 'color: Slate Blue' -> a 'colour' field; 'material: Cotton' -> a " +
    "'fabric' field; a descriptor in the title -> its matching declared field). " +
    "For a field with `choices`, use the closest listed choice or " +
    "omit. When a field's label/help asks for a hex or colour swatch, " +
    "output a CSS hex code for the named colour (e.g. '#6F8FAF' for a " +
    "slate blue), not a word. If lookup_metadata.user_hint is present it " +
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
    "retailer noise from `name` (a marketplace prefix, a '3-Pack of ...' suffix " +
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
    ...(m.is_fallback ? { is_fallback: true } : {}),
    // The table's grouping axis + the vocabulary already in use, so the model can
    // express "electrical" WITHOUT reaching for a different table to say it.
    ...(m.category_field ? { category_field: m.category_field } : {}),
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
        // A 2-candidate reply with reconciliation notes never fit the 1024
        // default — the notes-truncation salvage in parseMatchmakerCandidates
        // exists because of that cap. Root-caused here; the salvage stays as
        // defense in depth. temperature 0 is the adapters' default already,
        // stated explicitly because THIS prompt demands routing determinism.
        config: { max_tokens: 2048, temperature: 0 },
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
  let rawList: unknown[] | null;
  if (replay) {
    // The knowledge is already on the row. Feed it through the same refinement a
    // model reply gets — no call, no cache read, and therefore no degrade path to
    // fall down.
    rawList = replay.storedCandidates;
  } else {
    rawList = await callOnce(false, MATCH_DEADLINE_MS);
    if (rawList === null && remaining() > RETRY_MIN_MS) rawList = await callOnce(true, remaining());
    // AI unavailable (no provider / not entitled / errored / timed out) → fall back
    // to the deterministic heuristic so capture-first still suggests a tracker for
    // free / no-AI workspaces. The whole point: capture-first never goes dark.
    if (rawList === null) return heuristicMatch(item, menu);
  }

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
    // PACK COUNT — filled from the OBSERVED package, overriding any model guess
    // (see seedPackSize). A `pack`-role field records what you're holding.
    seedPackSize(entry, item, fields);
    const qty = Number(cand.quantity);
    // Backfill provenance: field names the model filled from its KNOWLEDGE of a
    // confident known entity, sanitized against what it actually filled.
    const inferred = normalizeInferred(cand.inferred, fields);
    // Surface the provenance in the notes line (where the user already looks), so
    // a value filled from knowledge rather than the photo is flagged for a glance.
    const baseNotes = typeof cand.notes === "string" && cand.notes.trim() ? cand.notes.trim().slice(0, 1800) : "";
    const inferredNote = inferred.length ? `Filled from catalog knowledge (double-check): ${inferred.join(", ")}.` : "";
    const notes = [baseNotes, inferredNote].filter(Boolean).join(" ");
    // The category — only meaningful for a table that DECLARED a grouping axis.
    // Reuse of an existing value is preferred; a proposal is flagged `is_new` so
    // the card can say so, and nothing is created until the user confirms.
    const category = resolveCategoryInto(entry, cand.category, fields);

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
      ...(category ? { category: category.value, ...(category.isNew ? { category_is_new: true } : {}) } : {}),
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
  // Nothing usable for this menu. Normally that means the heuristic floor, never
  // blank. Under REPLAY it means the stored routing no longer validates (its
  // table was uninstalled, or renamed), and manufacturing a keyword guess in its
  // place is the downgrade this whole path exists to stop — so keep what the row
  // already had and let the user re-identify if they want a fresh opinion.
  if (out.length === 0) return replay ? (replay.storedCandidates as MatchCandidate[]) : heuristicMatch(item, menu);
  // AI proposes, code corroborates: a primary routed to a NOT-installed bundle
  // must survive the same lexical bar the heuristic routes with, or the honest
  // fallback+category leads and the bundle drops to the alternative slot.
  return applyCorroborationGate(out, item, menu);
}

/**
 * The corroboration gate (AI proposes, code corroborates). A model given a
 * catalog of themed, not-yet-installed bundles will sometimes pick one on vibes
 * — a light switch filed under a supplies bundle at 0.52 — and per-item calls
 * can't see that six electrical parts belong TOGETHER. When the workspace has a
 * designated fallback table, an AI primary that (a) targets a NOT-installed
 * bundle and (b) has no lexical table-evidence for this item is demoted: the
 * fallback + the item's own catalog category leads (the axis built for exactly
 * this), and the bundle stays as the one-tap alternative. Same-domain items
 * then cluster by construction instead of by model mood. Pure — exported for
 * tests. Live tables are never gated: the user's own tables, the AI's call.
 */
export function applyCorroborationGate(
  out: MatchCandidate[],
  item: PerceivedItem,
  menu: ScanMenuEntry[],
): MatchCandidate[] {
  const primary = out[0];
  if (!primary?.bundle_external_id) return out; // live-table primary: trusted
  // The demoted primary's MODULE is kept — the model judged part-vs-asset right
  // even when its table pick was a themed bundle.
  const fallback = pickFallbackEntry(item, menu, primary.module);
  if (!fallback) return out; // no honest destination to prefer
  const primaryEntry = menu.find(
    (m) => m.module === primary.module && (m.instance ?? null) === (primary.instance ?? null),
  );
  if (!primaryEntry) return out;
  const { scoreEntry } = makeLexicalScorer(item);
  if (scoreEntry(primaryEntry).plausible) return out; // corroborated → stands
  const fields: Record<string, string | number | boolean> = {};
  seedPackSize(fallback, item, fields);
  const cat = resolveCategoryInto(fallback, item.category, fields);
  const fallbackCand: MatchCandidate = {
    module: fallback.module,
    instance: fallback.instance,
    kind: fallback.kind,
    label: fallback.label,
    confidence: Math.max(0.55, primary.confidence + 0.03),
    name: primary.name,
    fields,
    basis: "fallback",
    ...(cat ? { category: cat.value, ...(cat.isNew ? { category_is_new: true } : {}) } : {}),
    notes: cat
      ? `Filed under ${fallback.label} as “${cat.value}” — nothing in the item text ties it to ${primary.label}.`
      : `Filed under ${fallback.label} — nothing in the item text ties it to ${primary.label}.`,
  };
  // The fallback may already be in the list as the secondary — lead with it
  // rather than duplicating it.
  const existing = out.findIndex(
    (c) => c.module === fallback.module && (c.instance ?? null) === (fallback.instance ?? null),
  );
  if (existing >= 0) {
    const [fb] = out.splice(existing, 1);
    return [fb!, ...out].slice(0, 2);
  }
  return [fallbackCand, ...out].slice(0, 2);
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
