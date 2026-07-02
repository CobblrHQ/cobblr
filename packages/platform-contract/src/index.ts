// The platform contract — types and validators that modules import
// when registering with cobblr-core. Modules MUST NOT import from
// @cobblr/api directly; everything they need crosses through here.
//
// Phase 0 ships the stub: the typed manifest schema, defineModule(),
// and intent declaration shape. Module loading wires onto these in
// later phases.

import { z } from "zod";

// ───────────────────────── Module manifest ─────────────────────────

const Intent = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Zod's runtime type for the payload schema. Modules pass a real
  // ZodSchema; we type it loosely here to avoid coupling to a specific
  // version of zod in the validator output.
  schema: z.unknown().optional(),
});

const NavItem = z.object({
  label: z.string().min(1),
  route: z.string().regex(/^\//, "route must start with /"),
  icon: z.string().optional(),
});

// ─────────────────────── Pillar A: entity kinds ────────────────────
//
// Modules declare the entity kinds they own — abstract descriptions
// other modules can introspect without importing the source module's
// code. Stable IDs (e.g. "inventory:part") are the contract.

const EntityFieldRole = z.enum([
  "title",
  "subtitle",
  "image",
  "summary",
  "quantity",
  "unit",
]);

const EntityField = z.object({
  name: z.string().min(1).max(80),
  // `object` is for free-form JSON attribute blobs (e.g.
  // inventory:part.metadata) — opaque to the kernel beyond
  // type-checking that it's an object. Renderers treat it as
  // "json blob, show keys"; consumer modules read specific keys
  // via platform.entities.lookupMany.
  type: z.enum(["text", "number", "boolean", "date", "image-path", "url", "object"]),
  role: EntityFieldRole.optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const EntityKindIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

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

const RawTraits = z.object({
  tangibility: axisAssignment(Tangibility).optional(),
  identity: axisAssignment(Identity).optional(),
  containment: axisAssignment(Containment).optional(),
  time: axisAssignment(TimeAxis).optional(),
  lifecycle: axisAssignment(Lifecycle).optional(),
  persistence: axisAssignment(Persistence).optional(),
});

export type RawTraitsDecl = z.infer<typeof RawTraits>;

// The 9 platform-blessed presets. Each maps to a 6-tuple of trait
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

const PresetNameSchema = z.enum(
  Object.keys(TRAIT_PRESETS) as [PresetName, ...PresetName[]],
);

const EntityKind = z
  .object({
    id: z
      .string()
      .regex(EntityKindIdRegex, "entity kind id must be <module>:<name>"),
    displayName: z.string().min(1),
    displayNamePlural: z.string().optional(),
    icon: z.string().optional(),
    fields: z.array(EntityField).default([]),
    // Cross-module read whitelist — see docs/architecture/entity-resolver.md.
    // Field names other modules' renderers can read via platform.entities.lookup()
    // / the resolver. The kernel projects ResolvedEntity.fields to this list
    // before returning to a foreign caller; anything not declared is private
    // to the owning module.
    //
    // Implicit always-exposable: `id`, `title`, `subtitle`, `image_path`,
    // `detailUrl` (the cross-cutting display props on ResolvedEntity itself).
    //
    // Default behaviour when omitted: legacy — full ResolvedEntity.fields
    // is returned and a one-time deprecation warning is logged per kind.
    // New modules SHOULD declare exposableFields.
    exposableFields: z.array(z.string().min(1)).optional(),
    // Per-field read-scope (H2): map a field name to the capability
    // (action_id) a viewer must hold to read it. Layered ON TOP of
    // exposableFields — a field must be exposable AND (if listed here)
    // the viewer must hold its capability, else the kernel omits it
    // from the read. Owner/admin and viewer-less internal reads see
    // everything; the member-facing views/portal path passes the
    // viewer. Enables tiered member access ("Tier 1 sees parts, not
    // prices"). The capability should be a grantable action so admins
    // can assign it via roles / the permission matrix.
    fieldReadScopes: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Path template (relative to PUBLIC_BASE_URL) for the entity's
    // canonical detail page. {id} placeholder gets substituted.
    detailRoute: z.string().optional(),
    // Module-relative GET endpoint for lookup. {id} placeholder.
    // The platform proxies to this when other modules ask for the
    // entity's data via platform.entities.lookup().
    getEndpoint: z.string().optional(),
    version: z.string().optional(),
    // Cross-module trait declarations. Three mutually-exclusive
    // forms:
    //   1. raw — `traits: { tangibility: "physical", ... }`
    //   2. preset — `profile: "owned-thing"`
    //   3. preset + override — `profile: "owned-thing", overrides: { lifecycle: "completable" }`
    // `defineModule()` resolves form 2/3 into form 1 at load time so
    // downstream code only ever reads `traits`.
    traits: RawTraits.optional(),
    profile: PresetNameSchema.optional(),
    overrides: RawTraits.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.traits && data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': cannot use both 'traits' (raw) and 'profile' (preset) at once — pick one`,
        path: ["profile"],
      });
    }
    if (data.overrides && !data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': 'overrides' only makes sense alongside 'profile'`,
        path: ["overrides"],
      });
    }
    // exposableFields must reference declared field names (or the
    // implicit-always-exposable cross-cutting props on ResolvedEntity).
    if (data.exposableFields) {
      const declared = new Set(data.fields.map((f) => f.name));
      const implicit = new Set([
        "id",
        "title",
        "subtitle",
        "image_path",
        "detailUrl",
      ]);
      for (const name of data.exposableFields) {
        if (!declared.has(name) && !implicit.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': exposableFields references '${name}' which is neither a declared field nor an implicit cross-cutting prop (id/title/subtitle/image_path/detailUrl)`,
            path: ["exposableFields"],
          });
        }
      }
    }
    // fieldReadScopes keys must be declared fields, and a gated field
    // should also be exposable — gating a field the whitelist already
    // hides is a no-op and almost always a mistake.
    if (data.fieldReadScopes) {
      const declared = new Set(data.fields.map((f) => f.name));
      const exposable = data.exposableFields
        ? new Set(data.exposableFields)
        : null;
      for (const name of Object.keys(data.fieldReadScopes)) {
        if (!declared.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}', which is not a declared field`,
            path: ["fieldReadScopes"],
          });
        } else if (exposable && !exposable.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}' but it isn't in exposableFields, so the whitelist already hides it — add it to exposableFields or drop the scope`,
            path: ["fieldReadScopes"],
          });
        }
      }
    }
  });

// ─────────────────────── Pillar B: actions ─────────────────────────
//
// Modules declare what they can do TO entities. Actions list the
// kinds they apply to — either by explicit ID, or by predicate
// ({ any: true } / { hasFieldRole: 'title' }).

// ─────────────────────── Wire target (Q1) ─────────────────────────
//
// What the wire fires the action on. Two forms:
//   - "self" (or omitted) — action runs on the source entity. The
//     no-target-declared default; preserves today's fire-on-source
//     behaviour.
//   - { rel, dir?, kind? } — action runs on entities discovered by
//     walking entity_pairings from the source. `rel` is required;
//     `dir` defaults to "in" (incoming pairings — find things that
//     point AT the source via this relation); `kind` filters target
//     kinds when one source pairs with multiple kinds via the same
//     relation.
// See docs/architecture/wires-and-bundles.md (Q1, resolved).
export const WireTarget = z.union([
  z.literal("self"),
  // "none": the wire fires with NO entity context — for trigger events
  // that don't originate from an entity (e.g. an inbound webhook). The
  // action locates its own target from its (template-rendered) args;
  // templates see only the event.* block. See wires-and-bundles.md.
  z.literal("none"),
  z.object({
    rel: z.string().min(1),
    dir: z.enum(["in", "out"]).optional(),
    kind: z.string().optional(),
  }),
]);

export type WireTargetDecl = z.infer<typeof WireTarget>;

// Action predicate. Either {any: true} (universal) or a structured
// predicate combining kinds + traits + hasFieldRole. Across the three
// sub-predicates the semantics is OR (any one hitting matches); within
// `traits` the semantics is AND (all listed traits must be present).
//
// Examples:
//   { kinds: ["projects:task"] }
//     → only this exact kind
//   { traits: ["physical"] }
//     → any entity kind whose trait fingerprint includes "physical"
//   { traits: ["physical", "fungible"] }
//     → both required (Stock material profile only)
//   { traits: ["physical"], kinds: ["projects:task"] }
//     → any physical thing OR specifically this task kind
//   { hasFieldRole: "title" }
//     → any kind that declared a field with role=title
const ActionAppliesTo = z.union([
  z.object({ any: z.literal(true) }),
  z
    .object({
      kinds: z.array(z.string()).min(1).optional(),
      traits: z.array(z.string()).min(1).optional(),
      hasFieldRole: EntityFieldRole.optional(),
    })
    .refine(
      (d) => d.kinds || d.traits || d.hasFieldRole,
      "appliesTo: must specify at least one of kinds, traits, or hasFieldRole (or use { any: true } for universal match)",
    ),
]);

export const ActionIdRegex = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

const EntityAction = z.object({
  id: z
    .string()
    .regex(ActionIdRegex, "action id must be <module>:<name>"),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  appliesTo: ActionAppliesTo.default({ any: true }),
  // Whether this action renders as a clickable button on entity-
  // detail pages. Default true. Set false for wire-only actions
  // (event reactions) — they're still targetable by wires, just
  // not surfaced as a manual button.
  userInvokable: z.boolean().default(true),
  // UI route the platform navigates to when the user clicks the
  // action. {entityKind}, {entityId} placeholders.
  invokeRoute: z.string().optional(),
  // Handler key the module registered via
  // platform.actions.registerHandler() at boot. Optional — actions
  // can be route-only.
  invokeHandler: z.string().optional(),
  // Optional machine-readable arg shape. Keys are the arg names the
  // invokeHandler reads from ctx.args; each has a label + a primitive
  // type. The wire composer renders a labelled field per arg (each value
  // a literal or a {{token}}); the wire engine renders string args at
  // fire time. Absent → the composer falls back to a free template.
  argsSchema: z
    .record(
      z.object({
        label: z.string().min(1),
        type: z.enum(["text", "number", "boolean"]).default("text"),
      }),
    )
    .optional(),
  version: z.string().optional(),
});

const ModuleManifest = z.object({
  // Stable identifier — must be unique across the platform, used as
  // the table prefix and the URL segment under /api/v1/modules/.
  // Module name doubles as a URL segment + a key in module_field_defs.source_module
  // etc. Leading digit allowed so names like "3d-printers" work; everything must
  // still be kebab/snake-case ascii.
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be kebab/snake-case ascii"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver-ish"),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  // Module band — see docs/architecture/module-layers.md.
  //   foundational: platform can't work without it (very small set;
  //                  no per-workspace disable toggle)
  //   stock:        ships in the default Cobblr install + default-enabled,
  //                  toggleable per workspace. The Apple-first-party-app
  //                  band (gold, but deletable).
  //   marketplace:  community-authored, downloadable, requires explicit
  //                  install. Future tense — band exists in the model so
  //                  we don't have to redesign when it ships.
  //   user:         custom-built for one specific app — companion app's
  //                  workshop-mods, a homestead app's livestock module.
  // Default 'user' so any module without a declared band lands in the
  // most-conservative bucket (user-controlled, freely toggleable).
  // Maintainers curate which modules are *actually* foundational /
  // stock; declaring band: 'foundational' in an unrelated user module
  // is informational only — the platform won't treat it as such unless
  // it's also in the curated foundational list (see module-layers.md
  // §"Foundational modules — the strict-test band").
  band: z.enum(["foundational", "stock", "marketplace", "user"]).default("user"),

  // Capability vs. domain. A *capability* module is ambient plumbing that
  // makes other things work (views, search, scan, ai, recurrence, …) — it
  // has no decision content ("do you want search?") and no behavioural
  // side-effects until used, so it's enabled for every new workspace
  // automatically. A *domain* / connector module (inventory, machines,
  // digifab, …) adds nav nouns + per-user relevance, so it stays an
  // explicit opt-in (the module picker / "+ New thing" funnel). Foundational
  // modules are always-on regardless; this flag is for the stock band.
  // See docs/architecture/module-layers.md.
  autoEnable: z.boolean().default(false),

  // Whether a workspace can install this module multiple times under
  // different "instance" names. "multi" modules add an `instance`
  // column to their tables (via a migration) and gain instance-
  // scoped routes at /orgs/:slug/instances/<name>/items. "single"
  // modules (default) install once per workspace; their default
  // instance name is implicitly the module name. Foundational
  // modules are always 'single' regardless of declaration.
  // See docs/architecture/instances.md.
  instanceability: z.enum(["single", "multi"]).default("single"),

  // Modules this module OPERATES ON — an opt-in operator/capability
  // (digifab sends files to machines' managers; labels prints labels for
  // inventory/assets/machines) rather than a kind of thing you track.
  // A non-empty list means "not a trackable kind": the new-workspace
  // funnel's "Track a kind of thing" column excludes it and offers it as
  // a capability instead. Promotes the funnel's interim OPERATES_ON UI
  // map to declared manifest data — option (a)→(c) in
  // docs/design-decisions/what-to-do-funnel.md.
  operatesOn: z.array(z.string()).default([]),

  // Optional icon-only quick-action pinned to the navbar's RIGHT
  // cluster — a module's single most-used action that earns prime,
  // always-visible placement (e.g. core-scan's camera button, which a
  // companion app user hits constantly). Rendered only while the module
  // is enabled. Distinct from `ui.navItems` (the left-nav text links):
  // this is the one critical icon, not a page entry.
  headerAction: z
    .object({
      /** Kebab-case lucide icon name, e.g. "scan-line" / "camera". */
      icon: z.string().min(1),
      /** Tooltip + aria-label (icon-only, so this is the only text). */
      label: z.string().min(1),
      /** Web route to navigate to on click. */
      route: z.string().min(1),
    })
    .optional(),

  // Optional. Pillar-E specialisation modules (3d-printers,
  // workshop-mods, etc.) often have NO tables of their own — they
  // only contribute field-defs/wires to entity kinds owned by a
  // depended-on base module. Such modules omit `schema` entirely.
  schema: z
    .object({
      tablePrefix: z.string().regex(/^[a-z][a-z0-9_]*_$/, "tablePrefix must end with _"),
      migrationsDir: z.string().min(1),
    })
    .optional(),

  // The api/ui imports are functions returning a dynamic import so
  // the loader can decide when to evaluate them (and so modules can
  // be lazily code-split in the web bundle).
  api: z.function().returns(z.promise(z.unknown())).optional(),
  ui: z
    .object({
      navItems: z.array(NavItem).default([]),
      components: z.function().returns(z.promise(z.unknown())).optional(),
    })
    .optional(),

  intents: z.array(Intent).default([]),
  dependencies: z.array(z.string()).default([]),
  exposes: z
    .object({
      events: z.array(z.string()).default([]),
      api: z.array(z.string()).default([]),
      actions: z.array(EntityAction).default([]),
    })
    .default({ events: [], api: [], actions: [] }),
  // Pillar A — entity kinds the module provides for the rest of
  // the platform to introspect.
  provides: z
    .object({
      entityKinds: z.array(EntityKind).default([]),
    })
    .default({ entityKinds: [] }),
  // Pillar E — module composition. A module can declare field-defs
  // and wires that target entity kinds owned by OTHER (depended-on)
  // modules. When this module is enabled for an org, the platform
  // applies these contributions to module_field_defs /
  // entity_action_bindings with source_module set to the module's
  // name. Disabling the module cleans them up.
  contributes: z
    .object({
      fieldDefs: z
        .array(
          z.object({
            entity_kind: z.string(),
            name: z.string().regex(/^[a-z][a-z0-9_]*$/),
            display_label: z.string().min(1),
            type: z.enum(["text", "number", "boolean", "date", "url"]),
            required: z.boolean().optional(),
            position: z.number().int().optional(),
            choices: z.array(z.string()).optional(),
            /** Built-in renderer id — color-hex / image-url /
             *  url-link / year / boolean / code / text. The web UI
             *  switches on this when drawing the value. */
            renderer: z
              .enum(["text", "color-hex", "image-url", "url-link", "year", "boolean", "code"])
              .optional(),
          }),
        )
        .default([]),
      wires: z
        .array(
          z.object({
            source_kind: z.string(),
            action_id: z.string(),
            trigger_type: z
              .enum(["user-invoked", "event", "on-create", "on-update", "on-delete"])
              .default("user-invoked"),
            trigger_event: z.string().optional(),
            template: z.string().optional(),
            // Q1 wire target. Omit (or "self") → action runs on the
            // source entity (default). Object form opts into cross-
            // module pairing traversal: action runs on each entity
            // discovered by walking entity_pairings from the source.
            // `dir` defaults to "in" (incoming — find things that
            // point AT the source via this relation). `kind` filters
            // the discovered target kind when one source pairs with
            // multiple kinds via the same relation.
            // See docs/architecture/wires-and-bundles.md (Q1).
            target: WireTarget.optional(),
          }),
        )
        .default([]),
    })
    .default({ fieldDefs: [], wires: [] }),
  subscribes: z.array(z.string()).default([]),

  // Lifecycle hooks — let a module register background work the
  // platform can't otherwise see. Both are dynamic imports (same
  // pattern as `api`/`ui.components`) so the loader controls when
  // they're evaluated.
  //
  // onBoot: runs after every module is mounted, immediately before
  //   app.listen. Awaited; a thrown error is logged + skipped (the
  //   process keeps booting — a stuck onBoot can't take down the
  //   whole platform). Use for: starting a scheduler, registering
  //   background subscribers, warming a cache.
  // onShutdown: runs on SIGINT/SIGTERM before server.close. Awaited
  //   with a short budget. Use for: stopping intervals, flushing
  //   in-flight work.
  //
  // Both are `() => Promise<unknown>` so the module's import lives
  // in its own bundle — no transitive load of every module's
  // implementation just to read the manifest.
  lifecycle: z
    .object({
      onBoot: z.function().returns(z.promise(z.unknown())).optional(),
      onShutdown: z.function().returns(z.promise(z.unknown())).optional(),
    })
    .optional(),
});

export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModuleIntent = z.infer<typeof Intent>;
export type EntityKindDecl = z.infer<typeof EntityKind>;
export type EntityFieldDecl = z.infer<typeof EntityField>;
export type EntityActionDecl = z.infer<typeof EntityAction>;
export type ActionAppliesToDecl = z.infer<typeof ActionAppliesTo>;

/**
 * Builder for a module's default export. Validates the manifest at
 * load time — invalid shape throws with a readable message before
 * the module is registered. Returns the validated manifest, typed.
 *
 * Usage in a module:
 *   export default defineModule({ name: "inventory", ... });
 */
export function defineModule(manifest: z.input<typeof ModuleManifest>): ModuleManifest {
  const result = ModuleManifest.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid module manifest for "${
        (manifest as { name?: unknown }).name ?? "<unnamed>"
      }":\n${issues}`,
    );
  }

  // Resolve preset + overrides into the canonical raw form, so
  // downstream code (registry sync, action matching, UI rendering)
  // can always read `traits` directly. `profile` and `overrides` are
  // preserved on the entry for introspection / tooling.
  const resolved = result.data;
  for (const kind of resolved.provides.entityKinds) {
    if (kind.profile) {
      const base = TRAIT_PRESETS[kind.profile];
      kind.traits = { ...base, ...(kind.overrides ?? {}) };
    }
  }

  return resolved;
}

