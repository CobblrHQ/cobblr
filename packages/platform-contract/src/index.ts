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
  type: z.enum(["text", "number", "boolean", "date", "image-path", "url"]),
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
// docs/design-decisions/traits.md for the full rationale.

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
// See docs/design-decisions/traits.md §"Presets — preset shorthand".
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
  });

// ─────────────────────── Pillar B: actions ─────────────────────────
//
// Modules declare what they can do TO entities. Actions list the
// kinds they apply to — either by explicit ID, or by predicate
// ({ any: true } / { hasFieldRole: 'title' }).

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
          }),
        )
        .default([]),
    })
    .default({ fieldDefs: [], wires: [] }),
  subscribes: z.array(z.string()).default([]),
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
  emit(eventName: string, payload: unknown): void;
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

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Look up one entity by (kind, id). Returns null if the kind
   *  has no resolver (module not enabled) or the entity doesn't
   *  exist. */
  lookup(orgId: string, kind: string, id: string): Promise<ResolvedEntity | null>;
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
}

// ──────────────── Pillar B runtime — actions ───────────────────────

/** Programmatic action handler. The platform routes
 *  platform.actions.invoke() calls to the right module's handler.
 *  Returns whatever the module wants — the caller might be the
 *  wire-engine running an event-triggered action, in which case
 *  the return is mostly ignored. */
export type ActionHandler = (ctx: ActionInvokeContext) => Promise<unknown>;

export interface ActionInvokeContext {
  orgId: string;
  userId: string | null;
  entityKind: string;
  entityId: string;
  /** Pre-rendered template result, if the binding had a template. */
  rendered?: string;
  /** Extra args from the binding (passed through). */
  args?: Record<string, unknown>;
  /** Original triggering event payload, when fired by a wire. */
  event?: { name: string; payload: unknown };
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

export interface Platform {
  activity: PlatformActivity;
  events: PlatformEvents;
  tenants: PlatformTenants;
  entities: PlatformEntities;
  actions: PlatformActions;
  templates: PlatformTemplates;
  wires: PlatformWires;
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
