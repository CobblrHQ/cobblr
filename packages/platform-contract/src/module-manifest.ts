import { z } from "zod";
import { ActionAppliesTo, CONFIGURATION_SECTION_HOSTS, EntityAction, LiveControl, MODULE_PART_ID, ModuleCapability, ModuleCommand, NotificationKind, WireTarget } from "@cobblr/platform-contract/module-parts";
import { AXIS_OF_TRAIT, type PresetName, type RawTraitsDecl, TRAIT_PRESETS, type TraitName } from "@cobblr/platform-contract/traits";
import { EntityKind } from "@cobblr/platform-contract/kind-schema";
import { FieldAggregateSchema } from "@cobblr/platform-contract/field-aggregate";
import { type EntityField, FaceSchema, FieldRoleSchema, FieldTypeSchema, Intent, NavItem } from "@cobblr/platform-contract/entity-fields";

const ModuleManifest = z.object({
  // Stable identifier — must be unique across the platform, used as
  // the table prefix and the URL segment under /api/v1/modules/.
  // Module name doubles as a URL segment + a key in module_field_defs.source_module
  // etc. Leading digit allowed so names like "3d-printers" work; everything must
  // still be kebab/snake-case ascii.
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be kebab/snake-case ascii"),
  aliases: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)).optional(),
  retirement: z.object({
    reason: z.string().trim().min(1),
    replacement: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  }).optional(),
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
  //   user:         custom-built for one specific app — a workshop app's
  //                  workshop-mods, a homestead app's livestock module.
  // Default 'user' so any module without a declared band lands in the
  // most-conservative bucket (user-controlled, freely toggleable).
  // Maintainers curate which modules are *actually* foundational /
  // stock; declaring band: 'foundational' in an unrelated user module
  // is informational only — the platform won't treat it as such unless
  // it's also in the curated foundational list (see module-layers.md
  // §"Foundational modules — the strict-test band").
  band: z.enum(["foundational", "stock", "marketplace", "user"]).default("user"),

  // Release maturity — distinct from `band` (band = where in the layer model;
  // maturity = how finished). The UI surfaces it as a badge. The ladder:
  //   hidden:       merged but off everywhere — never loads. The dark-ship
  //                 state: land a module's code + migrations on main to keep
  //                 main releasable, invisible until you promote it up.
  //   experimental: rough / narrow / may change or vanish; an "Experimental"
  //                 badge, AND skipped at load when
  //                 COBBLR_DISABLE_EXPERIMENTAL_MODULES=true (the public /
  //                 trial default) so a half-baked connector never fronts a
  //                 public deploy.
  //   beta:         usable but still moving; a "Beta" badge. Unlike
  //                 experimental it is NEVER hidden — it always loads, even
  //                 under COBBLR_DISABLE_EXPERIMENTAL_MODULES — it just tells
  //                 the user "sub-1.0, expect change". The rung for a module
  //                 that is real and shipping but not yet at 1.0.
  //   stable:       ready for general use; no badge.
  // The same ladder + badge applies to a FEATURE (a LiveControl) via the
  // capability gate — one vocabulary, two zooms. See
  // docs/design-decisions/release-channels.md + architecture/module-layers.md.
  maturity: z.enum(["hidden", "experimental", "beta", "stable"]).default("stable"),

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

  /** An optional outside integration, offered under services, not a collection row. */
  integration: z.object({ route: z.string().startsWith("/") }).optional(),

  // A user-facing NAV entry this module contributes, even though the `core-`
  // prefix / foundational band would otherwise exclude it from the navbar.
  //
  // The nav hides every `core-*` module on the convention that the prefix means
  // plumbing. That is right for most of them, but a module can be foundational
  // AND something you browse daily — locations, files, tags, saved views — and
  // such a module had nowhere to go except /configuration. That is how the
  // settings area became the dumping ground for data browsers, and why
  // Locations ended up reachable at two URLs (one of them inside the settings
  // shell) until 2026-07.
  //
  // Declaring `nav` is the escape hatch, made declarative: it used to be two
  // hardcoded synthetic entries in useNavModules (core-scan, core-locations),
  // so the next such module needed a code change in the host to be reachable.
  //
  // `route` is the canonical URL for the page — the ONE place it lives. Do not
  // also register it as a settings destination.
  // See docs/design-decisions/configuration-revamp.md.
  nav: z
    .object({
      /** The noun as the user sees it, singular-or-plural as it reads in a
       *  navbar ("Locations", "Files", "Tags"). A workspace can rename it via
       *  Presentation; this is the default. */
      label: z.string().min(1),
      /** Canonical route. Must be mounted in the host. */
      route: z.string().startsWith("/"),
      /** Lucide icon name, kebab-case (e.g. "map-pin"). */
      icon: z.string().optional(),
      /** Presentation-override key, when the module's rename should follow an
       *  entity kind rather than the module name. */
      overrideKey: z.string().optional(),
      /** A ROW in the navigation, beside the workspace's collections. Only for
       *  a page people go to as a place (Locations, the Scan Inbox). Everything
       *  else declared here is search-only: routable, listed in the feature
       *  index, reached from inside records, never a row. A fresh workspace's
       *  nav is Home, its collections, and the primary doors; nothing else
       *  (docs/design-decisions/nav-collapse.md). */
      primary: z.boolean().optional(),
      /** A LIVE NUMBER on the row: how much is waiting behind this door. The
       *  host polls `GET /orgs/:slug/modules/<name><path>` and shows the
       *  integer at `field` as a pill beside the label, on every nav surface;
       *  zero shows nothing. Declare it only for a queue a person works down
       *  (the scan inbox's pending captures), never for a size (a collection's
       *  row count is not a call to action). Keep the endpoint a single cheap
       *  count, since every open tab asks it every few seconds. */
      count: z
        .object({
          path: z.string().startsWith("/"),
          field: z.string().min(1),
        })
        .optional(),
    })
    .optional(),

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

  // Parts: the pieces of one module a workspace can have on or off on their
  // own (digifab's robot arms beside its printers and lasers). A part owns
  // the actions, panels, workspace tools and route prefixes that name it; off,
  // the kernel hides them at every door and keeps their data. "with-collection"
  // is on exactly where the workspace has one of the part's collections, so a
  // part added to a module changes nothing for a workspace that never chose
  // it. A bundle family's parts (#5026) are collections; these are code. See
  // docs/architecture/module-parts.md.
  parts: z
    .array(
      z.object({
        id: z.string().regex(MODULE_PART_ID, "part id must be kebab-case"),
        label: z.string().min(1),
        description: z.string().min(1),
        default: z.enum(["on", "off", "with-collection"]),
        /** The collections (instance names, any module) that turn a
         *  "with-collection" part on. */
        collections: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
        /** Route prefixes under the module's API this part owns ("/arms"). */
        routes: z.array(z.string().regex(/^\/[a-z0-9][a-z0-9/-]*$/)).default([]),
      }),
    )
    .default([]),

  // Which side of a grown sidebar this module's row sits on: a COLLECTION is
  // a place a person keeps things (Inventory, Purchases, the pantry); a TOOL
  // is a place they go to do something (Labels, Lists, Digital Fabrication).
  // Absent, the host derives it: a primary door and an operator (`operatesOn`
  // non-empty) read as tools, everything else as a collection. Declare it when
  // the derivation reads wrong: Purchases operates on inventory and is still a
  // collection of orders; Lists operate on nothing and are still a tool.
  // docs/design-decisions/nav-collapse.md ("The growing middle").
  navKind: z.enum(["collection", "tool"]).optional(),

  // Optional icon-only quick-action pinned to the navbar's RIGHT
  // cluster — a module's single most-used action that earns prime,
  // always-visible placement (e.g. core-scan's camera button, which
  // power users hit constantly). Rendered only while the module
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

  /** @deprecated Retired: nothing ever handled an intent; the assistant works
   *  through record tools and `exposes.actions`. Accepted so an old
   *  third-party manifest loads; lint:manifest-advertises-what-it-has refuses
   *  one in a first-party manifest. */
  intents: z.array(Intent).default([]),
  dependencies: z.array(z.string()).default([]),
  // Grantable permissions this module checks that are not actions (see
  // ModuleCapability).
  capabilities: z.array(ModuleCapability).default([]),
  exposes: z
    .object({
      events: z.array(z.string()).default([]),
      // What each event carries: the payload keys every emit of it sends.
      // An action that reads from an event (readsFromEvent) can only be
      // wired to an event that declares the keys it reads.
      eventPayloads: z.record(z.array(z.string().min(1))).default({}),
      /** @deprecated Retired: nothing ever resolved these names. A module
       *  reaches another through platform().entities, an action or an event. */
      api: z.array(z.string()).default([]),
      actions: z.array(EntityAction).default([]),
      // Sentences this module's users would type, and what to do about them.
      // Available with no AI connected at all. See ModuleCommand.
      commands: z.array(ModuleCommand).default([]),
      // Live controls — ongoing session modes surfaced in the Live box.
      live: z.array(LiveControl).default([]),
      // The KINDS of workspace notification this module sends (the eventType
      // it dispatches with, and a name a person would recognise), so the
      // workspace can say who each kind is for. A kind not declared here is
      // still delivered; it just cannot be pointed at fewer people than
      // everyone until it is.
      notifications: z.array(NotificationKind).default([]),
    })
    .default({ events: [], eventPayloads: {}, api: [], actions: [], commands: [], live: [], notifications: [] }),
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
            type: FieldTypeSchema,
            /** For type='relation': the entity-kind id this field references
             *  (e.g. "core-locations:location"). The stored value is the target
             *  entity's id (in metadata); the read layer resolves it to the
             *  target's title and injects `<name>_label` for display. */
            ref_kind: z.string().optional(),
            required: z.boolean().optional(),
            position: z.number().int().optional(),
            choices: z.array(z.string()).optional(),
            /** Whether what a person types becomes a choice
             *  (@cobblr/platform-contract/field-choices). */
            learns: z.boolean().optional(),
            /** How it adds up in a group's summary
             *  (@cobblr/platform-contract/field-aggregate). */
            aggregate: FieldAggregateSchema.optional(),
            /** Built-in renderer id — color-hex / image-url / url-link / year /
             *  boolean / code / markdown / qr / text. The web UI switches on
             *  this when drawing the value. */
            renderer: z
              .enum(["text", "color-hex", "image-url", "url-link", "year", "boolean", "code", "markdown", "qr"])
              .optional(),
            /** Server-managed: the value is computed/stamped server-side
             *  (e.g. core-mobility's `away_since`) and a client write is
             *  never accepted — the write router preserves the stored
             *  value across an unrelated edit rather than taking the
             *  client's. Server-side writers (wire action handlers)
             *  bypass the router and write it directly. Default false. */
            server_managed: z.boolean().optional(),
            /** What the field MEANS (see FIELD_ROLE_VALUES): an assets
             *  `assigned_to` person field is the `assignee`, so the platform
             *  knows the thing gets lent without learning the field's name. */
            field_role: FieldRoleSchema.optional(),
          }),
        )
        .default([]),
      // Pillar E (UI) — panels this module contributes INTO another
      // module's web surfaces: a page-level tab on the target module's
      // list page, or a panel inside the target kind's detail modal.
      // The web renders contributions through its panel registry
      // (web/src/panels/registry.tsx) — a host page renders whatever
      // enabled modules contribute, never naming a contributor. A
      // contribution is honored ONLY when the target's module is in
      // this module's `operatesOn` (validated below): operatesOn is
      // the declared capability that grants UI presence. See
      // docs/design-decisions/machines-digifab-unification.md §5.
      panels: z
        .array(
          z.object({
            /** Registry id, `<module>:<panel>` (e.g. "digifab:fleet-tab") —
             *  must have a component registered web-side. */
            id: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
            surface: z.enum(["module-page-tab", "entity-detail-panel", "configuration-section", "view-toolbar", "tag-toolbar"]),
            /** Target module ("machines") for a page tab, entity kind
             *  ("machines:machine") for a detail panel, or a Configuration
             *  page (one of CONFIGURATION_SECTION_HOSTS) for a section. For a
             *  view toolbar, a module ("inventory"): the control sits on every
             *  saved view whose records that module owns, its named
             *  collections included, and is handed the records the view shows. */
            target: z.string().min(1),
            /** The tab/panel label the host renders. */
            title: z.string().min(1),
            /** Same predicate an action carries, matched against the traits
             *  the collection wears ("Price history" is `traits: ["fungible"]`
             *  and says nothing on a catalog). Absent, `target` alone decides. */
            appliesTo: ActionAppliesTo.optional(),
            /** The collections this panel belongs on, by their stable name
             *  ("3d-printers", "laser-cutters"). A panel for one sort of
             *  machine names the collections it serves rather than every
             *  record of the kind: a kiln's firing logs on every 3D printer
             *  was the growth #6337 named. With `presence`, a record outside
             *  these that already has the panel's data still shows it. */
            collections: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).optional(),
            /** The panel also shows on a record its module says has its data
             *  (a kiln profile, a linked manager, a renewal), checked through
             *  platform().panels.registerPresence. With neither this nor
             *  `collections`, `target` and `appliesTo` alone decide. */
            presence: z.boolean().optional(),
            /** The module part this panel belongs to; off, the panel is not sent. */
            part: z.string().regex(MODULE_PART_ID).optional(),
            /** The face this panel belongs to, for disclosure (see the same
             *  field on an action). */
            face: FaceSchema.optional(),
            placement: z.enum(["summary", "details"]).optional(),
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
            // The action's own arguments, as a bundle's wire carries them
            // (strings may use {{event.…}} and the record's fields). A default
            // wire that says what to do (who to tell, in which words) needs
            // them; one wire per (kind, action, event) is the dedupe key, so
            // two defaults for one action listen to different events.
            args: z.record(z.unknown()).optional(),
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
    .default({ fieldDefs: [], panels: [], wires: [] }),
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
}).superRefine((m, ctx) => {
  const partIds = new Set(m.parts.map((p) => p.id));
  if (partIds.size !== m.parts.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parts"], message: `module "${m.name}" declares a part twice` });
  for (const p of m.parts) if (p.default === "with-collection" && p.collections.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["parts"], message: `part "${p.id}" is on with its collection but names none` });
  for (const a of m.exposes?.actions ?? []) if (a.part && !partIds.has(a.part)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exposes", "actions"], message: `action "${a.id}" names part "${a.part}", which "${m.name}" does not declare` });
  for (const p of m.contributes?.panels ?? []) if (p.part && !partIds.has(p.part)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "panels"], message: `panel "${p.id}" names part "${p.part}", which "${m.name}" does not declare` });
  // A declared capability is this module's own: its id carries the module's
  // name, and it is not one of the module's actions under a second label
  // (grantableActions lists the action first and would drop this one's words
  // without a sound).
  const actionIds = new Set(m.exposes.actions.map((a) => a.id));
  m.capabilities.forEach((c, i) => {
    if (!c.id.startsWith(`${m.name}:`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", i, "id"],
        message: `capability "${c.id}" must start with this module's name, "${m.name}:"`,
      });
    }
    if (actionIds.has(c.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", i, "id"],
        message: `capability "${c.id}" is already one of this module's actions; an action is grantable as it is, so declare it once`,
      });
    }
  });
  // The panel gate: contributing UI into another module's surfaces
  // requires DECLARING you operate on it. Keeps `operatesOn` honest
  // (it stops being decorative) and makes drive-by UI injection a
  // manifest-validation failure, not a review argument.
  for (const p of m.contributes.panels) {
    // A section on a Configuration page: the page is the kernel's, not a
    // module's, so there is no module to operate on. It is gated instead by
    // the page naming itself a host, and by the page's own role.
    if (p.surface === "configuration-section") {
      if (!(CONFIGURATION_SECTION_HOSTS as readonly string[]).includes(p.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "panels"],
          message: `panel "${p.id}" is a configuration section for "${p.target}", which is not a page that hosts sections (${CONFIGURATION_SECTION_HOSTS.join(", ")})`,
        });
      }
      continue;
    }
    // `*` — a panel on EVERY entity detail view. Some side-cars are not about
    // one module's entities at all: a conversation, a tag. Enumerating every
    // kind that should have one is a list that is wrong the day a module ships,
    // and getting it wrong is silent (the panel simply never appears).
    //
    // It is NOT a hole in the gate above. `operatesOn` exists to stop drive-by
    // UI injection, and a universal panel is the largest injection there is, so
    // it is limited to modules that are ALWAYS ON: a workspace cannot turn
    // these off, so there is no surprise to spring on it. A stock module that
    // the user chose to enable, or a marketplace one, still has to name what it
    // operates on.
    if (p.target === "*") {
      if (m.band !== "foundational" && !m.autoEnable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "panels"],
          message: `panel "${p.id}" targets every kind ("*"), which only an always-on module may do — "${m.name}" is neither band "foundational" nor autoEnable`,
        });
      }
      continue;
    }
    const targetModule = p.target.includes(":") ? p.target.split(":")[0]! : p.target;
    // A module's own records are not someone else's surface: a control it puts
    // on its own views or its own kinds injects nothing.
    if (targetModule === m.name) continue;
    if (!m.operatesOn.includes(targetModule)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "panels"],
        message: `panel "${p.id}" targets "${p.target}" but "${targetModule}" is not in operatesOn — a module may only contribute panels into modules it declares it operates on`,
      });
    }
  }
});