/** Resolve preset+overrides into the 6-tuple. Exposed for tooling
 *  (CLI, debug endpoints) that needs the same expansion logic as
 *  defineModule() outside the module-loading path. */
export function resolveTraits(decl: {
  traits?: RawTraitsDecl;
  profile?: PresetName;
  overrides?: RawTraitsDecl;
}): RawTraitsDecl | undefined {
  if (decl.traits) return decl.traits;
  if (decl.profile) {
    const base = TRAIT_PRESETS[decl.profile];
    return { ...base, ...(decl.overrides ?? {}) };
  }
  return undefined;
}

// ──────────────────────── Platform runtime ────────────────────────
//
// Modules don't import from the api workspace directly — that'd
// couple them to the platform implementation. Instead, the api
// registers an implementation of the Platform interface at boot
// via setPlatform(), and modules read it via platform().
//
// Surface starts small (activity + events). It will grow as
// connectors hit real needs.

export interface ActivityRef {
  /** Module name, or `null` for platform-level events. */
  module: string | null;
  entityType: string;
  entityId: string;
}

export interface ActivityLogParams {
  orgId: string;
  userId: string | null;
  action: string;
  ref: ActivityRef;
  diff?: unknown;
}

export interface PlatformActivity {
  log(p: ActivityLogParams): Promise<void>;
}

export type EventHandler = (payload: unknown) => void | Promise<void>;

export interface PlatformEvents {
  /** Emit an event. Returns a Promise that resolves once any wires
   *  (user-configured entity_action_bindings) for the event have
   *  finished firing. Direct subscribers registered via on() still
   *  run on the next microtask tick (fire-and-forget). A caller can:
   *    • `await emit(...)` — wait for wires before returning a
   *      response (sync read-after-write semantics for the user)
   *    • `emit(...)` (no await) — fire-and-forget; the wires
   *      still run, the caller just doesn't wait. */
  emit(eventName: string, payload: unknown): Promise<void>;
  /** Subscribe a handler to an event. The module name is captured
   *  for diagnostics — failures get logged with which module's
   *  handler threw. Subscribers run asynchronously on the next
   *  microtask tick so emitters don't block on them. */
  on(eventName: string, module: string, handler: EventHandler): void;
}

/** Tenant-DB accessor for background work that doesn't have a
 *  request context (event handlers, scheduled jobs, etc.). The
 *  returned value is a Kysely instance — typed loosely here so the
 *  platform-contract doesn't need to know about every module's
 *  schema. Callers cast to their own schema type. */
export interface PlatformTenants {
  getDb(orgId: string): Promise<unknown>;
  /** Release this tenant's connection pool — but ONLY if it currently has
   *  no checked-out clients (all connections idle, none waiting). The pool
   *  reopens lazily on the next `getDb`. No-op if the org has no cached pool.
   *
   *  For background jobs that sweep EVERY tenant on a tick (due-soon,
   *  recurrence, expiry): without this, each org's pool stays cached open
   *  with a live connection, so one tick holds one pool per tenant and a
   *  box with many tenants exhausts Postgres `max_connections` ("remaining
   *  connection slots are reserved for SUPERUSER"). Call it after finishing
   *  each org to keep the sweep's peak at ~one tenant pool. The idle guard
   *  makes it safe against concurrent request traffic — a pool a live
   *  request is mid-flight on is left untouched. */
  releaseIdleDb(orgId: string): Promise<void>;
}

/** Cross-tenant DB access for the (small set of) modules that need
 *  to read or write platform-level tables (entity_action_bindings,
 *  wire_schedule_state, org_modules, etc.). Typed as `unknown` — the
 *  caller casts to a Kysely<schema> using a narrow structural type
 *  for just the tables it touches, same way `PlatformTenants.getDb`
 *  works for tenant DBs.
 *
 *  Modules touching this are limited: scheduler-style ("which wires
 *  fire when?"), platform observability ("what's enabled across all
 *  orgs?"). Day-to-day module work should stay on tenant DBs. */
export interface PlatformDb {
  meta: unknown;
}

// ──────────────── Pillar A runtime — entities ──────────────────────

/** Generic entity data returned to other modules. Module-private
 *  columns aren't here — only fields declared on the kind's manifest
 *  with role: 'title' / 'subtitle' / etc., plus the raw field map.
 *  Callers should rely on roles to render generically. */
export interface ResolvedEntity {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  /** All declared fields, key → value. Numbers come back as numbers,
   *  strings as strings — modules cast as needed. */
  fields: Record<string, unknown>;
}

/** Module-side resolver for an entity kind. Registered at module
 *  boot. The platform calls these in-process; no HTTP loopback. */
