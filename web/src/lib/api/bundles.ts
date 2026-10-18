import type { FieldDefType, FieldRole } from "@cobblr/platform-contract/field-vocabulary";
import type { FactScope } from "@cobblr/platform-contract/fact-scope";
import { request } from "./client";
import type { BundleInstallSummary } from "./workspace";
import type { BundleValidation } from "./authoring";
import type { PlatformBinding } from "./actions";
import type { PlatformFieldDef } from "./fields";

/** A manifest-declared UI contribution (contributes.panels) — a tab on the
 *  target module's list page, or a panel in the target kind's detail modal. */
export interface ContributedPanel {
  placement?: "summary" | "details";
  id: string;
  surface: "module-page-tab" | "entity-detail-panel" | "configuration-section";
  target: string;
  title: string;
  /** The collections it serves, by stable name, and whether it also shows
   *  where its module says the record has its data (#6337). */
  collections?: string[];
  presence?: boolean;
}

export interface OrgModuleListItem {
  /** The module's parts and whether each is on here (module parts): off
   *  hides its screens, actions and tools, and keeps its data. */
  parts?: Array<{ id: string; label: string; description: string; default: "on" | "off" | "with-collection"; on: boolean; chosen: boolean }>;
  name: string;
  aliases?: string[];
  retirement?: { reason: string; replacement?: string } | null;
  version: string;
  displayName: string;
  description: string;
  integration?: { route: string } | null;
  icon: string | null;
  /** Module layer: `stock` = Cobblr's shipped first-party domains, `core-*`
   *  plumbing is `foundational`, marketplace installs / user samples differ.
   *  Used to suggest only real domain modules on the empty dashboard.
   *  Optional: real modules from the API always carry it, but synthetic nav
   *  entries (instances, lens bundles) have no module band. */
  band?: "foundational" | "stock" | "marketplace" | "user";
  /** A user-facing nav entry this module declares even though the `core-*` /
   *  foundational rule would otherwise hide it from the navbar — a page you
   *  BROWSE (locations, files, tags, saved views). Replaces the two hardcoded
   *  synthetic entries useNavModules used to carry.
   *  See docs/design-decisions/configuration-revamp.md. */
  nav?: {
    label: string;
    route: string;
    icon?: string;
    /** Presentation-override key, when the rename should follow an entity kind
     *  rather than the module name. */
    overrideKey?: string;
    /** A row in the nav (Locations, Scan Inbox); absent = search-only. */
    primary?: boolean;
    /** A live number for the row: the host polls this module path and shows
     *  the integer at `field` as a pill (see useNavBadges). */
    count?: { path: string; field: string };
  };
  /** Release maturity — the UI shows an Experimental/Beta badge for non-stable
   *  modules. Absent → treat as stable. ("hidden" modules never load, so they
   *  never reach this list — listed for type-completeness with the manifest.) */
  maturity?: "hidden" | "experimental" | "beta" | "stable";
  /** "multi" → the module can host several named instances (the "+ New thing"
   *  funnel offers it). "single" / absent → one instance only. */
  instanceability?: "single" | "multi";
  /** Non-empty → an operator/capability (labels, digifab): it acts ON other
   *  modules' things and is not itself a trackable kind, so the funnel's
   *  "track a kind of thing" column excludes it. */
  operates_on?: string[];
  /** Which side of a grown sidebar the row sits on, when the manifest says
   *  (`navKind`); absent → derived, see components/nav-groups.ts. */
  nav_kind?: "collection" | "tool" | null;
  /** UI panels this module contributes into ANOTHER module's pages —
   *  rendered through web/src/panels/registry.tsx by the target module's
   *  host page. Present only for modules that declare contributes.panels. */
  panels?: ContributedPanel[];
  /** Icon-only quick-action pinned to the navbar's right cluster. */
  headerAction: { icon: string; label: string; route: string } | null;
  dependencies: string[];
  contributes: { fieldDefs: number; wires: number };
  enabled: boolean;
  enabled_version: string | null;
  enabled_at: string | null;
}

export interface ModuleListItem {
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
  exposes: { events: string[] };
  dependencies: string[];
}

