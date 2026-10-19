import type { ComputedContextProvider, CreateDefaultsContext, CreateDefaultsProvider, DeviceApplyContext, DeviceApplyProvider, EntityCounterDef, EntityInstanceListResolver, EntityInstanceResolver, EntityListQuery, EntityListResolver, EntityListResult, EntityResolver, EntityUpdater, EntityViewer, EntityWriter, ListResolverOptions, ResolvedEntity, ScannableInfo, ScannableKind, ShareChildren } from "@cobblr/platform-contract/entity-resolvers";
import type { DefinedField, RoledField } from "@cobblr/platform-contract/roled-facts";
import type { EntityFieldDecl } from "@cobblr/platform-contract/module-manifest";
import type { RawTraitsDecl } from "@cobblr/platform-contract/traits";

export interface PlatformEntities {
  /** Register a resolver for one kind. Called from a module's
   *  api/index.ts at module-load time. */
  registerResolver(kind: string, resolver: EntityResolver): void;
  /** Declare rows that belong to a record and travel with it when it is
   *  shared (ShareChildren, #6252). Called at module-load time. */
  registerShareChildren(def: ShareChildren): void;
  /** The child sets declared for a module kind. */
  shareChildrenFor(kind: string): ShareChildren[];
  /** Register an in-process WRITER for one kind (create/update/delete).
   *  Lets cross-module writers (the sync engine) mutate this kind without
   *  an HTTP loopback or user token. */
  registerWriter(kind: string, writer: EntityWriter): void;
  /** Resolve the writer for a kind, or null.
   *
   *  Org-scoped because an INSTANCE kind (`<instance>:item` — a Bookshelf, a
   *  Wardrobe) exists only per-workspace and is never registered: only the
   *  owning module's real kind is. A by-kind-alone lookup misses on every one
   *  of them and the miss looks exactly like "this kind is not writable", so
   *  the caller quietly skips the write. Pass the org and instances resolve. */
  getWriter(orgId: string, kind: string): Promise<EntityWriter | null>;
  /** Set a few metadata keys on any record, whatever module owns it, leaving
   *  the rest as they are (the kind's writer's `mergeMetadata`). False when
   *  the kind cannot do it, so the caller can say so instead of claiming a
   *  write. Instance kinds resolve like getWriter. */
  mergeMetadata(orgId: string, kind: string, id: string, fields: Record<string, unknown>): Promise<boolean>;
  /** Put a row back exactly as it was, id and all. True when the kind's writer
   *  can do it; false when nothing here can, so the caller can fall back and
   *  say what it actually did instead of claiming a restore. */
  restore(orgId: string, kind: string, image: Record<string, unknown>): Promise<boolean>;
  /** The whole row for a record, when its kind can produce one — what a change
   *  ledger stores so an undo has real state to put back. */
  snapshot(orgId: string, kind: string, id: string): Promise<Record<string, unknown> | null>;
  /** What would be deleted along with this record. Empty when nothing would be;
   *  null when the kind cannot say (and a caller must not read that as "safe"). */
  dependents(orgId: string, kind: string, id: string): Promise<string[] | null>;
  /** Register a list-resolver for a kind. Optional — without one,
   *  list() returns an empty result. Modules opt in when they want
   *  their kind to appear in core-views, search results, etc. */
  registerListResolver(kind: string, resolver: EntityListResolver, options?: ListResolverOptions): void;
  /** Register a list-resolver for the items of any instance of a multi-instance
   *  module (keyed by module name). The platform invokes it for
   *  `<instance_name>:item` kinds. Lets instance entities appear in
   *  views/`data`/search/calendar through the generic layer. */
  registerInstanceListResolver(
    moduleName: string,
    resolver: EntityInstanceListResolver,
    options?: ListResolverOptions,
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
  /** Opt a kind in to `platform:update-fields`, the one verb an app form, the
   *  API and the assistant edit a record through. `capability` is the grant
   *  the module already asks for on its own PATCH (a member needs it; an
   *  owner or admin passes), so this door is never wider than that one. A
   *  module whose PATCH asks only for a member (no grant) omits it.
   *  `nativeFields` names the kind's own columns the updater takes, so an
   *  edit form offers no field the updater would then refuse.
   *  Example (in modules/inventory):
   *    platform().entities.registerUpdater("inventory:part", updatePartFields,
   *      { capability: "inventory:update-part" }); */
  registerUpdater(kind: string, updater: EntityUpdater, opts?: { capability?: string; nativeFields?: readonly string[] }): void;
  /** The updater registered for a kind, or null when the kind is not
   *  updatable this way. */
  updaterFor(kind: string): { update: EntityUpdater; capability: string | null; nativeFields: ReadonlySet<string> | null } | null;
  /** Every kind that registered an updater. */
  updatableKinds(): string[];
  /** Can records of `kind` (a collection's `<instance>:item` included) be
   *  edited through `platform:update-fields` in this workspace? */
  isUpdatable(orgId: string, kind: string): Promise<boolean>;
  /** Declare a kind as a scan target (core-scan reads this instead of a
   *  hardcoded allowlist). Called at boot by the owning module, e.g.
   *  platform().entities.registerScannable("inventory:part",
   *    { noun: "part", createEndpoint: "inventory/parts", qtyField: "qty" }). */
  registerScannable(kind: string, info: ScannableInfo): void;
  registerLabelValuesProvider(name: string, provider: (orgId: string, kind: string, id: string) => Promise<string[]>): void;
  labelValuesFor(orgId: string, kind: string, id: string): Promise<string[]>;
  /** The scan info for a kind, or null if it isn't a scan target. */
  getScannable(kind: string): ScannableInfo | null;
  /** The scan info for a MODULE, regardless of which of its kinds is asked for.
   *  Scannability is a module-level property (create endpoint + qty field), but a
   *  caller may hold an INSTANCE-scoped kind ("vehicles:item") rather than the
   *  registered base kind ("assets:asset") — the instance routes the create
   *  separately, so the module's one scannable still applies. Resolves by the
   *  module prefix; null if the module has no scan target. */
  getScannableForModule(module: string): ScannableInfo | null;
  /** Every registered scan target as { kind, ...info } — core-scan builds its
   *  scan menu from this (which modules/kinds are scannable + their nouns).
   *  BASE kinds only, one per module: the answer to "which modules can be
   *  scanned into", never to "which kinds hold records here". */
  listScannable(): Array<{ kind: string } & ScannableInfo>;
  /** The scannable kinds THIS workspace has, instances included: each of
   *  listKindsForOrg's records that is scannable (an instance kind inherits
   *  its module's scannable), with the module, the instance it lives in and
   *  the record. The one answer for anything that walks a workspace's
   *  RECORDS across kinds: a base-registry walk sees no grocery and no yarn
   *  and looks like it worked (#3132). */
  listScannableForOrg(orgId: string): Promise<ScannableKind[]>;
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
   *  `fields` IS A SUBSET, NEVER THE WHOLE RECORD. exposableFields is curated
   *  by the owning module - inventory withholds notes, cost and supplier_url
   *  from cross-module readers on purpose. So this is the right
   *  way to READ ABOUT an entity and the wrong way to COPY one: anything that
   *  reads a record here and then destroys the original (a merge, a move
   *  between kinds, an export-and-delete) silently loses every field the module
   *  chose not to expose. Read the whole row through the module's OWN CRUD
   *  route under the caller's bearer instead, the way core-scan's attach and
   *  duplicates/merge do. Caught in review 2026-09-04, in a merge that would
   *  have deleted the duplicate's notes along with it.
   *
   *  `viewer.userId` is used by the M1 v0.5 per-link role gate:
   *  cross-workspace fall-through respects `min_target_role` on
   *  workspace_links. Omit for system / anonymous callers — only
   *  unrestricted links qualify in that case. */
  lookup(
    orgId: string,
    kind: string,
    id: string,
    viewer?: EntityViewer,
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
   *  for. Owner/admin see everything. Omitting the viewer is fail-closed:
   *  a gated field (a custom one in `metadata` too) is withheld, so a door
   *  that forgot its reader can never leak one. Internal logic that
   *  decides something from the truth (an undo asking whether a field
   *  still holds values, a matcher, a sweeper) passes SYSTEM_VIEWER. */
  list(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: EntityViewer,
  ): Promise<EntityListResult>;
  /** Every record the query answers, walked a page at a time (list() answers
   *  one page, usually 50, when no limit is asked). `total` is the
   *  resolver's count, else the walked count once complete, else null;
   *  `complete` is false only past `cap` (default 5000). A surface that
   *  shows "all of them" uses this and shows `total`, never a page length. */
  listAll(
    orgId: string,
    kind: string,
    query?: EntityListQuery,
    viewer?: EntityViewer,
    opts?: { pageSize?: number; cap?: number },
  ): Promise<Omit<EntityListResult, "total"> & { total: number | null; complete: boolean }>;
  /** The fields of a kind `viewer` may not read (field read scopes). A
   *  writer of rows that are not read through list() or lookup() (a module's
   *  own export) drops these, so a hidden field is never a column. */
  hiddenFields(orgId: string, kind: string, viewer: { userId?: string; role?: string }): Promise<Set<string>>;
  /** Every record the query answers as a spreadsheet, read as `viewer`:
   *  a field their role may not read is neither a column nor a value, a
   *  relabelled field is under its label, a hidden one is left out. `only`
   *  (a view's visible fields) picks and orders the columns after the name.
   *  Null when the workspace has no such kind. */
  exportCsv(
    orgId: string,
    kind: string,
    query: EntityListQuery,
    viewer: { userId?: string; role?: string },
    only?: string[],
    options?: { includeSecrets?: boolean },
  ): Promise<{ csv: string; filename: string; rows: number; complete: boolean } | null>;
  /** Batched lookup — resolve N (kind, id) refs in one call. Foreign
   *  callers that need joined data should use this instead of N
   *  separate single-hop calls. Same projection rules as lookup().
   *  Refs that don't resolve are silently skipped (callers get fewer
   *  results than they asked for, matchable by kind+id). Order is
   *  not guaranteed. */
  lookupMany(
    orgId: string,
    refs: ReadonlyArray<{ kind: string; id: string }>,
    viewer?: EntityViewer,
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
  /** Can list() answer for this kind in this workspace (a list resolver,
   *  its module enabled)? A kind that cannot always lists empty. */
  listable(orgId: string, kind: string): Promise<boolean>;
  /** List all declared kinds from cobblr_meta.entity_kinds. */
  listKinds(): Promise<EntityKindRecord[]>;
  /** listKinds plus one synthesized `<instance>:item` kind per named
   *  instance in the org (shape copied from the module's PRIMARY kind;
   *  endpoints relative to /instances/<name>, marked by instance_name). */
  listKindsForOrg(orgId: string): Promise<EntityKindRecord[]>;
  /** Get a single kind's full declaration. */
  getKind(kind: string): Promise<EntityKindRecord | null>;
  /**
   * The workspace's field defs FOR THIS KIND that declare a role, with trait
   * scopes already resolved.
   *
   * A module cannot work this out for itself. A field scoped to `@physical`
   * applies to `inventory:part` through the same predicate the action registry
   * uses, and that matcher is a kernel internal: reading `module_field_defs`
   * directly and filtering on `entity_kind = kind` silently misses every
   * trait-scoped field, which is precisely where the interesting ones (origin,
   * acquisition) live.
   *
   * So the kernel answers the question and modules ask it. Returns only defs
   * with a `field_role`, because the callers are the ones that act on MEANING
   * rather than on a name.
   */
  roledFieldsFor(orgId: string, kind: string): Promise<RoledField[]>;
  /** Every field the workspace defines on `kind`, roled or not, in display
   *  order, trait-scoped ones included - the columns a table of this kind
   *  shows beyond the module's own. For the surfaces that must carry the WHOLE
   *  record rather than act on meaning: a CSV export that drops these ships a
   *  bookshelf without its authors (2026-09-12), and an import that cannot
   *  name them has nowhere to put them back. */
  fieldsFor(orgId: string, kind: string): Promise<DefinedField[]>;
  sealSecretFields(orgId: string, kind: string, fields: Record<string, unknown>, id?: string, current?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** What a kind counts as it is used: the module's own counters
   *  (EntityWriter.counters) and every number field marked with the `usage`
   *  role. The one answer for "every [5000] [miles]". */
  countersFor(orgId: string, kind: string): Promise<EntityCounterDef[]>;
  /** One record's reading of each of those counters (null when unread). */
  readCounters(orgId: string, kind: string, id: string): Promise<Record<string, number | null>>;
  /** The ONE resolver for where a QR/scan/search hit for an entity should land,
   *  INSTANCE AWARE — shared by the QR-token resolver, the scan registry, and
   *  search so they can't drift (they were three hand-kept copies that each
   *  hand-substituted `{id}` into a base detail_route and so mis-routed an item in
   *  a NAMED instance to the empty base page). It resolves the entity, probes the
   *  module's named instances when the base kind can't see it, and picks the
   *  per-instance route. Returns undefined when the entity has no reachable page. */
  detailPathForEntity(orgId: string, kind: string, id: string): Promise<string | undefined>;
  /** A record's complete browser address, INSTANCE AWARE and WORKSPACE
   *  QUALIFIED. This is the address for anything that leaves the app, such as
   *  a library write-back, notification channel, calendar feed or export.
   *  `origin` overrides the configured public origin for an inbound request. */
  recordAddressForEntity(orgId: string, kind: string, id: string, origin?: string | null): Promise<string | undefined>;
  /** The entity's current system TITLE, INSTANCE AWARE — the stock name, re-resolved
   *  live. Same instance probe as detailPathForEntity: tries the given kind, and if
   *  that base lookup can't see an item in a NAMED instance, probes the module's
   *  named instances. Lets a caller (the label queue) offer "revert this trimmed
   *  caption to the system name". null when the entity no longer resolves. */
  titleForEntity(orgId: string, kind: string, id: string): Promise<string | null>;
  /** The kind id an entity ACTUALLY lives under, INSTANCE AWARE: the given base
   *  `kind` for a default-instance entity, or `<instance_name>:item` when it's in
   *  a named instance the base kind can't see (a machine under "3D Printers").
   *  Pair with a kind's display label (listKindsForOrg) to show an instance-aware
   *  name instead of the raw `module:kind`. Falls back to `kind` when unresolved. */
  resolvedKindForEntity(orgId: string, kind: string, id: string): Promise<string>;
  /** The MODULE kind behind a kind string: identity for a registered kind,
   *  `<instance>:item` → its owning module's primary kind.
   *
   *  Instance kinds are synthesized per-org and never stored in entity_kinds,
   *  so any registry keyed by kind (actions, traits, the event payload-key
   *  convention) misses on one and returns nothing — silently. Resolve through
   *  here before such a lookup. Reads (`lookup`/`list`/`lookupMany`) don't need
   *  it; they fall back at the resolver level. */
  baseKindOf(orgId: string, kind: string): Promise<string>;
  /** The module kind behind a kind string AND the named instance it lives in:
   *  `groceries:item` → { base: "inventory:part", instance: "groceries" }; a
   *  module's own kind → { base: itself, instance: null }. The instance-kind
   *  grammar lives in the kernel alone; a caller that needs both halves reads
   *  them here rather than parsing the string. */
  resolveKind(orgId: string, kind: string): Promise<{ base: string; instance: string | null }>;
  /** Inject `<name>_label` for the relation/member fields on rows a module
   *  queried itself, so a record reads the same whichever URL asked for it.
   *  The generic entity resolver already does this; a module's own list route
   *  is a second read path and must not skip it. No-op for kinds with no such
   *  fields, so it is safe to call unconditionally. Batched across the page. */
  withFieldLabels<T extends Record<string, unknown>>(
    orgId: string,
    kind: string,
    rows: T[],
  ): Promise<T[]>;
  /** The names of a kind's SERVER-MANAGED custom fields (field defs with
   *  `server_managed = true`, e.g. core-mobility's `away_since`). A write
   *  route uses this to preserve the stored value across an unrelated client
   *  edit rather than accepting the client's — metadata is written wholesale
   *  (read-modify-write), so a stale client value would otherwise clobber a
   *  server-stamped one. Empty for kinds with no such fields (a no-op). */
  serverManagedFields(orgId: string, kind: string): Promise<string[]>;
}

export interface EntityKindRecord {
  id: string;
  module_name: string;
  /** The owning module's instanceability ("multi" = a workspace can create
   *  named instances of it — the AI builder uses this to know which modules
   *  can back a new provides_instances entry). Resolved from the registry at
   *  read time; "single" when unknown. */
  module_instanceability?: "single" | "multi";
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: EntityFieldDecl[];
  detail_route: string | null;
  endpoints: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** The module's primary kind (see the manifest `primary` flag). */
  is_primary?: boolean;
  /** Set ONLY on registry records synthesized for a workspace's named
   *  instances (`<instance>:item`): endpoints are then relative to
   *  /orgs/:slug/instances/<instance_name>, NOT /modules/<module_name>. */
  instance_name?: string;
  version: string;
  /** Resolved 6-axis trait fingerprint (or null if the kind declared
   *  no traits). Used by action matching when an action's appliesTo
   *  predicate specifies `traits: [...]`. */
  traits: RawTraitsDecl | null;
  /** Preset name (e.g. "owned-thing") if the manifest used profile
   *  shorthand. Bookkeeping for tooling. */
  profile: string | null;
  /** Labeling hint declared by the owning module: the default for
   *  drawing the human-readable code in the QR center when a workspace
   *  hasn't set an explicit per-kind toggle. Null = undeclared (the
   *  labels module treats null/absent as true — today's behavior). The
   *  labels module reads this generically off the registry rather than
   *  branching on any kind string. See docs/design-decisions/label-codes.md. */
  label_code_overlay_default: boolean | null;
  /** Cross-module read whitelist. Null = legacy (full fields returned,
   *  deprecation logged). Array = the names of fields foreign callers
   *  may read; the kernel projects ResolvedEntity.fields to this list
   *  before returning to a non-owning module. The implicit cross-cutting
   *  props (id/title/subtitle/image_path/detailUrl) are always exposable
   *  regardless of this list. See docs/architecture/entity-resolver.md. */
  exposable_fields: string[] | null;
  /** Field that scopes duplicate detection for this kind, or "workspace";
   *  null means it is never deduplicated (see the EntityKind manifest field). */
  duplicate_scope?: string | null;
}