export type EntityResolver = (
  orgId: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Comparison-operator predicate for the `where` field of
 *  EntityListQuery. Supports literal comparisons, column-to-column
 *  comparisons (`{ ref_col }`), and the `'now'` sentinel for date
 *  columns (resolver substitutes `now()`).
 *
 *  Examples (workshop demos):
 *    { col: 'qty', op: '<', ref_col: 'min_qty' }   // low-stock
 *    { col: 'due_date', op: '<=', value: 'now' }    // overdue tasks
 *    { col: 'created_at', op: '>=', value: '2026-01-01' }
 *
 *  Resolvers ignore predicates they don't understand (unknown col,
 *  unsupported op for that column's type) so a config that's too
 *  aggressive degrades to "no extra filter" rather than 500ing. */
export interface FilterPredicate {
  col: string;
  op: "<" | "<=" | ">" | ">=" | "=" | "!=";
  /** Literal value. Use the string `'now'` for current timestamp on
   *  date/timestamptz columns. Mutually exclusive with `ref_col`. */
  value?: string | number | boolean | null;
  /** Compare against another column on the same row (low-stock-style
   *  qty < min_qty). Mutually exclusive with `value`. */
  ref_col?: string;
}

/** Query passed to a list resolver — generic primitives so the
 *  resolver implementation can decide how to apply them. Modules
 *  may safely ignore filter keys they don't support; core-views
 *  surfaces the supported set to the user via the view config. */
export interface EntityListQuery {
  /** Hard cap. Resolvers default to a sensible limit when omitted. */
  limit?: number;
  /** Offset-based pagination. Cursor-based variants can be added
   *  later once a v0.1 view actually needs them. */
  offset?: number;
  /** Field-name → value(s). Resolver decides operator (typically
   *  equality for scalars, IN for arrays). Unknown keys are ignored.
   *  Conventions:
   *    filter._tag = '<name>'  → entities carrying that tag
   *    filter.<other key>      → equality on a native column OR a
   *                              metadata-JSON field if no native
   *                              match (resolver decides) */
  filter?: Record<string, unknown>;
  /** Comparison predicates beyond equality. Each predicate AND'd
   *  together. Resolvers may support a subset of (col, op) pairs;
   *  unsupported ones are ignored. See FilterPredicate for examples. */
  where?: FilterPredicate[];
  /** Free-text — full-text-ish search, scoped to the resolver's
   *  judgement of what's searchable on the kind. */
  q?: string;
  /** Sort spec: array of `field` or `-field` (prefix `-` for desc). */
  sort?: string[];
}

export interface EntityListResult {
  items: ResolvedEntity[];
  /** Total matching rows ignoring limit/offset — optional because
   *  count-queries on large tables can be expensive. */
  total?: number;
}

/** Module-side list resolver for an entity kind. Optional — kinds
 *  without one return { items: [] } from list(). Same projection
 *  rules as single-hop lookup: each item is filtered through the
 *  kind's exposableFields when the caller is outside the owning
 *  module (the platform handles the projection — resolver returns
 *  the full row). */
export type EntityListResolver = (
  orgId: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Module-side list resolver for the items of ANY instance of a multi-instance
 *  module. Registered once per module (not per instance); the platform calls it
 *  for `<instance_name>:item` kinds, resolving the instance→module via the
 *  workspace_module_instances table. Lets views/search/data/calendar see
 *  instance entities through the generic layer. Same projection rules as
 *  EntityListResolver. */
export type EntityInstanceListResolver = (
  orgId: string,
  instance: string,
  query: EntityListQuery,
) => Promise<EntityListResult>;

/** Single-entity resolver for the items of ANY of a module's instances. The
 *  platform calls it for a `<instance_name>:item` LOOKUP when no exact resolver
 *  is registered (resolving instance→module), so a detail/lookup of an instance
 *  item resolves + gets computed fields the same as the base kind. Modules
 *  register once (not per instance). The single-entity twin of
 *  EntityInstanceListResolver. */
export type EntityInstanceResolver = (
  orgId: string,
  instance: string,
  id: string,
) => Promise<ResolvedEntity | null>;

/** Tier-2 context provider for computed fields. Given an entity, returns
 *  a namespaced bag of related/aggregated data referenced in a computed
 *  template as {{<namespace>.<key>}}. Best-effort: a throw renders the
 *  namespace empty rather than failing the whole resolve. */
export type ComputedContextProvider = (
  orgId: string,
  kind: string,
  id: string,
) => Promise<Record<string, unknown>>;

/** Context for resolving create-time field defaults. The kernel passes who is
 *  creating + what kind; a provider returns a partial of that kind's OWN
 *  fields. See PlatformEntities.registerCreateDefaults. */
export interface CreateDefaultsContext {
  orgId: string;
  /** The user creating the entity — many defaults are per-user (e.g. presence
   *  defaults a location from where the user is). Undefined for system / token
   *  callers; a provider should no-op when it needs a user and there is none. */
  userId?: string;
  /** The kind being created, e.g. "core-scan:item" / "inventory:part". */
  kind: string;
  /** Field values the caller already has (client-supplied). Providers may read
   *  these; the kernel never overrides a supplied value — defaults only fill
   *  keys the caller left unset (see resolveCreateDefaults). */
  supplied?: Record<string, unknown>;
}

/** A module's contribution of create-time defaults for one kind. Returns a
 *  partial of the kind's fields (by the kind's OWN field names). Best-effort:
 *  a throw is swallowed and contributes nothing. Provider-agnostic — presence,
 *  a GPS source, a manual room-pin all register the same way; the create path
 *  never imports any of them. */
export type CreateDefaultsProvider = (
  ctx: CreateDefaultsContext,
) => Promise<Record<string, unknown>>;

/** A device reading to apply to a linked entity. core-devices resolves the
 *  (connection, device) → entity link + mode, then asks the entity-OWNING
 *  module how that mode maps to one of ITS OWN actions — so core-devices never
 *  hardcodes the entity side and the owner never hardcodes the device side.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded
 *  `if (kind === "inventory:part")` branch in core-devices.) */
export interface DeviceApplyContext {
  /** The link's mode, e.g. "set" | "add". The owning module decides support. */
  mode: string;
  /** The reading's numeric value (null when the payload had none). */
  value: number | null;
  /** The target entity id (within the owner's kind). */
  entityId: string;
  /** Reason string to thread into the action (e.g. "device:scale-1"). */
  reason: string;
}

/** Maps a device reading to ONE of the owning module's actions. Returns the
 *  action id + args for core-devices to invoke (with its device-event context),
 *  or null if the module doesn't support that mode. */
export type DeviceApplyProvider = (
  ctx: DeviceApplyContext,
) => { actionId: string; args: Record<string, unknown> } | null;

/** What an entity-owning module declares so core-scan can treat its kind as a
 *  scan target — WITHOUT core-scan hardcoding a per-kind allowlist / endpoint /
 *  field map. Registered at boot via platform().entities.registerScannable.
 *  (Audit 2026-06-26 follow-up — replaces the hardcoded SCANNABLE set +
 *  KIND_CREATE_ENDPOINTS + KIND_QTY_FIELD maps in core-scan.) */
export interface ScannableInfo {
  /** Singular noun for the scan UI / routing ("part", "asset", "machine"). */
  noun: string;
  /** Module HTTP path a confirmed scan POSTs to (under
   *  /api/v1/orgs/:slug/modules/), e.g. "inventory/parts". */
  createEndpoint: string;
  /** The create body's quantity field name ("qty" | "quantity"). */
  qtyField: string;
  /** Marks this the fallback scan target when no identify hint matches a noun
   *  (at most one should set it). Lets core-scan route an unhinted scan without
   *  hardcoding a default module. */
  default?: boolean;
}

/** In-process create/update/delete for one kind, registered by the owning
 *  module. The WRITE counterpart to EntityResolver — used by cross-module
 *  writers (the sync engine) that have no HTTP request / user token. The
 *  writer resolves its own tenant db from orgId and runs the module's own
 *  validation + events. */
export interface EntityWriter {
  /** Create an entity; returns the new entity's id. */
  create(orgId: string, fields: Record<string, unknown>): Promise<string>;
  update(orgId: string, id: string, fields: Record<string, unknown>): Promise<void>;
  delete(orgId: string, id: string): Promise<void>;
  /** Optional: existing entities of this kind, for a natural-key match during
   *  an import preview — so a one-time import MERGES a source record into an
   *  already-present row (same name) instead of duplicating it. Without this,
   *  an importer treats every unmapped source record as a brand-new create. */
  listForMatch?(
    orgId: string,
  ): Promise<Array<{ id: string; name: string; parentId?: string | null }>>;
  /** Optional: read an entity's current fields, so an import preview can show the
   *  both-sides diff (what's there now vs what the source would write). */
  read?(orgId: string, id: string): Promise<Record<string, unknown> | null>;
}

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Register an in-process WRITER for one kind (create/update/delete).
   *  Lets cross-module writers (the sync engine) mutate this kind without
   *  an HTTP loopback or user token. */
  registerWriter(kind: string, writer: EntityWriter): void;
  /** Resolve a registered writer for a kind, or null. */
  getWriter(kind: string): EntityWriter | null;
  /** Register a list-resolver for a kind. Optional — without one,
   *  list() returns an empty result. Modules opt in when they want
   *  their kind to appear in core-views, search results, etc. */
  registerListResolver(kind: string, resolver: EntityListResolver): void;
  /** Register a list-resolver for the items of any instance of a multi-instance
   *  module (keyed by module name). The platform invokes it for
   *  `<instance_name>:item` kinds. Lets instance entities appear in
   *  views/`data`/search/calendar through the generic layer. */
  registerInstanceListResolver(
    moduleName: string,
    resolver: EntityInstanceListResolver,
  ): void;
  /** Register a single-entity resolver for the items of any instance of a
   *  multi-instance module (keyed by module name). The platform invokes it for a
   *  `<instance_name>:item` LOOKUP when no exact resolver matches, so an instance
   *  item's detail/lookup resolves + computes fields like the base kind. */
  registerInstanceResolver(
    moduleName: string,
    resolver: EntityInstanceResolver,
  ): void;
  /** Register a tier-2 context provider for COMPUTED fields, under a
   *  namespace. A computed field def (type='computed') references it in
   *  its template as {{<name>.<key>}}; the kernel invokes the provider at
   *  entity-resolve time only when some computed template on the kind
   *  actually uses the namespace. Keeps computed fields modular — the
   *  field layer never imports any specific module.
   *
   *  Example (in modules/core-maintenance):
   *    platform().entities.registerComputedContext(
   *      "maintenance",
   *      async (orgId, kind, id) => {
   *        // kind "assets:asset" → entity_module "assets", type "asset"
   *        return { last_performed, last_performed_at, next_scheduled_at };
   *      },
   *    ); */
  registerComputedContext(name: string, provider: ComputedContextProvider): void;
  /** Register a provider of create-time field defaults for a kind. The
   *  provider-agnostic seam behind "default a field from context on create" —
   *  e.g. a presence module defaulting `scan_area`/`location_id` from the room
   *  the user is in. Many modules may register for the same kind; the create
   *  handler calls resolveCreateDefaults() before insert and applies the result
   *  ONLY to fields the caller left unset, so an explicit client value always
   *  wins. The create path never imports the provider's module.
   *
   *  Example (in a presence module):
   *    platform().entities.registerCreateDefaults("core-scan:item",
   *      async ({ userId }) => {
   *        const room = userId ? await currentRoom(userId) : null;
   *        return room ? { scan_area: room } : {};
   *      }); */
  registerCreateDefaults(kind: string, provider: CreateDefaultsProvider): void;
  /** Remove a previously-registered create-defaults provider (by reference).
   *  Mainly for tests / hot-reload symmetry. */
  unregisterCreateDefaults(kind: string, provider: CreateDefaultsProvider): void;
  /** Register how a device reading on this kind maps to one of the module's
   *  OWN actions (e.g. inventory maps set/add → set-stock/adjust-stock). Lets
   *  core-devices apply a reading without knowing any entity module — and the
   *  isolation lint can't be fooled by a hardcoded `kind === "…"` branch.
   *  Example (in modules/inventory):
   *    platform().entities.registerDeviceApply("inventory:part", (ctx) =>
   *      ctx.mode === "set" && typeof ctx.value === "number"
   *        ? { actionId: "inventory:set-stock",
   *            args: { partId: ctx.entityId, qty: ctx.value, reason: ctx.reason } }
   *        : null); */
  registerDeviceApply(kind: string, provider: DeviceApplyProvider): void;
  /** Resolve a device reading to {actionId,args} via the kind's registered
   *  provider, or null when none is registered / the mode is unsupported. */
  applyDevice(
    kind: string,
    ctx: DeviceApplyContext,
  ): { actionId: string; args: Record<string, unknown> } | null;
  /** Declare a kind as a scan target (core-scan reads this instead of a
   *  hardcoded allowlist). Called at boot by the owning module, e.g.
   *  platform().entities.registerScannable("inventory:part",
   *    { noun: "part", createEndpoint: "inventory/parts", qtyField: "qty" }). */
  registerScannable(kind: string, info: ScannableInfo): void;
  /** The scan info for a kind, or null if it isn't a scan target. */
  getScannable(kind: string): ScannableInfo | null;
  /** Every registered scan target as { kind, ...info } — core-scan builds its
   *  scan menu from this (which modules/kinds are scannable + their nouns). */
  listScannable(): Array<{ kind: string } & ScannableInfo>;
  /** Run every registered provider for `ctx.kind` and return the merged
   *  defaults. The FIRST provider to set a key wins (deterministic); a provider
   *  that throws contributes nothing; null/undefined values are skipped.
   *  Returns {} when no provider is registered — so calling this is a no-op for
   *  kinds nobody augments. The CALLER applies the result; the convention is
   *  client-supplied value wins, default fills the gap. */
  resolveCreateDefaults(ctx: CreateDefaultsContext): Promise<Record<string, unknown>>;
  /** Look up one entity by (kind, id). Returns null if the kind
   *  has no resolver (module not enabled) or the entity doesn't
   *  exist. Projects through the kind's exposableFields whitelist.
   *
   *  `viewer.userId` is used by the M1 v0.5 per-link role gate:
   *  cross-workspace fall-through respects `min_target_role` on
   *  workspace_links. Omit for system / anonymous callers — only
   *  unrestricted links qualify in that case. */
  lookup(
    orgId: string,
    kind: string,
    id: string,
    viewer?: { userId?: string; publicRead?: boolean },
  ): Promise<ResolvedEntity | null>;
  /** List entities of a kind. Returns { items: [] } when no list
   *  resolver is registered. Each item is projected through the
   *  kind's exposableFields when callers are outside the owning
   *  module — same projection rule as lookup().
   *
   *  See lookup() for viewer semantics — same gate applies to the
   *  cross-workspace union.
   *
   *  H2 — per-field read-scope: pass the viewer's identity
   *  (`userId` + `role`) and the kernel resolves their effective
   *  capabilities, dropping any field the viewer lacks the capability
   *  for. Owner/admin see everything; omitting the viewer entirely
   *  (trusted internal / admin-module reads) also sees everything; a
   *  member-facing caller passes the viewer so "Tier 1 sees parts, not
   *  prices" is enforced at the read boundary. */
  list(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: { userId?: string; role?: string; publicRead?: boolean },
  ): Promise<EntityListResult>;
  /** Batched lookup — resolve N (kind, id) refs in one call. Foreign
   *  callers that need joined data should use this instead of N
   *  separate single-hop calls. Same projection rules as lookup().
   *  Refs that don't resolve are silently skipped (callers get fewer
   *  results than they asked for, matchable by kind+id). Order is
   *  not guaranteed. */
  lookupMany(
    orgId: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
  ): Promise<ResolvedEntity[]>;
  /** core-resolver v0.1: multi-hop pairing walk.
   *
   *  Chains N hops through entity_pairings. Each hop has the same
   *  shape walkPairings accepts (rel + dir + optional kind filter).
   *  All hops batch their SQL: one query per hop, not one per
   *  intermediate row. Dedups duplicate (kind, id) refs along the
   *  way. Returns the resolved entities at the END of the path,
   *  all projected through exposableFields.
   *
   *  Example: part → [used-by] → task → [child-of] → project
   *  resolves a part's downstream projects in two batched calls.
   *
   *  `opts.maxPerHop` (default 500) bounds the working set per hop
   *  so a path with explosive fanout doesn't OOM. */
  walkPath(
    orgId: string,
    source: { kind: string; id: string },
    hops: Array<{ rel: string; dir?: "in" | "out"; kind?: string }>,
    opts?: { maxPerHop?: number },
  ): Promise<ResolvedEntity[]>;
  /** Walk entity_pairings from a source and return resolved + projected
   *  target entities. dir defaults to "in" (incoming — find things that
   *  POINT AT the source via this relation). kind filters discovered
   *  targets. The kernel half of the entity-resolver design — see
   *  docs/architecture/entity-resolver.md. */
  walkPairings(
    orgId: string,
    source: { kind: string; id: string },
    spec: { rel: string; dir?: "in" | "out"; kind?: string },
  ): Promise<ResolvedEntity[]>;
  /** List all declared kinds from cobblr_meta.entity_kinds. */
  listKinds(): Promise<EntityKindRecord[]>;
  /** Get a single kind's full declaration. */
  getKind(kind: string): Promise<EntityKindRecord | null>;
}

export interface EntityKindRecord {
  id: string;
  module_name: string;
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: EntityFieldDecl[];
  detail_route: string | null;
  endpoints: { get?: string } | null;
  version: string;
  /** Resolved 6-axis trait fingerprint (or null if the kind declared
   *  no traits). Used by action matching when an action's appliesTo
   *  predicate specifies `traits: [...]`. */
  traits: RawTraitsDecl | null;
  /** Preset name (e.g. "owned-thing") if the manifest used profile
   *  shorthand. Bookkeeping for tooling. */
  profile: string | null;
  /** Cross-module read whitelist. Null = legacy (full fields returned,
   *  deprecation logged). Array = the names of fields foreign callers
   *  may read; the kernel projects ResolvedEntity.fields to this list
   *  before returning to a non-owning module. The implicit cross-cutting
   *  props (id/title/subtitle/image_path/detailUrl) are always exposable
   *  regardless of this list. See docs/architecture/entity-resolver.md. */
  exposable_fields: string[] | null;
}

// ──────────────── Pillar B runtime — actions ───────────────────────

/** Programmatic action handler. The platform routes
 *  platform.actions.invoke() calls to the right module's handler.
 *  Returns whatever the module wants — the caller might be the
 *  wire-engine running an event-triggered action, in which case
 *  the return is mostly ignored. */
export type ActionHandler = (ctx: ActionInvokeContext) => Promise<unknown>;

/** Per-request authentication context. Inherited from the originating
 *  request so wires fired async still carry the right actor (a stock
 *  bump from the UI fires wires tagged session; one from a `cbt_*`
 *  token fires wires tagged api_token with the token name). */
export interface ActionInvokeActor {
  user_id: string | null;
  display_name: string | null;
  auth_method: "session" | "api_token" | "system";
  /** Set only when `auth_method === "api_token"`; the token row id. */
  api_token_id?: string | null;
  /** Set only when `auth_method === "api_token"`; the token's name. */
  api_token_name?: string | null;
}

/** Q2 resolution: namespaced action context. Handlers receive the
 *  target entity, the originating event (or click context), and any
 *  pre-rendered template — each in its own block. The top-level
 *  `entityKind` / `entityId` aliases are deprecated compatibility
 *  shims; new handlers should read `ctx.entity.kind` / `ctx.entity.id`.
 *  See docs/architecture/wires-and-bundles.md (Q2). */
export interface ActionInvokeContext {
  orgId: string;
  userId: string | null;
  /** The entity the action runs on. For a wire with target='self',
   *  this is the source entity; for target:{rel,...} it's one of the
   *  entities discovered by walking pairings. The wire engine
   *  resolves it and projects through the kind's exposableFields. */
  entity: {
    kind: string;
    id: string;
    fields?: Record<string, unknown>;
  };
  /** The originating event / user click / schedule that triggered
   *  this invocation. Always present; the `name`/`payload` shape
   *  varies by trigger type. */
  event: {
    name: string | null; // null for user-invoked
    payload: Record<string, unknown>;
    actor: ActionInvokeActor;
    timestamp: string; // ISO-8601
    trigger_type: "event" | "user-invoked" | "schedule" | "on-create" | "on-update" | "on-delete";
  };
  /** Pre-rendered template result, if the binding had a template. */
  rendered?: string;
  /** Extra args from the binding (passed through). */
  args?: Record<string, unknown>;

  // ─── Deprecated compatibility aliases (remove in v0.3) ──────────
  /** @deprecated Use `ctx.entity.kind`. */
  entityKind: string;
  /** @deprecated Use `ctx.entity.id`. */
  entityId: string;
}

export interface PlatformActions {
  registerHandler(handlerKey: string, handler: ActionHandler): void;
  /** Find every registered action that applies to a given entity
   *  kind, factoring in `applies_to` predicates. When `orgId` is
   *  provided, per-org appliesTo overrides take precedence over the
   *  module-declared default. */
  listApplicable(kind: string, orgId?: string): Promise<EntityActionRecord[]>;
  /** Invoke an action programmatically. Throws if no handler is
   *  registered for the action's invoke_handler key. */
  invoke(actionId: string, ctx: ActionInvokeContext): Promise<unknown>;
}

export interface EntityActionRecord {
  id: string;
  module_name: string;
  label: string;
  description: string | null;
  icon: string | null;
  applies_to: ActionAppliesToDecl;
  invoke_route: string | null;
  invoke_handler: string | null;
  /** False = wire-only; don't render as a user button. */
  user_invokable: boolean;
  /** Machine-readable arg shape for the wire composer / invoke forms; null if
   *  the action declared none. */
  args_schema: Record<string, { label: string; type: "text" | "number" | "boolean" }> | null;
  version: string;
}

// ──────────────── Pillar C runtime — wires + templates ─────────────

export interface PlatformTemplates {
  /** Render a template against a flat key/value map. Supports
   *  {{key}} substitution and {{key | default: "fallback"}} for
   *  empty values. Markdown-safe (no code execution). */
  render(template: string, data: Record<string, unknown>): string;
}

export interface PlatformWires {
  /** Called by an emitting module when an event fires. The wire
   *  engine looks up matching bindings + invokes their actions. */
  fireEvent(eventName: string, orgId: string, payload: Record<string, unknown>): Promise<void>;
}

/** Health-probe primitive. Modules register a named probe at boot
 *  (typically from a lifecycle.onBoot hook); core-healthcheck
 *  aggregates them and exposes the rollup over HTTP. Each probe is
 *  a function returning a status string + an optional detail object.
 *  A probe that throws is treated as 'error' with the thrown
 *  message — the aggregator never propagates exceptions. */
export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthProbeResult {
  status: HealthStatus;
  detail?: Record<string, unknown>;
  message?: string;
}

export type HealthProbe = () => Promise<HealthProbeResult>;

export interface PlatformHealth {
  /** Register a probe by name. Idempotent — re-registering overrides
   *  the previous handler (useful for hot-reload in dev). */
  registerProbe(name: string, probe: HealthProbe): void;
  /** Snapshot all probes in parallel. Failed probes become
   *  { status: 'error', message: <err.message> } so the caller
   *  always gets a uniform shape. */
  snapshot(): Promise<Record<string, HealthProbeResult>>;
}

/** D3 — per-entity recurrence. Modules register a scanner per kind
 *  they want eligible for scheduled per-entity events. core-recurrence
 *  calls each scanner once per tick per tenant; the scanner returns
 *  rows of (entityId, rrule, title?) — module reads its own internal
 *  fields (no exposableFields projection) so private metadata is
 *  usable for scheduling.
 *
 *  Example registration (in modules/assets):
 *    platform().recurrence.registerScanner("assets:asset", async (orgId) => {
 *      const db = await platform().tenants.getDb(orgId);
 *      const rows = await db
 *        .selectFrom("assets_assets")
 *        .select(["id", "name", "metadata"])
 *        .execute();
 *      return rows
 *        .map((r) => ({
 *          entityId: r.id,
 *          rrule: (r.metadata as any)?.water_rrule,
 *          title: r.name,
 *          event: "assets.asset.recurred",
 *        }))
 *        .filter((r) => typeof r.rrule === "string" && r.rrule);
 *    });
 */
export interface RecurrentRow {
  entityId: string;
  rrule: string;
  title?: string;
  /** Event name to emit when this entity is due. Lets one kind
   *  fire different events for different sub-cases (water vs fertilize)
   *  by returning the same entity twice with different event names. */
  event: string;
}

export type RecurrenceScanner = (
  orgId: string,
) => Promise<RecurrentRow[]>;

export interface PlatformRecurrence {
  registerScanner(kind: string, scanner: RecurrenceScanner): void;
  listScanners(): Array<{ kind: string; scanner: RecurrenceScanner }>;
}

/** One dated thing on the workspace calendar — a scheduled maintenance
 *  entry, a task due date, a food item's expiry. Contributed by a module's
 *  CalendarSource; aggregated by core-calendar for the in-app month view
 *  and the iCal feed. */
export interface CalendarEvent {
  /** Stable within a source across reads — used as the iCal UID and the
   *  React key. Convention: `<source>:<entityId>:<yyyy-mm-dd>`. */
  id: string;
  title: string;
  /** ISO date ("2026-06-10") for all-day, or ISO datetime for timed. */
  date: string;
  allDay?: boolean;
  /** The contributing source's id (e.g. "maintenance", "task", "expiry"). */
  source: string;
  /** Coarse category for colour/grouping (often == source). */
  category?: string;
  /** Deep-link back to the originating entity, when there is one. */
  entityModule?: string;
  entityType?: string;
  entityId?: string;
  detailUrl?: string;
}

/** A module's contribution of dated events for a window. Called with an
 *  inclusive [fromISO, toISO] date range; returns the events in it.
 *  Best-effort: a throw is swallowed and that source contributes nothing. */
export type CalendarSource = (
  orgId: string,
  fromISO: string,
  toISO: string,
) => Promise<CalendarEvent[]>;

/** D? — workspace calendar. Modules register a source of dated events;
 *  core-calendar aggregates every registered source for the in-app month
 *  view + the tokenised iCal feed.
 *
 *  Example (in modules/core-maintenance):
 *    platform().calendar.registerSource("maintenance", async (orgId, from, to) => {
 *      // query scheduled, not-yet-done entries in [from,to]
 *      return rows.map((r) => ({ id: ..., title: r.name, date: r.scheduled_at, ... }));
 *    }); */
/** What an entity-owning module passes to register the generic "date
 *  custom-field → calendar" source for its kind. The owner supplies its OWN
 *  table; the kernel runs the generic field-def-driven query (every type='date'
 *  field on the kind + its instance kinds becomes an all-day event). Moves the
 *  table/module knowledge OUT of the kernel and INTO the owning module.
 *  (Audit 2026-06-26 follow-up — was a hardcoded SPECS list in the kernel.) */
export interface DateFieldCalendarSpec {
  /** Base entity kind, e.g. "inventory:part". */
  kind: string;
  /** The module's own table for that kind, e.g. "inventory_parts". */
  table: string;
  /** Module name for the event source/category, e.g. "inventory". */
  entityModule: string;
  /** Entity type for the event payload, e.g. "part". */
  entityType: string;
}

export interface PlatformCalendar {
  registerSource(id: string, source: CalendarSource): void;
  /** Register the generic date-custom-field calendar source for an entity kind.
   *  Called by the OWNING module at boot (e.g. inventory for inventory:part),
   *  so the kernel never hardcodes which modules/tables have date fields. */
  registerDateFieldSource(spec: DateFieldCalendarSpec): void;
  /** Run every registered source for the window and return the merged,
   *  date-sorted events. Sources that throw contribute nothing. */
  collect(orgId: string, fromISO: string, toISO: string): Promise<CalendarEvent[]>;
  /** Kernel-mediated query: rows of `kind` whose date metadata field `field`
   *  falls in [fromISO, toISO]. The table is resolved from the kind's
   *  registerDateFieldSource spec, so a CALLER (e.g. lists surfacing grocery
   *  expiry) reads another module's dated rows WITHOUT naming its table. Returns
   *  [] when the kind isn't registered or its table is absent. (Audit burn-down:
   *  replaces lists' raw `from inventory_parts` reads.) */
  queryDateField(
    orgId: string,
    kind: string,
    field: string,
    fromISO: string,
    toISO: string,
  ): Promise<Array<{ id: string; name: string; value: string }>>;
}

/** core-queue v0.1: persistent background work for modules.
 *  enqueue() defers a unit of work; registerWorker(name, fn) sets
 *  the handler that the api process's worker loop will invoke when
 *  the job's run_at has arrived. See api/src/platform/queue.ts. */
export interface PlatformNotifications {
  /** Fan a notification to one user across their enabled channels.
   *  Writes the row, looks up the user's per-event-type channel
   *  preferences, and delivers via every enabled channel. */
  dispatch(p: {
    orgId: string;
    userId: string;
    eventType: string;
    message: string;
    link_url?: string;
    module?: string;
    entityType?: string;
    entityId?: string;
    payload?: unknown;
  }): Promise<{ notificationId: string; deliveredVia: string[] }>;
  /** Convenience: every member of an org. Modules that want to
   *  broadcast a notification (e.g. "this task is now unblocked")
   *  iterate this and dispatch per-user. */
  orgMemberIds(orgId: string): Promise<string[]>;
}

// ── sync connectors (mirror external records into Cobblr entities) ──
// The typed runtime the sync engine drives. A declarative / AI-authored
// manifest layer can later compile down to this same shape.

export interface SyncFetchContext {
  orgId: string;
  baseUrl: string;
  credentials: Record<string, unknown>;
  /** SSRF-guarded fetch injected by the engine — use this, not global fetch. */
  fetch: typeof fetch;
}

export interface SyncRecord {
  externalId: string;
  parentExternalId?: string | null;
  fields: Record<string, unknown>;
  deleted?: boolean;
  /** Cross-section references: a target field that points at ANOTHER synced
   *  entity by its external id (e.g. a machine's location_id → a location). The
   *  engine resolves each through that section's id-map to the mirrored Cobblr
   *  entity id before writing — null if that entity hasn't been imported yet. */
  references?: Record<string, { section: string; externalId: string }>;
  /** Image fields to pull across: a target field (e.g. "image_path") → the source
   *  URL/path of an image. The engine fetches each (through the edge bridge),
   *  stores the bytes in core-files, and sets the field to the served file URL.
   *  Relative paths are resolved against the source base. */
  images?: Record<string, string>;
  /** Per-record target instance (multi-instance modules) — the section's
   *  `instanceBy` routes each row to an instance by a field value, so ONE section
   *  fans a single endpoint out to several instances. Overrides the section's
   *  static `targetInstance` when set. */
  instance?: string | null;
}

export interface SyncEntityType {
  key: string;
  label: string;
  targetKind: string;
  /** For a multi-instance target module: the instance slug to write into (e.g.
   *  "3d-printers"), so imported rows land under that instance's nav entry rather
   *  than the base. The engine passes it to the writer as the `instance` field. */
  targetInstance?: string | null;
  fetchAll: (ctx: SyncFetchContext) => Promise<SyncRecord[]>;
  fetchOne?: (ctx: SyncFetchContext, externalId: string) => Promise<SyncRecord | null>;
  /** Fetch a binary asset (image) from the source through the same transport as
   *  fetchAll — used by the engine to pull `SyncRecord.images` across. Returns the
   *  raw bytes + mime type, or null on any non-2xx / empty body. */
  fetchBinary?: (ctx: SyncFetchContext, urlOrPath: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

export interface SyncWebhookHit {
  entityType: string;
  externalId: string;
  deleted?: boolean;
  record?: SyncRecord;
}

export interface SyncConnector {
  id: string;
  label: string;
  describeCredentials: () => Record<string, { label: string; secret: boolean }>;
  describeConfig?: () => Record<string, { label: string; placeholder?: string }>;
  entityTypes: SyncEntityType[];
  testConnection?: (ctx: SyncFetchContext) => Promise<{ ok: boolean; error?: string }>;
  parseWebhook?: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ) => SyncWebhookHit | null;
}

/** What a reconcile WOULD do to one source record, computed without writing —
 *  the unit of an import preview. 'link' = merge into an existing same-name
 *  Cobblr entity instead of creating a duplicate. */
export interface ImportPlanItem {
  externalId: string;
  name: string;
  action: "create" | "update" | "link" | "unchanged" | "delete";
  /** The existing Cobblr entity this row touches (link / update / delete). */
  cobblrId?: string | null;
  /** The mapped source fields this row would WRITE — what data comes over. */
  fields?: Record<string, unknown>;
  /** For link/update/delete: the existing Cobblr entity, so the preview can show
   *  the match both-sides (its name + current fields, when the writer can read). */
  match?: { id: string; name: string; fields?: Record<string, unknown> | null } | null;
}

export interface ImportPlan {
  entityType: string;
  targetKind: string;
  counts: {
    create: number;
    update: number;
    link: number;
    unchanged: number;
    delete: number;
    total: number;
  };
  items: ImportPlanItem[];
}

export interface PlatformIntegrations {
  /** Register an outbound connector. */
  registerConnector(c: {
    id: string;
    label: string;
    describeCredentials: () => Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" }>;
    }>;
    invoke: (
      ctx: {
        orgId: string;
        connectorId: string;
        rowId: string;
        credentials: Record<string, unknown>;
        args: Record<string, unknown>;
        rendered?: string;
        event?: { name: string | null; payload: Record<string, unknown> };
      },
      actionId: string,
    ) => Promise<unknown>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  }): void;
  /** Register an inbound webhook handler. */
  registerInboundHandler(h: {
    id: string;
    label: string;
    describeWebhookConfig: () => Record<string, { label: string; secret: boolean }>;
    emits: string[];
    handle: (
      req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
      ctx: {
        orgId: string;
        inboundRowId: string;
        config: Record<string, unknown>;
        emit: (eventName: string, payload: unknown) => Promise<void>;
      },
    ) => Promise<{ status: number; body?: unknown }>;
  }): void;
  /** Register a SYNC connector — mirrors external records into a Cobblr
   *  entity kind. The typed runtime the sync engine drives. */
  registerSyncConnector(c: SyncConnector): void;
  /** Resolve a registered sync connector by id (the engine needs its live
   *  fetch fns), or null. */
  getSyncConnector(id: string): SyncConnector | null;
  /** List registered sync connectors for the "Add connection" picker
   *  (metadata only — no live fns). */
  listSyncConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    config: Record<string, { label: string; placeholder?: string }>;
    entityTypes: Array<{ key: string; label: string; targetKind: string }>;
  }>;
  /** List registered outbound connectors. Used by the connector
   *  catalogue endpoint to render the "Add connector" picker. */
  listConnectors(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" }>;
    }>;
  }>;
  /** List registered inbound handlers. */
  listInboundHandlers(): Array<{
    id: string;
    label: string;
    config: Record<string, { label: string; secret: boolean }>;
    emits: string[];
  }>;
  /** Resolve a registered connector by id, or null. Modules use this
   *  to validate a user-supplied connector_id before persisting. */
  getConnector(id: string): {
    id: string;
    label: string;
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      argsSchema?: Record<string, { label: string; type: "text" | "number" | "boolean" }>;
    }>;
    testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  } | null;
  /** Encrypt credentials with the per-org master key. */
  encryptCredentials(orgId: string, plaintext: Record<string, unknown>): Promise<string>;
  /** Decrypt credentials with the per-org master key. */
  decryptCredentials(orgId: string, ciphertext: string): Promise<Record<string, unknown>>;
  /** Invoke a registered connector. Returns the connector's result,
   *  or throws on failure. Audit logging is the caller's
   *  responsibility — the platform layer is intentionally stateless
   *  here so per-workspace audit rows live in the module's tenant
   *  DB. */
  invokeConnector(
    connectorId: string,
    ctx: {
      orgId: string;
      rowId: string;
      credentials: Record<string, unknown>;
      args?: Record<string, unknown>;
      rendered?: string;
      event?: { name: string | null; payload: Record<string, unknown> };
    },
    actionId: string,
  ): Promise<unknown>;
  /** Dispatch a request to a registered inbound handler. Used by
   *  the unauthenticated webhook receiver. */
  dispatchInbound(
    handlerId: string,
    req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string },
    ctx: {
      orgId: string;
      inboundRowId: string;
      config: Record<string, unknown>;
      emit: (eventName: string, payload: unknown) => Promise<void>;
    },
  ): Promise<{ status: number; body?: unknown }>;
}