// ─── core-apps (custom worker apps, H1) ──────────────────────────
/** A block is a structured, capability-gated unit on an app page. */
export type AppBlock =
  | { type: "view"; view_id: string; title?: string }
  | { type: "record"; kind: string; id_from: string }
  | { type: "action"; action_id: string; label?: string; kind?: string }
  | { type: "form"; kind: string; mode: "create" | "edit"; fields?: string[] }
  | { type: "stat"; view_id: string; agg: "count" | "sum"; field?: string; times?: string; label?: string }
  | { type: "markdown"; body: string }
  | { type: "scan" }
  | { type: "custom"; html: string; height?: number };
export interface AppPage {
  slug: string;
  title: string;
  blocks: AppBlock[];
}
/** Per-app theme tokens. All optional; unset → Cobblr defaults. Colors
 *  are hex; `font` is a keyword the Player maps to a real family;
 *  `radius` is card-corner px. Stored + validated server-side (no raw
 *  CSS — can't inject a stylesheet). */
export interface AppTheme {
  bg?: string;
  surface?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accent_text?: string;
  border?: string;
  font?: "sans" | "serif" | "mono" | "rounded" | "slab";
  radius?: number;
  /** Wordmark image for the app's top bar — an http(s) or inline `data:` URL. */
  logo?: string;
  /** A custom font: an uploaded font stored as a `data:` URL, or a hosted
   *  font/CSS URL. Player injects an @font-face and uses `font_name`. */
  font_url?: string;
  font_name?: string;
}
/** List/nav metadata for an app (no page bodies). */
export interface WorkspaceAppMeta {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  visible_capability: string | null;
  /** Carried on the list so the portal launcher can inherit a skin. */
  theme?: AppTheme | null;
}
/** Full app definition returned by getApp. */
export interface WorkspaceApp extends WorkspaceAppMeta {
  pages: AppPage[];
  theme?: AppTheme | null;
  created_at?: string;
  updated_at?: string;
}

/** What an uninstall put back and what it kept (#3918). `kept_words` is the
 *  sentence per kept thing: "Kept Pantry: 12 things live there." */
export interface BundleUninstallResult {
  removed: Array<{ type: "module" | "place"; key: string; name: string }>;
  kept: Array<{ type: "module" | "place"; key: string; name: string; reason: string }>;
  kept_words: string[];
  /** Reverting this snapshot puts the bundle back as it was; present only
   *  when its records were kept. */
  undo_snapshot_id?: string;
}
export interface BundleRelease {
  version: string;
  released_at?: string;
  notes: string;
}
export interface BundleUpgradeConflict {
  entity_kind: string;
  name: string;
  field_label: string;
  attr: "label" | "choices" | "removed" | "view";
  yours: string | string[] | null;
  theirs: string | string[] | null;
}
/** What the person chose for one conflicting item on an update. "both" is
 *  for a list of options only: yours, then the update's new ones. */
export interface BundleConflictResolution {
  entity_kind: string;
  name: string;
  attr: BundleUpgradeConflict["attr"];
  choice: "mine" | "theirs" | "both";
}

export interface PlatformBundle {
  id: string;
  external_id: string;
  name: string;
  version: string;
  author: string | null;
  description: string | null;
  source_url: string | null;
  installed_at: string;
  /** The full manifest persisted at install time. Used by the nav
   *  to read `provides_lens` so lens-contributing bundles render
   *  under their parent module's popover. */
  manifest?: PlatformBundleManifest;
  /** Which opt-in features are enabled on this installed bundle. */
  enabled_features?: string[];
}

