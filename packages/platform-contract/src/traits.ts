import { z } from "zod";

// ─────────────────── Trait vocabulary (6 axes) ────────────────────
//
// Each entity kind can declare where it sits on six orthogonal axes.
// Axes are independently optional — skipping an axis with `null`
// means "this axis doesn't meaningfully apply to my entity." See
// docs/architecture/traits.md for the full rationale.

export const Tangibility = z.enum(["physical", "digital"]);
export const Identity = z.enum(["fungible", "unique"]);
export const Containment = z.enum(["container", "containable"]);
export const TimeAxis = z.enum(["schedulable", "timeless"]);
export const Lifecycle = z.enum(["completable", "indefinite"]);
export const Persistence = z.enum(["durable", "ephemeral"]);

/** Built-in renderer ids for a catalog's declarative field presentation. The
 *  platform owns the renderer library; bundles/catalogs only pick one per
 *  field. See web/src/components/CatalogFieldValue.tsx. */
export const CatalogFieldRenderer = z.enum([
  "text",
  "color-hex",
  "image-url",
  "url-link",
  "year",
  "boolean",
  "code",
]);

/** The declarative config on an imported catalog (core-catalogs). The **single
 *  source of truth**, referenced by BOTH the module's write-time validator
 *  (`SchemaConfig`) AND the bundle installer (`CatalogEntry.schema`). Those two
 *  used to be hand-kept copies that drifted — each silently stripped keys the
 *  other had (`field_map`, `exclude_from_global_search`), breaking features on
 *  install. Add a catalog-schema key HERE, once, and both paths get it. Strict
 *  on purpose: an unrecognised key is a bug, not something to wave through. */
export const CatalogSchemaConfig = z.object({
  id_column: z.string().optional(),
  title_column: z.string().optional(),
  image_column: z.string().optional(),
  subtitle_column: z.string().optional(),
  description_column: z.string().optional(),
  /** Per-field renderer overrides, keyed by payload field name. */
  field_renderers: z.record(CatalogFieldRenderer).optional(),
  /** Per-field display-label overrides (`{ num_parts: "Pieces" }`). */
  field_labels: z.record(z.string()).optional(),
  /** Catalog-match prefill + preferred-catalog derivation:
   *  `{ catalogPayloadKey: instanceFieldName }`. */
  field_map: z.record(z.string()).optional(),
  /** Replace the card image slot with a renderer over `payload[hero_field]`
   *  (e.g. a colour swatch from `rgb`). */
  hero_field: z.string().optional(),
  hero_renderer: CatalogFieldRenderer.optional(),
  /** Keep a huge / non-matchable catalog (a set BOM) out of cross-catalog
   *  search + the quick-add typeahead. */
  exclude_from_global_search: z.boolean().optional(),
  /** Entity kinds this catalog is meaningful to match against (omit = all). */
  bindable_to_kinds: z.array(z.string()).optional(),
  /** Stable `<vendor>.<kind>` id so other modules find "the canonical sets
   *  catalog" without coupling to a bundle id. */
  semantic_type: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
});

/** Reverse map from a trait name to the axis it lives on. Used by
 *  the action matcher to compute the per-axis-OR / cross-axis-AND
 *  semantics for `appliesTo: { traits: [...] }`. */
export const AXIS_OF_TRAIT = {
  physical: "tangibility",
  digital: "tangibility",
  fungible: "identity",
  unique: "identity",
  container: "containment",
  containable: "containment",
  schedulable: "time",
  timeless: "time",
  completable: "lifecycle",
  indefinite: "lifecycle",
  durable: "persistence",
  ephemeral: "persistence",
} as const;

export type TraitName = keyof typeof AXIS_OF_TRAIT;
export type AxisName = (typeof AXIS_OF_TRAIT)[TraitName];

/**
 * TRIAL AXES: traits in every way but one - no preset or profile takes a
 * position on them. They exist so a face can be spelled in trait words
 * ("goes off" is `perishable`, "gets lent" is `lendable`) and matched by the
 * same per-axis-OR / cross-axis-AND rule, without asking every module author
 * to declare spoilage for a task or custody for a location.
 *
 * Resolved per COLLECTION by the faces resolver (api/src/platform/faces.ts),
 * from a field role or an explicit choice, never from the kind's declaration.
 * If one earns its keep it moves into AXIS_OF_TRAIT and the presets; that is a
 * move, not a rewrite, because everything already reads them through
 * axisOfTrait(). Decided 2026-09-09: "add these as extra traits for the
 * purpose of faces, defined the same way, and see how that goes."
 */
