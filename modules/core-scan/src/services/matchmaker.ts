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

import { platform } from "@cobblr/platform-contract";

const MATCH_DEADLINE_MS = 20_000;

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

  const overridesByTarget = new Map<string, { item_noun?: string }>();
  try {
    const res = await fetch(`${baseUrl}/api/v1/orgs/${slug}/entity-kind-overrides`, { headers: auth });
    if (res.ok) {
      const items = ((await res.json()) as { items?: Array<{ target_kind: string; target_id: string; config?: { item_noun?: string } }> }).items ?? [];
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
    });
  }
  return entries;
}

/**
 * The join. Given what the scanner saw + the workspace's tables, return up to
 * three ranked candidates, each with the table's fields filled from the item.
 * Returns [] when there's no AI provider, the menu is empty, or the model fails
 * — the UI then falls back to today's generic part/asset behaviour.
 */
export async function runMatchmaker(
  orgId: string,
  item: PerceivedItem,
  menu: ScanMenuEntry[],
  /** The inbox item's UUID — links the AI-log row to the scan (source_id is a
   *  UUID column; passing the barcode/name here breaks the audit insert). */
  sourceId?: string,
): Promise<MatchCandidate[]> {
  if (menu.length === 0) return [];

  const system =
    "You sort a scanned physical item into the user's catalog of tables and " +
    "extract its fields. You are given the ITEM (what a scanner/vision read, " +
    "including lookup_metadata — the raw catalog/web data: attributes, " +
    "descriptions, pack info) and the user's TABLES (each: a module, an " +
    "optional instance slug, a noun, and fields with labels/help/allowed " +
    "choices). Do three things:\n" +
    "1. Pick the best-fitting tables for this item, RANKED, at most 3. A table " +
    "fits when the item is the kind of thing that table holds (a skein of yarn " +
    "-> a 'yarn' table; a drill -> 'tools'/'assets'). If nothing fits well, " +
    "return the generic default table (instance null) for the closest module.\n" +
    "2. For EACH picked table, fill in field values — MINE EVERY ITEM FIELD: " +
    "the title, lookup_metadata attributes (material/color/size), the " +
    "description, lookup_notes. Map them onto the table's field names (e.g. " +
    "attribute 'color: Country Blue' -> a 'colorway' field; 'material: " +
    "Acrylic' -> a 'fibre' field; 'Worsted' in a yarn title -> a weight " +
    "field). For a field with `choices`, use the closest listed choice or " +
    "omit. Omit only what nothing in the data supports; never invent. Strip " +
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
    "Order candidates best-first. confidence is how well the table fits the item.";

  const compactMenu = menu.map((m) => ({
    module: m.module,
    instance: m.instance,
    noun: m.noun,
    label: m.label,
    fields: m.fields.map((f) => ({
      name: f.name,
      label: f.label,
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

  const call = platform()
    .ai.invoke({
      orgId,
      capability: "chat",
      input: { messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      source: { kind: "core-scan:matchmaker", id: sourceId ?? "" },
    })
    .then((r) => r.result as { content?: string })
    .catch(() => null);

  const res = await Promise.race([
    call,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), MATCH_DEADLINE_MS)),
  ]);
  if (!res?.content) return [];

  let parsed: { candidates?: unknown };
  try {
    const m = res.content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : res.content);
  } catch {
    return [];
  }
  const rawList = Array.isArray(parsed.candidates) ? parsed.candidates : [];

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
    });
    if (out.length >= 3) break;
  }
  return out;
}