export interface PlatformBundleManifest {
  record_actions?: Record<string, import("@cobblr/platform-contract/action-groups").RecordActionLayout>;
  record_panels?: Record<string, import("@cobblr/platform-contract/record-panel-layout").RecordPanelLayout>;
  /** Why this manifest declares fields on a module's BASE kind rather than on
   *  an instance of its own; lint:bundle-fields-on-own-kinds refuses base-kind
   *  fields without it. */
  base_kind_fields_reason?: string;
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
  /** Catalog tier (default `core`): `core` = suggested per-scan + browsable;
   *  `extended` = browsable but not suggested per-scan; `disabled` = hidden
   *  everywhere (existing installs keep working). See api lib/flagship-bundles.ts. */
  catalog?: "core" | "extended" | "disabled";
  /** What this bundle's items are CALLED, for the scan router.
   *
   *  A bundle's suggestion has to be corroborated by the capture's own text
   *  before it is trusted, so a model cannot sweep unrelated things into a
   *  themed table. A bundle whose noun IS the word needs nothing here — a
   *  "printer" table and a capture saying "printer" corroborate themselves. A
   *  bundle whose members never share its name cannot corroborate at all, and
   *  says its vocabulary instead: nothing called Tomatoes Roma contains the word
   *  "grocery". Head nouns, and avoid a word with a strong meaning outside the
   *  domain — a keyword is routing evidence, so a false hit files the wrong
   *  thing here. */
  scan_keywords?: string[];
  /** Release date of THIS version (ISO date), shown on the update prompt. */
  released_at?: string;
  /** Plain-language "what changed in this version" — shown prominently when
   *  the user is updating an installed bundle. The technical detail (new
   *  modules / wires / fields) stays in the requires/details accordion. */
  changelog?: string;
  /** Every version's notes, newest first. An update lists the ones between
   *  the installed version and this one. */
  releases?: BundleRelease[];
  /** v1.5: markdown walkthrough rendered on the bundle detail page. */
  readme_md?: string;
  /** v1.5: image URLs displayed as a screenshot strip. */
  screenshots?: string[];
  requires?: { module: string; version?: string }[];
  wires?: {
    source_kind: string;
    action_id: string;
    trigger_type?: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete";
    trigger_event?: string;
    template?: string;
    filter?: Record<string, unknown>;
    args?: Record<string, unknown>;
    /** Where the action lands: "self" (default), "none", or a routed target —
     *  the server stores it verbatim (see the bundle-install contract). */
    target?: unknown;
    /** What this wire does, in one sentence a person reads where the bundle
     *  is suggested ("Works with Lists"). A suggestion says only these. */
    says?: string;
  }[];
  field_defs?: {
    entity_kind: string;
    name: string;
    display_label: string;
    // Was a second hand-written copy, and it was missing "relation" - so a
    // relation field read back as a type this client did not believe existed.
    type: FieldDefType;
    ref_kind?: string;
    required?: boolean;
    position?: number;
    /** When type='text', renders as a dropdown of these choices. */
    choices?: string[];
    /** When type='computed', the {{ }} template rendered read-only. */
    template?: string;
    /** Built-in display renderer (color-hex swatch, url-link, …). */
    renderer?: "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code";
    /** Plain-language one-line hint shown under the input ("the maker's named
     *  shade — e.g. 'Peacock Heather'") so jargon fields explain themselves. */
    help?: string;
    /** The heading this field sits under on a record's sheet ("Printing").
     *  Made on install in the order its first field appears. */
    section?: string;
    /** The unit a type='number' value is measured in ("mm", "g") — free text,
     *  resolved against the units vocabulary; declares physical semantics. */
    unit?: string;
    /** Semantic RECORD role: `category` (this table's grouping axis) or `pack`
     *  (the packaging-count field, filled from the scanned package). */
    // The shared list, not a copy: this union had already drifted (it was
    // missing "identifier") and a stale copy silently rejects a valid role.
    field_role?: FieldRole;
    /** Scan-decode role: `identifier:<kind>` (this field carries the scanned
     *  identifier, e.g. a VIN) or `decode:<key>` (fill from the decoder's
     *  output). Mirrors the server contract's FieldDefEntry. */
    decode_role?: string;
    /** A text field with choices: is a value someone types remembered as a
     *  choice (lint:field-learns-declared requires the answer). */
    learns?: boolean;
    /** A number or money field: how it adds up in a group's summary
     *  (lint:bundle-number-fields-say-how-they-add-up requires the answer). */
    aggregate?: "sum" | "per_unit" | "none";
    /** A fact about the model (every unit shares it) or this unit
     *  (@cobblr/platform-contract/fact-scope, #6013). */
    fact_scope?: FactScope;
  }[];
  /** Presentation overrides for a kind's native fields (relabel / hide). */
  field_overrides?: {
    entity_kind: string;
    name: string;
    display_label?: string;
    hidden?: boolean;
    position?: number;
    /** Override-layer decode role — wins over the field-def's own. */
    decode_role?: string;
    /** What the module's own column MEANS on this table (Bought from is the
     *  seller on a vehicle), the native twin of a field def's field_role. */
    field_role?: FieldRole;
  }[];
  /** Saved views the bundle installs (optionally pinned to the dashboard). */
  saved_views?: {
    entity_kind: string;
    name: string;
    view_type?: string;
    config?: Record<string, unknown>;
    pinned?: boolean;
    is_default?: boolean;
  }[];
  /** Optional lens contribution — turns this bundle into a Pillar-E
   *  specialisation. The nav reads installed bundles with
   *  provides_lens to render lens chips under the parent module. */
  provides_lens?: {
    entity_kind: string;
    name: string;
    display_name: string;
  };
  /** Phase 2: opt-in features (checkboxes in the install modal). The arrays
   *  above are the always-on BASE; each enabled feature merges its same-shaped
   *  arrays in. Toggleable later via re-install with a new enabled set. */
  features?: PlatformBundleFeature[];
  /** Module instances this bundle creates on install (skinned copies of a
   *  multi-instance module — e.g. an "inventory" instance named "Yarn"). Each
   *  instance's fields/views/wires apply scoped to `<instance_name>:item`. */
  provides_instances?: PlatformBundleInstance[];
  /** Sidebar headings this bundle creates on install, each gathering module
   *  and/or instance nav entries. Attaching a member moves it under the heading. */
  nav_headings?: {
    name: string;
    icon?: string;
    members: { target_kind: "module" | "instance"; target_id: string }[];
  }[];
  /** Catalog shells this bundle installs (name + schema config, no rows). Rows
   *  load separately via CSV import or a puller. A feature can carry its own. */
  catalogs?: PlatformBundleCatalog[];
  /** WorkspaceApps this bundle seeds on install (e.g. the Outfit Planner). */
  provides_apps?: PlatformBundleApp[];
  /** Places this bundle offers to set up (a Kitchen with a Fridge in it).
   *  Applied find-or-create per CHILD: an existing Kitchen is merged into and
   *  whatever is already inside it stays. Usually declared on a FEATURE so it
   *  is a question - a workspace may be an office or a van. */
  provides_locations?: PlatformBundleLocation[];
  /** Data migrations the bundle owns — run automatically + idempotently when the
   *  user upgrades from a version below `to_version`. Each invokes a registered
   *  generic action (e.g. inventory:lift-to-type) against their data. */
  migrations?: Array<{ to_version: string; action: string; args?: Record<string, unknown> }>;
}

