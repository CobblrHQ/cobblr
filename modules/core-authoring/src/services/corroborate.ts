// AI proposes, code corroborates — the builder's half of a rule the
// matchmaker already lives by ("The prompt ASKS the model to reuse an existing
// value. This ENFORCES it").
//
// Measured on the authoring eval (2026-08-26), every model's builder failures
// fell into classes that are CODE's job, not the prompt's:
//
//   · a `brand` field proposed for a kind that already ships `manufacturer`
//     (local models, tool-warranty) — a near-synonym of a field already there;
//   · a whole bundle invented for "make my workspace better" (vague-decline),
//     when the contract says leave it empty and explain;
//   · a bundle missing its `requires` (gemini), which is fully derivable from
//     the modules the bundle itself references.
//
// None of these get better by making the prompt longer — it is already large,
// and a rule stated in prose is a request. Each function here is the same rule
// stated in code, run on the candidate before validation. Pure, so the eval's
// exact failing cases are unit tests.

export interface KindFields {
  /** Every field the kind already has — natives AND custom — by name, with
   *  the role each declares. */
  fields: Array<{ name: string; role?: string | null }>;
}

interface FieldDefLike {
  entity_kind?: string;
  name?: string;
  display_label?: string;
  field_role?: string | null;
  [k: string]: unknown;
}