// ──────────────────────── core-ai provider registry ───────────────
//
// Providers register at module load time (openai, anthropic, ollama
// ship built-in). The PlatformAi facade exposes a unified `invoke`
// that picks a provider + model based on the workspace's capability
// defaults, calls the provider, writes an audit row, returns the
// shaped result.

export const AiCapabilities = [
  "classify-image",
  "identify-image",
  "extract-text",
  "summarise",
  "embed-text",
  "chat",
  "match-to-catalog",
] as const;

export type AiCapability = (typeof AiCapabilities)[number];

/** One credential field an AI provider asks for. `choices` renders as a
 *  select (generic in every credential form) — e.g. the `transit` field on
 *  URL-based providers: direct fetch vs via the user's edge bridge. */
export interface AiCredentialField {
  label: string;
  secret: boolean;
  choices?: Array<{ value: string; label: string }>;
}

export interface AiProviderDef {
  id: string;
  label: string;
  describeCredentials: () => Record<string, AiCredentialField>;
  /** Map capability → models the provider supports for it. */
  capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
  /** Whether a workspace that has configured NO provider may have this one
   *  auto-selected by the zero-config fallback. Default true — a managed,
   *  credential-less provider (instance key) is ready to use. A provider that
   *  needs per-user setup before it works — e.g. the edge bridge needs a
   *  connected agent + a personal Connection — sets `false`, so it's used only
   *  when explicitly chosen/routed and a missing-provider case stays a clean
   *  "no provider configured" rather than an error from the unset provider. */
  autoSelectable?: boolean;
  /** Run a single inference. The platform handles caching + audit
   *  before/after. */
  invoke: (ctx: {
    orgId: string;
    rowId: string;
    capability: AiCapability;
    model: string;
    credentials: Record<string, unknown>;
    input: Record<string, unknown>;
    config: Record<string, unknown>;
  }) => Promise<{
    result: unknown;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
  }>;
  /** Optional health/test ping. */
  testConnection?: (credentials: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}

/** A pluggable entitlement guard. Called by invoke() AFTER the provider +
 *  model are resolved but BEFORE caching/inference. Returning { allow:false }
 *  makes invoke() refuse exactly like "no provider configured" — so every
 *  caller's existing degrade path (the ai:false contract) handles it.
 *
 *  Open core ships NO guard (everything is allowed — self-host runs free).
 *  The hosted overlay registers one that denies the managed providers unless
 *  the org's plan/allowance permits it. This is the seam the proprietary
 *  cloud layer plugs into; the billing logic itself is NOT in the open core.
 *  See business-models/docs/09. */
export interface AiEntitlementGuard {
  (ctx: {
    orgId: string;
    capability: AiCapability;
    providerId: string;
    model: string;
  }): Promise<{ allow: boolean; reason?: string }>;
}

/** SSRF policy for AI providers that fetch a workspace-supplied URL
 *  (e.g. the ollama `base_url`). "lan" allows RFC1918 (a self-hosted
 *  Ollama lives on the LAN); "strict" blocks all private/loopback/
 *  metadata (a cloud tenant's "home" endpoint is reached over the
 *  public internet). Open core defaults to "lan"; the hosted overlay
 *  sets "strict" at boot. See docs/operations/security-audit.md §10. */
export type AiEndpointPolicy = "lan" | "strict";

export interface PlatformAi {
  registerProvider(p: AiProviderDef): void;
  /** Register the (single) entitlement guard. Last registration wins;
   *  open core never calls this — only the hosted overlay does. */
  registerEntitlementGuard(g: AiEntitlementGuard): void;
  /** SSRF policy for workspace-supplied provider URLs. Defaults to
   *  "lan"; the hosted overlay sets "strict" at boot. Providers that
   *  fetch a user URL read this via getEndpointPolicy(). */
  getEndpointPolicy(): AiEndpointPolicy;
  setEndpointPolicy(p: AiEndpointPolicy): void;
  listProviders(): Array<{
    id: string;
    label: string;
    credentials: Record<string, { label: string; secret: boolean }>;
    capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
  }>;
  getProvider(id: string): AiProviderDef | null;
  /** Single entry point for any module to use AI. Picks provider +
   *  model from the workspace's capability defaults, calls the
   *  cache, calls the provider, writes audit + cache rows, returns
   *  the result. */
  invoke(req: {
    orgId: string;
    capability: AiCapability;
    input: Record<string, unknown>;
    /** Override provider + model from workspace defaults. */
    provider_id?: string;
    model?: string;
    /** Skip cache lookup AND skip cache write. Useful for
     *  match-to-catalog after a user rejects a suggestion. */
    bypass_cache?: boolean;
    source?: { kind: string; id: string };
    /** The user who initiated this call (for the AI activity log). Null/absent
     *  for system-initiated calls (e.g. a wire). */
    userId?: string | null;
  }): Promise<{
    result: unknown;
    provider_id: string;
    model: string;
    cached: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cost_cents?: number;
    duration_ms: number;
  }>;
}

// ───────────────────────────── Edge channel seam ─────────────────────────────
// A workspace can have a live OUTBOUND connection from a user-run edge agent
// (the Cobblr edge-bridge dialing the cloud). The agent dials out and holds the
// pipe open, so the cloud reaches a device behind NAT / on a private network /
// tailnet WITHOUT that user exposing a public URL — the inverse of an SSRF-
// guarded fetch. Open core defines the registry + request/response contract;
// the hosted relay server (proprietary overlay) authenticates edge connections
// and registers them here. Consumers (e.g. the "Local AI via edge bridge"
// provider) route a request to a workspace's edge via send().
//
// The registry is keyed by orgId and lives in-process — single-instance only
// for now (the socket lives on whichever api process the agent dialed). Scaling
// out to multiple replicas needs a shared backplane; that swaps THIS impl while
// keeping the seam, so providers + the agent never change.

export interface EdgeRequest {
  /** Path on the edge's local target, e.g. "/api/chat". */
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Per-request budget (ms). The relay rejects if the edge doesn't answer. */
  timeoutMs?: number;
  /** Dynamic-config edge bridge: the machine this call targets, carried WITH the
   *  request so the bridge configures the driver on the fly — no static
   *  BRIDGE_CONFIG, no restart. The bridge installs with just a token; machines
   *  are added in Cobblr and ride down with each call. Absent for the AI channel
   *  and for a statically-configured bridge. */
  instance?: { id: string; driver: string; config: Record<string, unknown> };
  /** Generic local-source proxy (sync connectors): instead of a driver, the
   *  bridge performs a plain HTTP request to `baseUrl + path` with `headers` and
   *  returns the result. Lets a hosted sync connector reach a LAN source (e.g.
   *  companion app) over the dial-out relay — the cloud never touches the private
   *  address. Mutually exclusive with `instance`. */
  source?: { baseUrl: string; headers?: Record<string, string> };
}

export interface EdgeResponse {
  status: number;
  body: unknown;
}

/** A live edge connection's send function — supplied by the hosted relay when
 *  an agent connects, removed (via the returned unregister fn) when it drops. */
export type EdgeChannelSender = (req: EdgeRequest) => Promise<EdgeResponse>;

/** One queued relay request as delivered to a polling bridge. */
export interface EdgeRelayItem {
  id: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  instance?: EdgeRequest["instance"];
  source?: EdgeRequest["source"];
}

/** A connected relay agent, as reported by the pane of glass. */
export interface EdgeAgentInfo {
  /** Named bridge id, or null for the workspace's default bridge. */
  bridge: string | null;
  last_seen_ms: number;
  queued: number;
  in_flight: number;
  /** A long-poll is parked = healthy idle bridge waiting for work. */
  parked: boolean;
}

/** A module that can attach things to an edge bridge. Registered at module api
 *  load; the generic Edge-bridges page renders one card per consumer, so the
 *  kernel page never hardcodes module names. */
export interface EdgeConsumer {
  /** The registering module's name — the page greys the card + offers Enable
   *  when the module isn't enabled in the viewing workspace. */
  module: string;
  label: string;
  description: string;
  /** In-app route where the attach/manage flow lives (e.g. "/digifab"). */
  href: string;
}

export interface PlatformEdge {
  /** Hosted relay: register a live channel for a workspace. Returns an
   *  unregister fn. One channel per workspace — a newer connection replaces an
   *  older one (the relay reaps the stale socket). */
  registerChannel(orgId: string, send: EdgeChannelSender): () => void;
  /** Is there a live edge channel for this workspace right now? */
  hasChannel(orgId: string): boolean;
  /** Send a request to the workspace's edge; rejects if none is connected. */
  send(orgId: string, req: EdgeRequest): Promise<EdgeResponse>;