/** A WorkspaceApp a bundle seeds — pages → blocks (a custom block carries its
 *  own HTML). Validated structurally on install, deeply by core-apps. */
export interface PlatformBundleApp {
  slug: string;
  name: string;
  icon?: string;
  visible_capability?: string | null;
  pages: { slug: string; title: string; blocks: Record<string, unknown>[] }[];
  theme?: Record<string, unknown> | null;
}

/** A module instance a bundle creates — its own nav entry, fields, views, and
 *  add flow, isolated to the instance kind `<instance_name>:item`. */
export interface PlatformBundleInstance {
  renewal_fields?: import("@cobblr/platform-contract/record-creation").RenewalFieldBinding;
  record_templates?: import("@cobblr/platform-contract/record-creation").RecordTemplate[];
  receipt_draft?: import("@cobblr/platform-contract/record-creation").ReceiptDraftConfig;
  module: string;
  instance_name: string;
  display_name: string;
  glyph?: string;
  /** Singular noun for the add button + modal title ("yarn" → "New yarn"). */
  item_noun?: string;
  /** Default unit for new items (e.g. "skein"). */
  qty_unit?: string;
  /** The table a record here is made into parts on (a Lego set comes apart into bricks on Bricks). */
  parts_into?: string;
  /** What a record of this table calls the things inside it ("Parts"). */
  contents_label?: string;
  /** The service jobs a record of this table usually needs ("Oil change"). */
  service_tasks?: string[];
  /** One line under the table's title saying what goes in it. */
  hint?: string;
  /** The links a record in this table makes, in words (#3875). */
  links?: Array<{ kind: string; label: string; inverse: string; to: string[]; date_summary?: import("@cobblr/platform-contract/link-date-summary").LinkDateSummary }>;
  /** Words the person may pick for what the table holds or counts (#3650). */
  noun?: import("@cobblr/platform-contract/kind-label").NounChoiceDecl;
  /** Each file dropped on the table becomes a record (FileIntakeDecl). */
  file_intake?: import("@cobblr/platform-contract").FileIntakeDecl;
  /** An "Import from <service>" button on the table (ConnectorImportDecl). */
  connector_import?: import("@cobblr/platform-contract").ConnectorImportDecl;
  /** When items belong to a parent "type" in another instance (Spool →
   *  Filament type), the forms show a parent picker + write an `instance-of`
   *  pairing. `instance` is the parent instance name. */
  paste_tracking?: boolean;
  package_receiving?: { identity_field: string; storage_tracking?: boolean };
  board_revisions?: { package_kind: string; blank_kind: string; stencil_kind: string; placed_kind?: string; tested_kind?: string };
  parent?: {
    instance: string;
    label?: string;
    relationship_kind?: string;
    // Auto-lift keys: a created item carrying these find-or-creates its parent
    // type (scan path); copy_fields carry the type-defining attrs up.
    key_fields?: string[];
    copy_fields?: string[];
  };
  /** Visually group this instance with siblings sharing the same `key` into
   *  one connected navbar element (a quiet `label` stem + each member's name
   *  as a segment). Presentational + generic. */
  /** The faces this collection wears, chosen by the bundle. Keys left out are
   *  derived from signal; see docs/architecture/faces.md. */
  faces?: Partial<Record<"stock" | "perishable" | "serialized" | "maintained" | "lendable" | "container", boolean>>;
  nav_group?: {
    key: string;
    label: string;
  };
  /** Domain terms that sharpen scan ROUTING to this instance (yarn →
   *  ["yarn","skein","wool","ball-band"]). Additive — routing works off noun +
   *  fields when absent. */
  scan_keywords?: string[];
  field_defs?: PlatformBundleManifest["field_defs"];
  field_overrides?: PlatformBundleManifest["field_overrides"];
  saved_views?: PlatformBundleManifest["saved_views"];
  wires?: PlatformBundleManifest["wires"];
}