export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModulePart = ModuleManifest["parts"][number];
/** What a manifest is written as (defaults optional), and its pieces, for a
 *  module that assembles its manifest from parts (digifab's families). */
export type ModuleManifestInput = z.input<typeof ModuleManifest>;
export type ModuleActionInput = NonNullable<NonNullable<ModuleManifestInput["exposes"]>["actions"]>[number];
export type ModulePanelInput = NonNullable<NonNullable<ModuleManifestInput["contributes"]>["panels"]>[number];
export type ModulePartInput = NonNullable<ModuleManifestInput["parts"]>[number];
export type ModuleIntent = z.infer<typeof Intent>;
export type EntityKindDecl = z.infer<typeof EntityKind>;
export type EntityFieldDecl = z.infer<typeof EntityField>;
export type EntityActionDecl = z.infer<typeof EntityAction>;
export type LiveControlDecl = z.infer<typeof LiveControl>;
export type ActionAppliesToDecl = z.infer<typeof ActionAppliesTo>;

/**
 * FIELD SCOPES — the closed vocabulary for a field def that applies to a CLASS
 * of entity kinds instead of exactly one ("Origin: where I got this", on every
 * physical thing the workspace tracks — parts, assets, machines, places).
 *
 * A scope is just an `appliesTo` predicate over an entity kind, which is
 * precisely what an action's `appliesTo` already is — so a scoped field is
 * matched by the SAME matcher (matchAction), not a second one. The key is a
 * SENTINEL parked in `module_field_defs.entity_kind` (which stays NOT NULL), and
 * it starts with `@` so it can never collide with a real kind id (`module:kind`).
 *
 * Scoped on TRAITS, never on names or a use case: a kind is in-scope because it
 * declared `tangibility: physical`, not because someone listed it. New physical
 * kinds (a module installed next month, a bundle's instance) inherit the field
 * with no migration — that's the whole point.
 *
 * A kind with NO declared traits matches no trait scope. That's deliberate: it
 * keeps workspace-wide fields off untyped internal plumbing kinds by default.
 *
 * See docs/design-decisions/trait-scoped-fields.md.
 */