export interface BundleLike {
  requires?: Array<{ module: string; version?: string }>;
  wires?: unknown[];
  field_defs?: FieldDefLike[];
  provides_instances?: Array<{ module?: string; field_defs?: FieldDefLike[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Names that mean the same field. Small on purpose: the ROLE match above it
 *  is the real mechanism, and this catches only the pairs a model reaches for
 *  when it does not know the native's name. */
const SYNONYMS: Array<Set<string>> = [
  new Set(["brand", "manufacturer", "make", "maker"]),
  new Set(["purchase_date", "purchased_at", "purchased_on", "date_purchased", "bought_on", "acquired_on"]),
  new Set(["warranty", "warranty_until", "warranty_expiry", "warranty_expires", "warranty_end"]),
  new Set(["colour", "color"]),
  new Set(["qty", "quantity", "count"]),
  new Set(["serial", "serial_number", "serial_no"]),
  new Set(["price", "cost", "paid", "purchase_price", "acquired_for"]),
  new Set(["location", "where", "stored_in", "stored_at"]),
  new Set(["notes", "note", "comments", "remarks"]),
];
const synonymGroup = (name: string): Set<string> | null => SYNONYMS.find((g) => g.has(name)) ?? null;

export interface DroppedField {
  entity_kind: string;
  name: string;
  /** The field it duplicated, and how the duplicate was recognised. */
  duplicates: string;
  by: "role" | "name" | "synonym";
}

/**
 * Drop every proposed field that a kind ALREADY has — by role, by name, or by
 * a known synonym. Returns what was dropped so the interpretation can say so;
 * nothing lands in a schema that was not asked for.
 */
export function dropRedundantFields(bundle: BundleLike, kinds: Map<string, KindFields>): DroppedField[] {
  const dropped: DroppedField[] = [];
  const keep = (defs: FieldDefLike[] | undefined, kindOf: (d: FieldDefLike) => string | undefined): FieldDefLike[] => {
    if (!Array.isArray(defs)) return [];
    return defs.filter((d) => {
      const kind = kindOf(d);
      const name = typeof d.name === "string" ? norm(d.name) : "";
      if (!kind || !name) return true;
      const have = kinds.get(kind);
      if (!have) return true;
      for (const f of have.fields) {
        const fname = norm(f.name);
        let by: DroppedField["by"] | null = null;
        if (fname === name) by = "name";
        else if (d.field_role && f.role && d.field_role === f.role) by = "role";
        else if (synonymGroup(name)?.has(fname)) by = "synonym";
        if (by) {
          dropped.push({ entity_kind: kind, name: d.name!, duplicates: f.name, by });
          return false;
        }
      }
      return true;
    });
  };
  bundle.field_defs = keep(bundle.field_defs, (d) => d.entity_kind);
  for (const inst of bundle.provides_instances ?? []) {
    if (inst && typeof inst === "object") inst.field_defs = keep(inst.field_defs, (d) => d.entity_kind);
  }
  return dropped;
}

/**
 * `requires` is derivable: every module a bundle's fields, instances or wires
 * reference must be present. Union with whatever the model said, so a model
 * that omits it (gemini did, 1 of 9) still yields an installable bundle and
 * one that names an extra module keeps it.
 *
 * `knownModules` is the workspace's real module list. A kind id's prefix is a
 * module ONLY for a base kind: an INSTANCE kind reads `medications:item`, and
 * "medications" is a list somebody made, not a module. The first version took
 * every prefix and turned two valid hosted bundles into
 * `unknown_module@requires` (2026-08-26). An unknown prefix is left out; the
 * instance's own `module` field already names the right one.
 */
export function deriveRequires(bundle: BundleLike, knownModules?: ReadonlySet<string>): string[] {
  const mods = new Set<string>();
  const isModule = (m: string): boolean => !knownModules || knownModules.has(m);
  for (const r of bundle.requires ?? []) if (r && typeof r.module === "string" && r.module) mods.add(r.module);
  const fromKind = (k: unknown) => {
    if (typeof k !== "string") return;
    const mod = k.split(":")[0];
    if (mod && !mod.startsWith("@") && isModule(mod)) mods.add(mod);
  };
  for (const d of bundle.field_defs ?? []) fromKind(d.entity_kind);
  for (const inst of bundle.provides_instances ?? []) {
    if (!inst || typeof inst !== "object") continue;
    if (typeof inst.module === "string" && inst.module && isModule(inst.module)) mods.add(inst.module);
    for (const d of inst.field_defs ?? []) fromKind(d.entity_kind);
  }
  // A wire names the kind it listens on and the action it runs; both carry a
  // module prefix, and a bundle whose wire fires an action from a module it
  // never required fails as missing_requires_module.
  for (const w of (bundle.wires as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!w || typeof w !== "object") continue;
    fromKind(w.source_kind);
    fromKind(w.action_id);
  }
  const list = [...mods].sort();
  const known = new Set((bundle.requires ?? []).map((r) => r.module));
  bundle.requires = [...(bundle.requires ?? []), ...list.filter((m) => !known.has(m)).map((m) => ({ module: m }))];
  return list;
}

/** Words that describe wanting something better without saying what. An
 *  intent made only of these has nothing to build from. */
const HOLLOW = new Set([
  "make", "my", "the", "a", "an", "this", "it", "me", "please", "can", "you", "could", "would", "i", "want", "like",
  "workspace", "app", "cobblr", "thing", "things", "stuff", "setup", "set", "up",
  "better", "nicer", "good", "great", "improve", "improved", "improvement", "optimize", "optimise", "enhance",
  "clean", "cleaner", "organize", "organise", "organized", "tidy", "fix", "help", "more", "useful", "nice",
  "some", "any", "new", "cool", "awesome", "best", "smarter", "easier", "simpler", "faster",
  "to", "for", "with", "and", "or", "of", "in", "on", "be", "is", "are", "do", "so", "just", "really",
]);

/**
 * True when the request names nothing to build: after the hollow words go,
 * nothing is left. "make my workspace better" → vague. "yarn tracker" → not
 * (yarn survives). Deliberately conservative — a false "vague" refuses a real
 * request, which is worse than building one junk field.
 */
export function tooVagueToBuild(intent: string): boolean {
  const words = intent.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => HOLLOW.has(w));
}

/** Empty the bundle's contributions while keeping its identity, for a request
 *  that named nothing. The interpretation is the whole answer. */
export function declineToBuild(bundle: BundleLike): void {
  bundle.field_defs = [];
  bundle.wires = [];
  bundle.provides_instances = [];
  bundle.field_overrides = [];
  bundle.saved_views = [];
}

/**
 * The output shape as a JSON schema a model can be CONSTRAINED to (ollama's
 * `format`, an OpenAI-compatible `response_format`). The adapters forward it;
 * the builder does NOT send it today, and that is a measured decision
 * (2026-08-26): a permissive wrapper schema made qwen3:14b time out at 120s
 * on every case (schema-constrained decoding on top of its thinking), and
 * Gemini conformed so strictly that it emitted `null` inside lists. A
 * permissive schema is the wrong thing to constrain to. It comes back as the
 * FULL bundle schema (the validator's own, converted), once that exists and
 * the latency is measured — then a non-JSON reply becomes impossible to emit
 * without a wrapper that says nothing about the inside.
 */
export function outputSchemaFor(task: string): Record<string, unknown> {
  const wrapperKey = /app/.test(task) ? "app" : "bundle";
  return {
    type: "object",
    properties: {
      interpretation: { type: "string" },
      [wrapperKey]: { type: "object", additionalProperties: true },
    },
    required: ["interpretation", wrapperKey],
    additionalProperties: true,
  };
}