export const FACE_TRAIT_AXES = {
  perishable: "spoilage",
  keeps: "spoilage",
  lendable: "custody",
  kept: "custody",
} as const;
export type TrialTraitName = keyof typeof FACE_TRAIT_AXES;
export type TrialAxisName = (typeof FACE_TRAIT_AXES)[TrialTraitName];
export type AnyTraitName = TraitName | TrialTraitName;
export type AnyAxisName = AxisName | TrialAxisName;
/** The axis a trait lives on, real or trial. Undefined for an unknown word. */
export function axisOfTrait(t: string): AnyAxisName | undefined {
  return (AXIS_OF_TRAIT as Record<string, AxisName>)[t] ?? (FACE_TRAIT_AXES as Record<string, TrialAxisName>)[t];
}

/** The 12 trait words as a tuple, for validating client input against the
 *  vocabulary (z.enum) instead of re-listing it somewhere it can drift. */
export const TRAIT_NAMES = Object.keys(AXIS_OF_TRAIT) as [TraitName, ...TraitName[]];

// One axis assignment. Three valid shapes:
//   "physical" — the entity sits on this trait
//   null — axis skipped (doesn't meaningfully apply)
//   { trait: "unique", uncertain: true } — judgment call, signaled
const axisAssignment = <T extends z.ZodTypeAny>(values: T) =>
  z.union([
    values,
    z.null(),
    z.object({ trait: values, uncertain: z.literal(true) }),
  ]);

export const RawTraits = z.object({
  tangibility: axisAssignment(Tangibility).optional(),
  identity: axisAssignment(Identity).optional(),
  containment: axisAssignment(Containment).optional(),
  time: axisAssignment(TimeAxis).optional(),
  lifecycle: axisAssignment(Lifecycle).optional(),
  persistence: axisAssignment(Persistence).optional(),
});

export type RawTraitsDecl = z.infer<typeof RawTraits>;

// The 10 platform-blessed presets. Each maps to a 6-tuple of trait
// values. Modules use `profile: "<name>"` as shorthand and `overrides`
// to flip individual axes from the preset's defaults.
// See docs/architecture/traits.md §"Presets — preset shorthand".
export const TRAIT_PRESETS = {
  "digital-record": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  // A lean catalog record — a film, a book, a board game. The face an
  // inventory instance shows when it carries no stock signal (see
  // one-record-substrate.md). Identity is UNIQUE — the load-bearing axis:
  // catalog records are counted per-title, so combine/merge treats duplicates
  // as one thing (max), never summing a phantom quantity the way it would for
  // fungible stock. Tangibility is uncertain: a film is digital, a shelved book
  // is physical, and the catalog face neither knows nor needs to.
  "catalog-record": {
    tangibility: { trait: "physical", uncertain: true },
    identity: "unique",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "owned-thing": {
    tangibility: "physical",
    identity: "unique",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  place: {
    tangibility: "physical",
    identity: "unique",
    containment: "container",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "work-item": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "schedulable",
    lifecycle: "completable",
    persistence: "durable",
  },
  "stock-material": {
    tangibility: "physical",
    identity: "fungible",
    containment: "containable",
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "recurring-schedule": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "schedulable",
    lifecycle: "indefinite",
    persistence: "durable",
  },
  "one-shot-completable": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "completable",
    persistence: "durable",
  },
  "auto-pruning-record": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    time: "timeless",
    lifecycle: "indefinite",
    persistence: "ephemeral",
  },
  "vendor-order": {
    tangibility: "digital",
    identity: "unique",
    containment: null,
    // Dictionary marks Time as `(?)` for vendor orders — vendor's
    // external schedule isn't the workspace's schedule. We collapse
    // to schedulable here; module authors can override if they
    // disagree.
    time: "schedulable",
    lifecycle: "completable",
    persistence: "durable",
  },
} as const satisfies Record<string, RawTraitsDecl>;

export type PresetName = keyof typeof TRAIT_PRESETS;

export const PresetNameSchema = z.enum(
  Object.keys(TRAIT_PRESETS) as [PresetName, ...PresetName[]],
);