/** One-click shortcuts INTO the trait vocabulary — not a replacement for it. Any
 *  combination of the 12 traits is a valid scope; these are just the ones worth a
 *  chip. (The first version of this shipped only two canned scopes, which quietly
 *  told users the other four axes didn't exist.) */
export const FIELD_SCOPE_PRESETS: Array<{
  key: string;
  label: string;
  hint: string;
  traits: TraitName[];
}> = [
  {
    key: "physical",
    label: "All physical items",
    hint: "Anything you can hold, store, or point at: parts, assets, machines, places.",
    traits: ["physical"],
  },
  {
    key: "digital",
    label: "All digital items",
    hint: "Things with no physical body: records, documents, entries.",
    traits: ["digital"],
  },
  {
    key: "physical-unique",
    label: "Things tracked one by one",
    hint: "Physical AND individually identified: an asset, a machine, a vehicle. Excludes bulk stock.",
    traits: ["physical", "unique"],
  },
  {
    key: "physical-fungible",
    label: "Countable stock",
    hint: "Physical AND interchangeable: tracked by quantity, not by which specific one.",
    traits: ["physical", "fungible"],
  },
];

/** The canonical sentinel for a trait scope: `@` + the traits, sorted, joined by
 *  `+`. Parked in `module_field_defs.entity_kind` (which is NOT NULL), where it
 *  keeps `unique (org_id, entity_kind, name)` meaningful — one "origin" per scope
 *  per org — and can never collide with a real kind id (`module:kind`).
 *  Deterministic, so the same scope always lands on the same row. */