  // ── HTTP relay primitives — the queue mechanics behind the dial-out tunnel.
  // The kernel owns the state; routers (the kernel /orgs/:slug/edge wire and
  // any module-mounted legacy alias) are thin HTTP shims over these, so every
  // path lands on the SAME channels and modules stay isolated. Keys follow
  // edgeChannelKey: `orgId` for the default bridge, `orgId::<name>` for a
  // named one, or a bare userId for a personal (account-scoped) agent.

  /** Announce/refresh a bridge: registers the channel on first touch and
   *  bumps its liveness clock. */
  relayTouch(key: string): void;
  /** Long-poll for the next queued request; resolves null on keep-alive
   *  timeout or when the poller hangs up (pass an abort signal). */
  relayPoll(key: string, opts?: { signal?: AbortSignal }): Promise<EdgeRelayItem | null>;
  /** Deliver a polled request's result. Returns false if the id is unknown
   *  (already timed out). */
  relayRespond(key: string, r: { id: string; status: number; body?: unknown }): boolean;
  /** Connected agents for a workspace (default + named bridges). */
  relayAgents(orgId: string): EdgeAgentInfo[];
  /** One bridge's liveness — `bridge` null = the default channel. */
  relayInfo(orgId: string, bridge?: string | null): { connected: boolean; last_seen: number | null };

