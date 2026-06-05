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

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Register a list-resolver for a kind. Optional — without one,
   *  list() returns an empty result. Modules opt in when they want
   *  their kind to appear in core-views, search results, etc. */
  registerListResolver(kind: string, resolver: EntityListResolver): void;
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
    viewer?: { userId?: string },
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
    viewer?: { userId?: string; role?: string },
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
export interface PlatformCalendar {
  registerSource(id: string, source: CalendarSource): void;
  /** Run every registered source for the window and return the merged,
   *  date-sorted events. Sources that throw contribute nothing. */
  collect(orgId: string, fromISO: string, toISO: string): Promise<CalendarEvent[]>;
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

export interface AiProviderDef {
  id: string;
  label: string;
  describeCredentials: () => Record<string, { label: string; secret: boolean }>;
  /** Map capability → models the provider supports for it. */
  capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
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

export interface PlatformAi {
  registerProvider(p: AiProviderDef): void;
  /** Register the (single) entitlement guard. Last registration wins;
   *  open core never calls this — only the hosted overlay does. */
  registerEntitlementGuard(g: AiEntitlementGuard): void;
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
  /** Insert many pairings at once. Used by inventory.disassemble-kit
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
}

/** Multi-instance support hooks. A multi-instance module (inventory, assets,
 *  machines, …) registers a counter so the kernel can ask "how many primary
 *  items live in this (org, instance)?" without knowing the module's tables —
 *  used by the nav to hide an auto-created default instance that's empty once
 *  the workspace has named instances. */
export interface PlatformInstances {
  registerItemCounter(
    moduleName: string,
    counter: (orgId: string, instanceName: string) => Promise<number>,
  ): void;
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
  notifications: PlatformNotifications;
  integrations: PlatformIntegrations;
  ai: PlatformAi;
  auth: PlatformAuth;
  pairings: PlatformPairings;
  catalogs: PlatformCatalogs;
  files: PlatformFiles;
  instances: PlatformInstances;
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