export function fieldScopeSentinel(traits: readonly string[]): string {
  return `@${[...traits].sort().join("+")}`;
}

/** Plain-language gloss per platform PROFILE. The profile names are the authoring
 *  vocabulary (a module declares `profile: "owned-thing"`); these say what that
 *  means to someone who has never read the traits doc. */
const PROFILE_HINTS: Record<string, string> = {
  "owned-thing": "A specific thing you own and track one by one — an asset, a machine, a vehicle.",
  "stock-material": "Bulk stock you count rather than name — parts, filament, screws.",
  place: "Somewhere things live — a room, a shelf, a bin.",
  "digital-record": "A record with no physical body — a tag, a file, an entry.",
  "catalog-record": "A lean catalog entry you keep one per title — a film, a book, a board game.",
  "work-item": "Something with a date that can be finished — a task, a job, an order.",
  "vendor-order": "An order placed with someone: it has a date and a done state.",
  "recurring-schedule": "Scheduled, but never finishes — a recurring routine.",
  "one-shot-completable": "A one-off you finish, with no schedule attached.",
  "auto-pruning-record": "A short-lived record that ages out on its own.",
};

/**
 * The platform PROFILES, as field scopes — the other way to say "a class of
 * things". A profile is a full 6-axis fingerprint (what a module declares its kind
 * AS: `profile: "owned-thing"`), so as a scope it means "every kind shaped like
 * this": owned-thing catches assets, machines and vehicles, but not parts (those
 * are fungible) and not locations (those are containers).
 *
 * DERIVED from TRAIT_PRESETS rather than re-listed, so a new platform profile
 * appears here for free and the two can't drift apart.
 *
 * DEDUPED BY FINGERPRINT, because some profiles are trait-identical: `work-item`
 * and `vendor-order` are the same six traits, so as PREDICATES they are the same
 * scope. Two chips would both light up when either was picked and read as a bug;
 * one chip named for both tells the truth — scope to either and you get both.
 */