  // ── Consumer registry — modules declare "I can use a bridge" here.
  registerConsumer(c: EdgeConsumer): void;
  listConsumers(): EdgeConsumer[];

  // ── Bridge release — the self-update artifact the bridge downloads.
  getRelease(): { version: string; sha256: string };
  getReleaseBundle(): string;
  /** Registry-free bootstrap: a stock node image fetches this loader from
   *  /release/loader and runs it — it pulls the bundle and self-updates. */
  getReleaseLoader(): string;
}

/** The single per-tenant egress policy every external-HTTP path routes through —
 *  consistent SSRF posture across sync connectors, device drivers, webhooks, and
 *  module polls (replaces the historic divergent per-module guards). */
export interface PlatformEgress {
  /** SSRF-guarded outbound fetch for a tenant. Link-local/metadata is always
   *  blocked. On a HOSTED instance (COBBLR_HOSTED=true) a private/internal target
   *  is blocked UNLESS a registered allow-provider permits it for this org (the
   *  tenant's own registered edge endpoint); a self-hosted instance allows LAN. */
  guardedFetch(orgId: string, input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Register a per-tenant allow-provider — e.g. the edge module exposing the
   *  org's registered bridge endpoints. Returns true to permit a private target. */
  registerAllow(provider: (orgId: string, ip: string, url: URL) => boolean | Promise<boolean>): void;
}

/** Cross-tenant key/value cache in cobblr_meta. For data that is the SAME for
 *  every workspace and is NOT tenant-private — public catalog lookups are the
 *  motivating case: a UPC resolves to the same product for everyone, so on a
 *  multi-tenant host you want to resolve each barcode ONCE globally instead of
 *  re-spending a shared rate-limited API quota per tenant. Never put
 *  tenant-identifying or tenant-private data here. */
export interface PlatformSharedCache {
  /** The stored JSON value, or null if absent or expired. */
  get<T = unknown>(namespace: string, key: string): Promise<T | null>;
  /** Upsert a value. `ttlSeconds` omitted ⇒ never expires (stable reference
   *  data like a resolved product). */
  put(namespace: string, key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}

export interface PlatformQueue {
  enqueue(p: {
    orgId: string;
    queue: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  }): Promise<string>;
  registerWorker(
    queue: string,
    handler: (job: {
      id: string;
      orgId: string;
      payload: Record<string, unknown>;
      attempts: number;
    }) => Promise<void> | void,
  ): void;
  /** "Does this org already have a non-finished job on this queue?"
   *  Returns the set of org_ids (out of the input set) that have at
   *  least one job in the given statuses on the named queue. Used
   *  by recurring-job seeders to avoid double-queuing on boot — a
   *  cleaner replacement for hand-rolled `SELECT … FROM
   *  core_queue_jobs` against another module's tables. */
  hasPendingJob(args: {
    orgIds: string[];
    queue: string;
    statuses?: Array<"queued" | "running" | "done" | "failed">;
  }): Promise<Set<string>>;
}

/** Authorization helpers exposed to modules. Today only one: a
 *  user-has-capability check for per-action grants. Modules that
 *  want a route gated by a specific verb (e.g. `inventory:create-
 *  part`) ask `platform().auth.userHasCapability(...)`. Admins/owners
 *  pass implicitly; members/guests need an explicit grant in
 *  workspace_capability_grants. See
 *  docs/modules/member-portal-and-permissions.md. */
export interface PlatformAuth {
  userHasCapability(args: {
    orgId: string;
    userId: string;
    role: string;
    actionId: string;
  }): Promise<boolean>;
  /** Mint a SHORT-LIVED, capability-scoped token carrying `userId`'s
   *  own identity + an `app:<slug>` audience (H1 Tier B). It verifies
   *  as a normal session, so it acts AS the member — bounded by their
   *  capabilities + field-read-scope; it can never exceed them. The
   *  App Player uses it to mediate reads for a sandboxed custom
   *  frontend, so the untrusted bundle never holds the real session. */
  mintAppToken(args: {
    userId: string;
    appSlug: string;
  }): Promise<{ token: string; expires_in: number }>;
  /** Mint a NORMAL member session JWT for `userId` — a full session (NOT
   *  app-scoped), as if they had logged in. For TRUSTED in-process callers that
   *  have already authenticated a real member through another channel and need
   *  to act AS them against the internal API: an inbound integration (a verified
   *  Slack message, a forwarded receipt email) routing a capture into the
   *  member's workspace. Mirrors what core's receipt-ingest does directly; this
   *  seam exposes it to the trusted overlay. In-process only (platform seams are
   *  never HTTP-reachable); the resulting session is still bounded by the
   *  member's role + capabilities at every endpoint it hits. */
  mintSession(args: { userId: string }): Promise<string>;
  /** Register the platform-level auth-email sender (verify / reset / magic
   *  link). A self-hoster wires their own; the overlay injects a managed
   *  sender. Open core registers none — magic-link falls back to the inline
   *  dev link, reset to admin-managed. Last registration wins. */
  registerEmailSender(sender: AuthEmailSender): void;
  /** True if an auth-email sender is registered (so the auth routes know
   *  whether real delivery is available vs. the dev-link fallback). */
  hasEmailSender(): boolean;
  /** Deliver an auth email through the registered sender. No-op (returns
   *  false) if none is registered. */
  sendEmail(msg: AuthEmailMessage): Promise<boolean>;
}

/** Reads + writes against entity_pairings, the polymorphic
 *  relationship table. Modules use this instead of SELECTing the
 *  table directly so we have one chokepoint for org-scoping +
 *  validation. See B1 in 2026-05-25-audit.md. */
export interface PlatformPairings {
  /** Insert a pairing. Returns the new row id. Org-scoped: the
   *  caller passes orgId; the function inserts with that org_id. */
  create(args: {
    orgId: string;
    sourceKind: string;
    sourceId: string;
    targetKind: string;
    targetId: string;
    relationshipKind: string;
    createdBy?: string | null;
  }): Promise<{ id: string }>;
  /** Insert many pairings at once. Used by bricklink.disassemble-kit
   *  to write hundreds of "matches" / "derived-from" rows efficiently. */
  createMany(
    rows: Array<{
      orgId: string;
      sourceKind: string;
      sourceId: string;
      targetKind: string;
      targetId: string;
      relationshipKind: string;
      createdBy?: string | null;
    }>,
  ): Promise<{ inserted: number }>;
  /** Bulk pairing lookup. "Given these N target entities, which
   *  source-side entities of `sourceKind` point at them via
   *  `relationshipKind`?" Returns an array of { sourceId, targetId }
   *  tuples so the caller can group by target. Used by
   *  bricklink-connector's wanted-list diff to fan out from N
   *  catalog entries to the inventory:part rows matched to them in
   *  one query. */
  findByTargets(args: {
    orgId: string;
    sourceKind: string;
    targetKind: string;
    targetIds: string[];
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; targetId: string }>>;
  /** The inverse of findByTargets. "Given these N source entities,
   *  which target-side entities of `targetKind` do they point at via
   *  `relationshipKind`?" One SQL round-trip; caller groups by
   *  sourceId. Used by inventory's parts-list endpoint to
   *  batch-resolve the matched catalog entry for every part on the
   *  page (so the inventory row can fall back to the catalog's
   *  image when image_path is empty). */
  findBySources(args: {
    orgId: string;
    sourceKind: string;
    sourceIds: string[];
    targetKind: string;
    relationshipKind: string;
  }): Promise<Array<{ sourceId: string; targetId: string }>>;
}

/** Read-only access to core-catalogs from other modules. Modules
 *  used to SELECT directly from `core_catalogs_*` tables, which
 *  violated module-layers.md §"What modules canNOT do." This
 *  surface gives the few operations modules legitimately need
 *  (semantic-type lookup, BOM-style entry filter, name+payload
 *  hydration) without the table-type leak. See B1 in
 *  2026-05-25-audit.md. */
export interface PlatformCatalogs {
  /** Find a catalog by its declared semantic_type. Returns null
   *  when no catalog in the workspace declares the type. */
  findBySemanticType(
    orgId: string,
    semanticType: string,
  ): Promise<{ id: string; name: string; schema: Record<string, unknown> } | null>;
  /** Find a catalog by its bundle_external_id (suffix match). Used
   *  during a bundle uninstall to delete the right catalogs. */
  findByBundleExternalIdSuffix(
    orgId: string,
    suffix: string,
  ): Promise<{ id: string; name: string } | null>;
  /** Query entries within a catalog. JSON path filter is restricted
   *  to payload->>'<key>' = '<value>' equality — no arbitrary SQL.
   *  The kernel handles the org-scoping + table access. */
  queryEntries(args: {
    orgId: string;
    catalogId: string;
    /** Equality filters on payload JSONB keys. `{ set_num: "75192-1" }`
     *  → `payload->>'set_num' = '75192-1'`. */
    payloadEq?: Record<string, string>;
    externalIdIn?: string[];
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      catalogId: string;
      externalId: string;
      payload: Record<string, unknown>;
    }>
  >;
  /** Fuzzy-search entries in a catalog by trigram similarity against
   *  `payload->>'name'` (or a caller-supplied payload key). Returns
   *  top-K candidates with their similarity score (0..1, higher =
   *  more similar). Caller-side LLMs use this to pull candidates
   *  before running a structured match. Uses Postgres `pg_trgm` —
   *  the kernel owns the SQL so modules don't reach across schemas. */
  similaritySearch(args: {
    orgId: string;
    catalogId: string;
    queryText: string;
    /** payload key to match against. Defaults to "name". */
    payloadKey?: string;
    /** top-K cap. Defaults to 10, max 100. */
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      externalId: string;
      payload: Record<string, unknown>;
      score: number;
    }>
  >;
}

/** Which stored rendition to read. Images have medium/thumb; other
 *  files only have `original`. */
export type FileVariant = "original" | "medium" | "thumb";

/** A stored file's bytes + just-enough metadata to forward it on
 *  (e.g. upload to a print farm, send to a vision model). */
export interface FileBytes {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** The byte-reading function a file-storage module (core-files)
 *  registers with the platform. */
export type FileReader = (
  orgId: string,
  fileId: string,
  variant: FileVariant,
) => Promise<FileBytes | null>;

/** Result of storing a file through the write seam. */
export interface FileWriteResult {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
}
/** Stores bytes as a new file in `orgId` (its own variants + DB row) and
 *  returns the new file id. core-files registers it; the kernel calls it to
 *  COPY a file across workspaces (e.g. the graduation import duplicating a
 *  photo into the new workspace). */
export type FileWriter = (
  orgId: string,
  bytes: Uint8Array,
  opts: { filename?: string; mimeType?: string },
) => Promise<FileWriteResult>;

/** Server-side access to stored file bytes, brokered so a module never
 *  imports core-files or touches its on-disk layout. core-files
 *  registers the reader at boot; everyone else just calls read(). */
export interface PlatformFiles {
  /** A file-storage module registers the byte reader once at boot. */
  registerReader(reader: FileReader): void;
  /** Read a stored file's bytes. Returns null if no reader is
   *  registered, the file doesn't exist, or the variant is missing. */
  read(
    orgId: string,
    fileId: string,
    variant?: FileVariant,
  ): Promise<FileBytes | null>;
  /** A file-storage module registers the byte writer once at boot. */
  registerWriter(writer: FileWriter): void;
  /** Store bytes as a NEW file in `orgId` (variants + DB row). Returns the new
   *  file id, or null if no writer is registered. Used for cross-workspace
   *  file copies (the graduation import). */
  write(
    orgId: string,
    bytes: Uint8Array,
    opts: { filename?: string; mimeType?: string },
  ): Promise<FileWriteResult | null>;
  /** Override the blob-storage driver (the overlay injects S3/R2). If none is
   *  registered, core-files uses its built-in local-disk driver. */
  registerDriver(driver: FilesDriver): void;
  /** The registered driver, or null → core-files falls back to local disk. */
  getDriver(): FilesDriver | null;
}

/** Multi-instance support hooks. A multi-instance module (inventory, assets,
 *  machines, …) registers a counter so the kernel can ask "how many primary
 *  items live in this (org, instance)?" without knowing the module's tables —
 *  used by the nav to hide an auto-created default instance that's empty once
 *  the workspace has named instances. */
/** A workspace's installed instance of a module — the org-scoped, user-named
 *  collection the navbar renders (e.g. machines → "3D Printers" + "Laser
 *  Cutters"). `is_default` marks the module's own auto-created instance
 *  (instance_name === module_name). `item_count` is the module's registered
 *  counter (null if it registered none). Lets a module enumerate what the
 *  workspace ACTUALLY has — enabled, instance-aware — instead of the global
 *  entity-kind registry. */
export interface InstanceInfo {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default: boolean;
  item_count: number | null;
}

export interface PlatformInstances {
  registerItemCounter(
    moduleName: string,
    counter: (orgId: string, instanceName: string) => Promise<number>,
  ): void;
  /** Every instance in the workspace (all enabled modules' default + named
   *  instances), each enriched with its item count. Org-scoped — only what
   *  this workspace has turned on. */
  list(orgId: string): Promise<InstanceInfo[]>;
}

// ─────────────────────── Hosted-overlay extension seams ─────────────────────
// Open core registers NONE of these → a self-hosted instance runs free and
// unrestricted. The proprietary cloud overlay registers implementations at boot
// (plan gating, usage metering, lifecycle/verification, abuse rate-limiting,
// object storage). See cloud/docs/cloud-offering-roadmap.md.

export interface EntitlementCtx {
  orgId: string;
  /** Dotted feature key, e.g. "workspaces.create", "members.add",
   *  "modules.enable", "sandbox.install", "files.store". */
  feature: string;
  /** Units requested (default 1) — e.g. bytes for files.store. */
  quantity?: number;
  userId?: string;
}
export type EntitlementGuard = (
  ctx: EntitlementCtx,
) => Promise<{ allow: boolean; reason?: string }>;
export interface PlatformEntitlements {
  /** Hosted overlay registers the plan guard (last wins). */
  registerGuard(g: EntitlementGuard): void;
  /** Core / modules ask whether a plan-limited action is allowed. No guard
   *  registered → always allowed; a guard that throws fails open. */
  check(ctx: EntitlementCtx): Promise<{ allow: boolean; reason?: string }>;
}

export interface MeterEvent {
  orgId?: string;
  /** e.g. "ai.tokens", "files.bytes_stored", "members.added". */
  kind: string;
  quantity: number;
  meta?: Record<string, unknown>;
}
export type MeterSink = (e: MeterEvent) => void;
export interface PlatformMetering {
  registerSink(s: MeterSink): void;
  /** Emit a billable/observable event. No sink → dropped. Never throws. */
  record(e: MeterEvent): void;
}

export interface SignupLifecycleCtx { userId: string; email: string; orgId: string }
export interface AccountDeleteCtx { userId: string; email: string }
export interface LifecycleHooks {
  onSignup?: (ctx: SignupLifecycleCtx) => Promise<void> | void;
  onAccountDelete?: (ctx: AccountDeleteCtx) => Promise<void> | void;
}
export interface PlatformAccounts {
  registerLifecycleHooks(h: LifecycleHooks): void;
}

export interface RequestGuardCtx { ip: string; path: string; method: string; userId?: string }
export type RequestGuard = (
  ctx: RequestGuardCtx,
) => Promise<{ allow: boolean; retryAfterSec?: number; reason?: string }>;
/** A delivery to a global, unauthenticated webhook endpoint
 *  (/api/v1/hooks/:id). `rawBody` is the exact transmitted bytes, captured so a
 *  handler can verify a provider signature (Stripe, GitHub, …) against them.
 *  `method` is "POST" for webhooks/interactivity or "GET" for OAuth callbacks. */
export interface PublicWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  query: Record<string, unknown>;
}
export interface PublicWebhookHandler {
  /** URL segment under /api/v1/hooks/, e.g. "stripe-billing". Last
   *  registration for an id wins. */
  id: string;
  /** Return `headers` + a 3xx `status` with a `Location` header to issue a
   *  redirect (an OAuth "Add to X" callback) instead of a JSON body. */
  handle: (
    req: PublicWebhookRequest,
  ) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}
export interface PlatformHttp {
  /** Hosted overlay registers a request guard (rate-limit / abuse). */
  registerRequestGuard(g: RequestGuard): void;
  /** Register a global, UNAUTHENTICATED webhook endpoint mounted at
   *  /api/v1/hooks/:id. For ACCOUNT-LEVEL provider webhooks (Stripe billing,
   *  GitHub app, …) that are NOT tenant-scoped — distinct from
   *  integrations.registerInboundHandler, which is the per-workspace,
   *  token-in-URL inbound receiver. The handler verifies its own signature and
   *  resolves any tenant from the payload; the platform mounts it before auth
   *  and captures rawBody for signature checks. Open core mounts the dispatch
   *  route regardless, 404-ing unregistered ids. */
  registerWebhook(h: PublicWebhookHandler): void;
}

// ── Hosted settings panels ───────────────────────────────────────────────────
// Lets a module/overlay contribute a SETTINGS PAGE to the web app WITHOUT
// shipping any frontend code into the open-core web bundle. The overlay returns
// a small DECLARATIVE view (text / status / buttons / a select) + handles the
// actions; the open-core web app renders it with one generic renderer. Open core
// registers no panels, so a self-hoster sees nothing — none of the panel's
// labels, logic, or even its name exist in core. Used for the hosted-only
// billing + Slack panels, which therefore live entirely in the closed overlay.

export type HostedPanelBlock =
  | { kind: "text"; text: string; tone?: "muted" | "warning" }
  | { kind: "status"; label: string; value: string; active?: boolean }
  // A text field. Its current value is collected by `key` and submitted together
  // when a `kind:"button"` with `submit:true` is clicked (input values arrive on
  // runAction's `input.values`). `secret:true` renders a password field and the
  // panel should not echo the stored value back.
  | { kind: "input"; key: string; label: string; placeholder?: string; secret?: boolean; value?: string }
  | {
      kind: "button";
      label: string;
      action: string;
      style?: "primary" | "default" | "danger";
      confirm?: string;
      /** Gather every input block's value and pass them as `input.values`. */
      submit?: boolean;
    }
  | {
      kind: "select";
      label: string;
      action: string;
      value: string | null;
      options: Array<{ value: string; label: string }>;
      placeholder?: string;
      hint?: string;
    };
export interface HostedPanelView {
  blocks: HostedPanelBlock[];
}
/** What a button/select action returns: optionally redirect the browser (OAuth /
 *  checkout), re-fetch the view, and/or show a toast. */
export interface HostedPanelActionResult {
  redirect?: string;
  refresh?: boolean;
  toast?: string;
}
export interface HostedPanelContext {
  orgId: string;
  userId: string;
  slug: string;
}
export interface HostedPanel {
  /** URL segment + key, e.g. "billing", "slack". */
  id: string;
  label: string;
  /** Generic icon NAME (e.g. "credit-card"); the web maps a small allowlist. */
  icon?: string;
  group?: "modules" | "data" | "access" | "extend" | "admin";
  getView(ctx: HostedPanelContext): Promise<HostedPanelView>;
  runAction(
    ctx: HostedPanelContext,
    action: string,
    input?: { value?: string | null; values?: Record<string, string> },
  ): Promise<HostedPanelActionResult>;
}
export interface HostedPanelSummary {
  id: string;
  label: string;
  icon?: string;
  group?: string;
}
export interface PlatformHostedPanels {
  /** Hosted overlay registers a settings panel. Last registration per id wins. */
  register(panel: HostedPanel): void;
  /** Summaries for building tiles/routes (no handlers). Empty in open core. */
  list(): HostedPanelSummary[];
  get(id: string): HostedPanel | undefined;
}

/** Blob persistence driver. core-files ships + falls back to a local-disk
 *  driver; the overlay registers an S3/R2 driver via platform().files. */
export interface FilesDriver {
  put(orgId: string, fileId: string, relPath: string, bytes: Uint8Array): Promise<void>;
  getBytes(orgId: string, fileId: string, relPath: string): Promise<Uint8Array | null>;
  remove(orgId: string, fileId: string): Promise<void>;
  /** Local drivers return an absolute path (Express sendFile fast path);
   *  remote drivers return null and the route streams getBytes. */
  localPath(orgId: string, fileId: string, relPath: string): string | null;
}

/** Platform-level (pre-workspace) auth email — verification, password reset,
 *  magic-link delivery. Open core registers no sender (dev returns the link
 *  inline; admin-reset is the fallback). A self-hoster OR the overlay registers
 *  one. */
export interface AuthEmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. Senders deliver multipart text+html when present (the
   *  text stays the plaintext fallback). Used for richer transactional emails
   *  (e.g. the feedback "your request is live" note). */
  html?: string;
  // `notification` = a platform-level transactional note to a known user (e.g.
  // "the feedback you reported is live"). Distinct from the pre-workspace auth
  // kinds; reuses the same registered sender (the overlay's managed mailer).
  kind: "magic_link" | "verify_email" | "password_reset" | "invite" | "notification";
  /** Optional Reply-To. Used for reply-by-email (a tokenized feedback address)
   *  so a recipient's reply can be routed back inbound instead of lost. */
  replyTo?: string;
}
export type AuthEmailSender = (msg: AuthEmailMessage) => Promise<void>;

// ── Scan-URL resolvers ──────────────────────────────────────────────────
// A scanned QR is often a URL on a maker's site that encodes a SPECIFIC
// product (a Polar Filament spool → `3dqr.co/?i=<serial>`). Treated as a
// barcode it triggers the generic web-search path, which finds the maker's
// *marketing* page, not the product. So the platform exposes a registry via
// platform().scan.registerUrlResolver, and the scan pipeline asks
// platform().scan.resolveUrl(value). In practice the registered resolver is the
// DECLARATIVE vendor resolver, which consults a data manifest LIST (built-in +
// operator-added) — adding a maker is a data entry, not a code module. The
// kernel/core-scan never imports a vendor — the same modular seam as
// registerComputedContext / registerHandler.

export interface ScanUrlResolution {
  /** Provenance for the inbox row + cache, e.g. "polar-3dqr". */
  source: string;
  /** Product name, e.g. "Royal Blue PLA". */
  name: string;
  brand: string | null;
  /** Domain category, e.g. "filament" — routes the inbox item on commit. */
  category: string | null;
  /** Entity kind to create: "part" | "asset" | … */
  entityType: string | null;
  /** Custom fields seeded onto the created entity's metadata (e.g. a filament
   *  spool's size / batch_code). Unknown keys ride along harmlessly. */
  fields: Record<string, unknown>;
  imageUrl?: string | null;
}

export interface ScanUrlResolver {
  /** Stable id for de-dup + provenance, e.g. "polar-3dqr". */
  name: string;
  /** Cheap + synchronous: does this resolver claim the scanned value? */
  matches: (value: string) => boolean;
  /** Fetch + parse the value into a product, or null on any miss / parse
   *  failure (the caller then falls back to its generic barcode path).
   *  `opts.force` = a user-initiated re-run: bypass any resolver-side cache so
   *  the value is re-fetched + re-mapped fresh (otherwise a stale cached
   *  resolution survives the re-run). */
  resolve: (value: string, opts?: { force?: boolean }) => Promise<ScanUrlResolution | null>;
}

export interface PlatformScan {
  /** Register a vendor scan-URL resolver. Called from a connector module's
   *  api/index.ts at module-load. Idempotent per `name`. */
  registerUrlResolver(resolver: ScanUrlResolver): void;
  /** Resolve a scanned value through the registered vendor resolvers, in
   *  registration order. Returns the first hit, or null if none claim it.
   *  `opts.force` rides through to each resolver (re-run bypasses caches). */
  resolveUrl(value: string, opts?: { force?: boolean }): Promise<ScanUrlResolution | null>;
}

export interface Platform {
  activity: PlatformActivity;
  events: PlatformEvents;
  tenants: PlatformTenants;
  db: PlatformDb;
  entities: PlatformEntities;
  actions: PlatformActions;
  templates: PlatformTemplates;
  wires: PlatformWires;
  health: PlatformHealth;
  recurrence: PlatformRecurrence;
  calendar: PlatformCalendar;
  queue: PlatformQueue;
  sharedCache: PlatformSharedCache;
  notifications: PlatformNotifications;
  integrations: PlatformIntegrations;
  ai: PlatformAi;
  edge: PlatformEdge;
  egress: PlatformEgress;
  auth: PlatformAuth;
  pairings: PlatformPairings;
  catalogs: PlatformCatalogs;
  files: PlatformFiles;
  instances: PlatformInstances;
  scan: PlatformScan;
  devices: PlatformDevices;
  // Hosted-overlay seams (no-op / allow-all in open core):
  entitlements: PlatformEntitlements;
  metering: PlatformMetering;
  accounts: PlatformAccounts;
  http: PlatformHttp;
  hostedPanels: PlatformHostedPanels;
}

// ── Device substrate seam ────────────────────────────────────────────────────
// Lets a device-touching consumer (the core-devices actuator today; core-print,
// other modules later) reach a DEVICE without owning the connection table or the
// driver registry. The owner of those (digifab today; core-devices after the
// connections move) REGISTERS a provider; consumers call getDriver(). This is the
// `platform().devices` half of the core-devices extraction
// (docs/architecture/core-devices-extraction.md §2) — start of the substrate move
// that doesn't require migrating the connections table.

/** The generic device contract — what EVERY connection can do. Fabrication
 *  drivers (digifab) extend this with file→job→status; a structural superset is
 *  assignable here, so a MachineDriver satisfies it. */
export interface DeviceDriver {
  testConnection?(): Promise<{ ok: boolean; detail?: string }>;
  listDevices?(): Promise<Array<{ id: string; name: string; state?: string | null; enabled?: boolean }>>;
  /** The actuator verb — fire a parameterised command-and-forget. */
  runCommand?(command: string, params: Record<string, unknown>): Promise<{ ok: boolean; ref?: string; detail?: string }>;
  /** The sensor verb — a point reading. */
  readSensor?(deviceId: string): Promise<{ value: number; unit?: string; at?: string }>;
}

/** Build a driver from a connection ref (id OR label). null when unresolved. */
export type DeviceDriverProvider = (orgId: string, connectionRef: string) => Promise<DeviceDriver | null>;

/** A device connection as returned to clients — NEVER includes credentials. */
export interface DeviceConnectionPublic {
  id: string;
  type: string;
  label: string;
  base_url: string;
  config: Record<string, unknown>;
  enabled: boolean;
  capabilities: Record<string, unknown>;
  last_sync_at: string | Date | null;
  last_sync_status: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Internal shape for building a driver — carries the encrypted credentials. */
export interface DeviceConnectionInternal {
  id: string;
  type: string;
  base_url: string;
  credentials_enc: string;
}

export interface DeviceConnectionCreate {
  type: string;
  label: string;
  base_url: string;
  /** Raw credential fields — the store encrypts them. */
  creds?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface DeviceConnectionPatch {
  label?: string;
  base_url?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Raw credential fields to merge; a null value clears that field. */
  creds?: Record<string, string | null>;
}

/** The connection store — implemented by the owner of the connections table
 *  (core-devices); a connection-MANAGING consumer (digifab's CRUD routes) calls
 *  it so the table can live in one place without cross-module table access. */
export interface DeviceConnectionStore {
  list(orgId: string): Promise<DeviceConnectionPublic[]>;
  /** Public shape (no creds) by id. */
  get(orgId: string, id: string): Promise<DeviceConnectionPublic | null>;
  /** Internal shape (with creds) by id OR case-insensitive label — for driver building. */
  getInternal(orgId: string, ref: string): Promise<DeviceConnectionInternal | null>;
  create(orgId: string, input: DeviceConnectionCreate): Promise<DeviceConnectionPublic>;
  update(orgId: string, id: string, patch: DeviceConnectionPatch): Promise<DeviceConnectionPublic | null>;
  remove(orgId: string, id: string): Promise<boolean>;
  /** Stamp the cached probe result (capabilities + last_sync) after a test. */
  setProbe(orgId: string, id: string, capabilities: Record<string, unknown>, status: string): Promise<void>;
}

export interface PlatformDevices {
  /** The connection/driver owner registers this at boot (one provider). */
  registerDriverProvider(provider: DeviceDriverProvider): void;
  /** Resolve a connection ref to a driver via the registered provider. */
  getDriver(orgId: string, connectionRef: string): Promise<DeviceDriver | null>;
  /** The connections-table owner (core-devices) registers the store at boot. */
  registerConnectionStore(store: DeviceConnectionStore): void;
  /** The connection store, for a connection-managing consumer (digifab CRUD).
   *  Throws if no store is registered (core-devices always registers one). */
  connections(): DeviceConnectionStore;
}

let _platform: Platform | null = null;

/** Called once during api boot. Throws if called twice. */
export function setPlatform(p: Platform): void {
  if (_platform) {
    throw new Error("Platform already initialised");
  }
  _platform = p;
}

/** Called by modules. Throws if setPlatform hasn't run yet. */
export function platform(): Platform {
  if (!_platform) {
    throw new Error("Platform not initialised — setPlatform() must run during boot");
  }
  return _platform;
}

// ── AI-reply JSON hygiene ────────────────────────────────────────────────────
// Every AI surface that asks a model for JSON (scan matchmaker, the bundle
// builder's intent-match + describe-it→bundle, barcode/photo identify) hits the
// same problem: cheaper / smaller models (Haiku, local Ollama) garble strict
// JSON — markdown fences, trailing commas, smart quotes, truncated output,
// unescaped quotes in a string. A single garble used to drop the whole result.
// These pure helpers recover the structured object from imperfect output, so
// ONE source of truth serves every module (modules can't import each other; they
// all import this contract). Each caller keeps its own thin wrapper for its
// shape (the matchmaker's `candidates`, core-authoring's `bundle`).

/** The wire engine's source-entity payload-key convention, in ONE place so
 *  emitters and the engine agree without anyone hardcoding a foreign kind.
 *  An emitter that references another entity puts its id under the key derived
 *  from that entity's kind: the suffix after `:` , camelCased, + "Id". So
 *  "inventory:part" → "partId", "purchases:order_item" → "orderItemId". The
 *  wire engine derives the same key from a binding's source_kind to read it
 *  back. (Lets `lists` restock whatever seeded a checked line without a
 *  `kind === "inventory:part"` branch — audit 2026-06-26 burn-down.) */
export function sourceIdKey(kind: string): string {
  const suffix = kind.split(":")[1] ?? "";
  const camel = suffix.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${camel}Id`;
}

/** Extract the first BALANCED `{…}` object from a model reply, tolerant of
 *  ```fences``` + leading/trailing prose. Brace-matches OUTSIDE strings; returns
 *  the object substring, or — if the output was truncated mid-object — from the
 *  first `{` to the end (repairJson then closes it). null if there's no `{`. */
export function extractJsonObject(s: string): string | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]! : s;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start);
}

/** Best-effort repair of common cheap-model JSON breakage, applied only AFTER a
 *  clean parse fails: curly "smart quotes" used as delimiters → straight, drop
 *  trailing commas, terminate an unclosed string, and balance unclosed `{`/`[`
 *  (truncation). Quote/bracket tracking skips characters inside strings. A
 *  structural/semantic error survives untouched for the caller's validator. */
export function repairJson(s: string): string {
  let out = s.replace(/[“”]/g, '"').replace(/,(\s*[}\]])/g, "$1");
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** Parse a model JSON reply into an object, recovering from fences/prose/
 *  commas/smart-quotes/truncation. Layered: as-is → repaired. Returns the parsed
 *  value (typed by the caller) or null when nothing salvageable — the caller may
 *  then retry the model or fall back. */
export function parseJsonReply<T = unknown>(content: string): T | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  for (const candidate of [obj, repairJson(obj)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next repair */
    }
  }
  return null;
}