/** A catalog SHELL a bundle installs — schema config only, no rows. Mirrors the
 *  server-side CatalogEntry (bundles.ts). Rows load via CSV import or a puller. */
export interface PlatformBundleCatalog {
  external_id: string;
  name: string;
  description?: string;
  source_url?: string;
  puller_id?: string;
  schema?: {
    id_column?: string;
    title_column?: string;
    image_column?: string;
    subtitle_column?: string;
    description_column?: string;
    field_renderers?: Record<
      string,
      "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code"
    >;
    field_labels?: Record<string, string>;
    /** Catalog-match prefill: `{ catalogPayloadKey: instanceFieldName }`. */
    field_map?: Record<string, string>;
    bindable_to_kinds?: string[];
    semantic_type?: string;
    hero_field?: string;
    hero_renderer?: "text" | "color-hex" | "image-url" | "url-link" | "year" | "boolean" | "code";
    exclude_from_global_search?: boolean;
  };
}

/** An opt-in capability of a bundle — its contributions merge into the
 *  manifest when its key is enabled. */
/** A place a bundle offers to create. One level of nesting: a room with things
 *  in it. `container` is a thing you put stuff in and can label; `area` is a
 *  room. */
export interface PlatformBundleLocation {
  name: string;
  kind?: "area" | "container";
  children?: Array<{ name: string; kind?: "area" | "container" }>;
}