export function fieldScopeProfiles(): Array<{
  key: string;
  label: string;
  hint: string;
  traits: TraitName[];
}> {
  const byFingerprint = new Map<string, { names: string[]; traits: TraitName[] }>();
  for (const [name, preset] of Object.entries(TRAIT_PRESETS)) {
    // A skipped axis (null) contributes nothing: the profile is silent about it,
    // so a scope built from it has to be silent too.
    const traits = Object.values(preset).filter(
      (v): v is TraitName => typeof v === "string" && v in AXIS_OF_TRAIT,
    );
    if (!traits.length) continue;
    const key = fieldScopeSentinel(traits);
    const hit = byFingerprint.get(key);
    if (hit) hit.names.push(name);
    else byFingerprint.set(key, { names: [name], traits });
  }
  return [...byFingerprint.entries()].map(([key, { names, traits }]) => ({
    key,
    label: names.join(" / "),
    hint:
      names.length === 1
        ? (PROFILE_HINTS[names[0]!] ?? "")
        : `${PROFILE_HINTS[names[0]!] ?? ""} ${names.slice(1).join(", ")} has the same six traits, so this scope covers both.`,
    traits,
  }));
}

/** The traits encoded in a sentinel, or [] if it isn't one. The sentinel is
 *  self-describing on purpose — a human reading the DB can see the scope. */