export interface PlatformBundleFeature {
  key: string;
  name: string;
  kind?: "integration";
  description?: string;
  /** The question form of the feature, shown in the install modal
   *  ("Want to track your designs too?"). Falls back to `name`. Display-only. */
  question?: string;
  /** Pre-checked in the install modal. Default false → installs "basic". */
  default?: boolean;
  requires?: PlatformBundleManifest["requires"];
  wires?: PlatformBundleManifest["wires"];
  field_defs?: PlatformBundleManifest["field_defs"];
  field_overrides?: PlatformBundleManifest["field_overrides"];
  saved_views?: PlatformBundleManifest["saved_views"];
  /** Instances this feature creates when enabled (e.g. the "hooks" feature
   *  creates a Hooks inventory instance). */
  provides_instances?: PlatformBundleManifest["provides_instances"];
  /** WorkspaceApps this feature seeds when enabled (e.g. the Outfit Planner). */
  provides_apps?: PlatformBundleManifest["provides_apps"];
  /** Places this feature sets up when enabled (Groceries' Fridge + Freezer). */
  provides_locations?: PlatformBundleManifest["provides_locations"];
  /** Catalog shells this feature installs when enabled (e.g. the Rebrickable
   *  catalogs behind "Link to Rebrickable"). */
  catalogs?: PlatformBundleCatalog[];
  /** Post-install guided steps (web nav only; stripped server-side). */
  next_steps?: { label: string; module: string; path?: string; hint?: string }[];
}

/** A bundle entry in the extension registry index — the manifest plus the
 *  card metadata. `source` = "official" or the third-party source URL. */
export interface RegistryBundleEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  glyph?: string;
  blurb?: string;
  requires?: string[];
  manifest: PlatformBundleManifest;
  source: string;
}
/** A declarative-HTTP driver entry (digifab). `manifest` is the full
 *  DriverManifest posted to the driver install endpoint. */
export interface RegistryDriverEntry {
  id: string;
  name: string;
  version?: string;
  glyph?: string;
  blurb?: string;
  /** "Authored from the API; verify against your hardware" style note. */
  caveat?: string;
  manifest: Record<string, unknown>;
  source: string;
}
/** A signed WASM module entry — installed via the super-admin sandbox path. */
export interface RegistryModuleEntry {
  name: string;
  version: string;
  description?: string;
  glyph?: string;
  blurb?: string;
  release_url?: string;
  pubkey?: string;
  source: string;
  /** Trust tier (Phase D): "official" = signed by a Cobblr-vouched key on
   *  a root-verified index; "unverified" = install behind a consent gate. */
  trust?: "official" | "unverified";
}
/** A sandboxed file-preview renderer (core-file-preview). `renderer_js` is
 *  untrusted code that runs only in an opaque-origin iframe. */
export interface RegistryRendererEntry {
  name: string;
  version?: string;
  exts: string[];
  description?: string;
  glyph?: string;
  blurb?: string;
  renderer_js: string;
  pubkey?: string;
  signature?: string;
  source: string;
  trust?: "official" | "unverified";
}
/** The merged extension catalog returned by GET /registry/index. */
export interface RegistryIndex {
  schema: number;
  bundles: RegistryBundleEntry[];
  drivers: RegistryDriverEntry[];
  modules: RegistryModuleEntry[];
  renderers: RegistryRendererEntry[];
  sources: Array<{ url: string; label: string; ok: boolean; error?: string }>;
  /** Whether the official index's detached sig verified against the baked
   *  root key. null = no root anchor configured (status-quo trust). */
  official_root_verified: boolean | null;
}

export const bundlesApi = {

  // Per-org module enable/disable + listing
  /** The number a module declared for its nav row (manifest `nav.count`): one
   *  GET on the module's own path, read as a plain object so the host never
   *  has to know the endpoint's shape beyond the one field it was told. */
  moduleNavCount: (slug: string, moduleName: string, path: string) =>
    request<Record<string, unknown>>("GET", `/orgs/${slug}/modules/${moduleName}${path}`),
  orgModules: (slug: string) =>
    request<{ items: OrgModuleListItem[] }>("GET", `/orgs/${slug}/modules`),
  enableModule: (slug: string, name: string) =>
    request<{ module: string; already_enabled: boolean }>(
      "POST",
      `/orgs/${slug}/modules/${name}/enable`,
    ),
  disableModule: (slug: string, name: string) =>
    request<void>("POST", `/orgs/${slug}/modules/${name}/disable`),
  setModulePart: (slug: string, name: string, part: string, enabled: boolean | null) =>
    request<{ part: { id: string; on: boolean } }>("POST", `/orgs/${slug}/module-parts/${name}/${part}`, { enabled }),

  // Vendors — managed entity (purchasing depth). Not the primary entity,
  // so it lives on the module-root route, not primaryBase.
  // Managed app: re-apply the latest bundle version if behind (auto-update on use).
  refreshApp: (slug: string) =>
    request<{ updated: boolean; from?: string; to?: string }>("POST", `/orgs/${slug}/refresh-app`, {}),
  // Graduation: copy a managed app's data into a full workspace (targetSlug).
  importApp: (targetSlug: string, sourceSlug: string) =>
    request<{ imported: number; instance: string }>("POST", `/orgs/${targetSlug}/import-app`, { source_slug: sourceSlug }),
  modules: () => request<{ items: ModuleListItem[] }>("GET", "/modules"),

  // Bundles (C.2)
  listBundles: (slug: string) =>
    request<{ items: PlatformBundle[] }>("GET", `/orgs/${slug}/bundles`),
  /** Bundles this workspace installed and later took out: never suggested again. */
  passedBundles: (slug: string) =>
    request<{ items: string[] }>("GET", `/orgs/${slug}/bundles/passed`),
  installBundle: (
    slug: string,
    manifest: PlatformBundleManifest,
    confirm?: boolean,
    enabledFeatures?: string[],
    /** One answer per upgrade conflict; a conflict with none keeps yours. */
    resolutions?: BundleConflictResolution[],
    /** The word picked for each table that offers them, by instance name. */
    nounChoices?: Record<string, string>,
  ) =>
    request<{ bundle: PlatformBundle; applied: { wires: number; field_defs: number; instances_created?: string[]; auto_enabled_modules?: string[] }; installed?: BundleInstallSummary }>(
      "POST",
      `/orgs/${slug}/bundles/install`,
      {
        manifest,
        confirm,
        enabled_features: enabledFeatures,
        ...(resolutions?.length ? { resolutions } : {}),
        ...(nounChoices && Object.keys(nounChoices).length ? { noun_choices: nounChoices } : {}),
      },
    ),
  /** Change the word a table's things are called (#3650). Every label and,
   *  for a counting word, the records on the old word follow. */
  setTableNoun: (slug: string, instance: string, singular: string) =>
    request<{ instance: string; noun: { singular: string; plural: string } }>("PUT", `/orgs/${slug}/bundles/noun`, { instance, singular }),
  validateBundle: (slug: string, manifest: PlatformBundleManifest) =>
    request<BundleValidation>("POST", `/orgs/${slug}/bundles/validate`, { manifest }),
  /** Turn a bundle's optional features on or off. One call: the api re-applies
   *  the stored manifest on its upgrade path, so fields, wires and views move
   *  and the bundle's tables keep their rows and ids. `kept` is what it read
   *  back afterwards, not what it meant to do (#2889). */
  setBundleFeatures: (slug: string, id: string, enabledFeatures: string[]) =>
    request<{
      bundle: PlatformBundle;
      features: { enabled: string[]; turned_on: string[]; turned_off: string[] };
      kept: Array<{ instance_name: string; id: string; records: number | null }>;
      removed_empty: string[];
      incomplete?: { message: string };
    }>("PATCH", `/orgs/${slug}/bundles/${id}/features`, { enabled_features: enabledFeatures }),
  /** Remove a bundle's fields, wires and views. Its instances and their records
   *  stay unless `deleteData` is set, which only the uninstall dialog's
   *  confirmation (the one that names what it deletes) sets. A feature change
   *  re-applies the bundle and never passes it (#2889). */
  uninstallBundle: (slug: string, id: string, opts: { deleteData?: boolean } = {}) =>
    request<BundleUninstallResult>("DELETE", `/orgs/${slug}/bundles/${id}${opts.deleteData ? "?delete_data=1" : ""}`),
  /** What uninstalling this bundle would tear down: its instances no other source
   *  still claims (with item counts) + modules that would be turned off. Powers
   *  the uninstall-confirm warning. */
  bundleUninstallPreview: (slug: string, id: string) =>
    request<{
      instances: { name: string; display_name: string; item_count: number }[];
      modules: string[];
      /** The same modules by name ("Cadence", not "core-cadence"). */
      module_names?: string[];
      /** Empty places the install made, which the uninstall removes. */
      places?: { id: string; name: string }[];
      /** What it leaves because someone has used it since, and why. */
      kept?: { type: "module" | "place"; name: string; reason: string }[];
    }>("GET", `/orgs/${slug}/bundles/${id}/uninstall-preview`),

  // ─── extension registry (the marketplace index — HACS-style) ───────
  // The curated cobblr-extensions index over all three lanes, merged with
  // any third-party source index URLs. Server-side fetch (token + SSRF
  // guard). Install still goes through the per-lane endpoints above.
  getRegistryIndex: (sources?: string[]) =>
    request<RegistryIndex>(
      "GET",
      `/registry/index${sources && sources.length ? `?sources=${encodeURIComponent(sources.join(","))}` : ""}`,
    ),
  /** Version history (audit F3): every removed bundle row (update-replace /
   *  uninstall / revert) is snapshotted; list them for one external_id. */
  bundleHistory: (slug: string, externalId: string) =>
    request<{
      items: Array<{
        id: string;
        external_id: string;
        name: string;
        version: string;
        reason: string;
        enabled_features: string[];
        created_at: string;
        counts: { field_defs: number; wires: number; instances: number };
      }>;
    }>("GET", `/orgs/${slug}/bundles/history/${encodeURIComponent(externalId)}`),
  /** Re-validate + re-apply a snapshot. 409 revert_invalid when the workspace
   *  has drifted (modules/kinds changed) — nothing is half-applied. */
  bundleRevert: (slug: string, snapshotId: string) =>
    request<{ bundle: { id: string; external_id: string; name: string; version: string } }>(
      "POST",
      `/orgs/${slug}/bundles/history/${snapshotId}/revert`,
    ),
  getBundle: (slug: string, id: string) =>
    request<{
      bundle: PlatformBundle & { manifest: PlatformBundleManifest; enabled_features?: string[] };
      wires: PlatformBinding[];
      field_defs: PlatformFieldDef[];
    }>("GET", `/orgs/${slug}/bundles/${id}`),
  exportBundle: (slug: string) =>
    request<{ manifest: PlatformBundleManifest }>("GET", `/orgs/${slug}/bundles/export`),

  // ─── core-apps (custom worker apps, H1) ───────────────────────────
  listApps: (slug: string) =>
    request<{ items: WorkspaceAppMeta[] }>(
      "GET",
      `/orgs/${slug}/modules/core-apps/apps`,
    ),
  getApp: (slug: string, appSlug: string) =>
    request<WorkspaceApp>(
      "GET",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}`,
    ),
  createApp: (slug: string, body: Partial<WorkspaceApp>) =>
    request<WorkspaceApp>("POST", `/orgs/${slug}/modules/core-apps/apps`, body),
  updateApp: (slug: string, appSlug: string, body: Partial<WorkspaceApp>) =>
    request<WorkspaceApp>(
      "PATCH",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}`,
      body,
    ),
  deleteApp: (slug: string, appSlug: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-apps/apps/${appSlug}`),
  /** Mint a short-lived capability-scoped token (Tier B) for the App
   *  Player to mediate a sandboxed custom frontend's reads. */
  mintAppToken: (slug: string, appSlug: string) =>
    request<{ token: string; expires_in: number }>(
      "POST",
      `/orgs/${slug}/modules/core-apps/apps/${appSlug}/token`,
    ),
  /** POST to a module path supplied by that module's own action result (the
   *  `ui.print` directive's record callback). Constrained to /modules/ so a
   *  malformed directive cannot be pointed at an arbitrary platform route. */
  postToModulePath: (slug: string, path: string, body: unknown) => {
    if (!path.startsWith("/modules/")) {
      return Promise.reject(new Error(`refusing to POST outside /modules/: ${path}`));
    }
    return request<unknown>("POST", `/orgs/${slug}${path}`, body);
  },
};