export function parseFieldScope(entityKind: string): TraitName[] {
  if (!entityKind.startsWith("@")) return [];
  return entityKind
    .slice(1)
    .split("+")
    .filter((t): t is TraitName => t in AXIS_OF_TRAIT);
}

/** True when a field def's `entity_kind` is a scope sentinel rather than a real
 *  entity kind. Total and cheap — real kind ids never start with `@`. */
export function isFieldScope(entityKind: string): boolean {
  return entityKind.startsWith("@");
}

/** Human name for a scope: the preset's label when it is one, else the trait
 *  words. The UI must never render a raw `@physical+unique` at a user. */
export function fieldScopeLabel(traits: readonly string[]): string {
  const key = fieldScopeSentinel(traits);
  const preset = FIELD_SCOPE_PRESETS.find((p) => fieldScopeSentinel(p.traits) === key);
  if (preset) return preset.label;
  if (traits.length === 0) return "Nothing";
  return `${[...traits].sort().join(" + ")} things`;
}

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
  const aliases = resolved.aliases ?? [];
  if (aliases.includes(resolved.name) || new Set(aliases).size !== aliases.length) {
    throw new Error(`Invalid module aliases for "${resolved.name}": aliases must be unique and differ from name`);
  }
  if (resolved.retirement && (resolved.maturity === "hidden" || resolved.maturity === "experimental")) {
    throw new Error(`Retired module "${resolved.name}" must load on every deployment: use beta or stable maturity`);
  }
  if (resolved.retirement && resolved.band === "foundational") {
    throw new Error(`Cannot retire foundational module "${resolved.name}"`);
  }
  if (resolved.retirement?.replacement && [resolved.name, ...aliases].includes(resolved.retirement.replacement)) {
    throw new Error(`Module "${resolved.name}" cannot replace itself`);
  }

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

/** Read one trait-axis value off a resolved traits map, tolerating both the
 *  plain string form and the `{ trait, uncertain }` inference form the
 *  entity-kind registry can carry. Exported so every trait consumer (kind
 *  synthesis, scan confirm, disclosure) reads an axis one way instead of
 *  growing private near-copies. */
export function traitAxisValue(
  traits: Record<string, unknown> | null | undefined,
  axis: string,
): string | null {
  const v = traits?.[axis];
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "trait" in (v as Record<string, unknown>)) {
    const t = (v as { trait?: unknown }).trait;
    return typeof t === "string" ? t : null;
  }
  return null;
}

/** Placement capability (see placement-and-containment.md): can a kind hold
 *  other things inside it? Containment is a PHYSICAL relationship — any physical
 *  thing can be a container (a server holds a PSU; a rack holds a server; a
 *  drawer holds tools). Digital records / work-items cannot. This is the
 *  `canContain` capability from the spec, derived from traits rather than a new
 *  schema field, so it composes with the existing container/containable axis
 *  (which stays for backward-compatible action matching). */
export function canContain(traits: Record<string, unknown> | null | undefined): boolean {
  return traitAxisValue(traits, "tangibility") === "physical";
}

/** Can a kind be placed inside a container? Anything carrying a containment
 *  trait (containable OR container — both are physical); digital records (no
 *  containment axis) cannot. */
export function canBeContained(traits: Record<string, unknown> | null | undefined): boolean {
  return traitAxisValue(traits, "containment") != null;
}
