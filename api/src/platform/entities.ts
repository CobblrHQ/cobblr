import { aggregateOf } from "@cobblr/platform-contract/field-aggregate";
import { GroupingError, normalizeGrouping } from "@cobblr/platform-contract/grouped-list";
import { moneyStorageOf } from "@cobblr/platform-contract/money";
import { resolveFieldDefsForKind } from "./field-defs.js";
import { currency as workspaceCurrency } from "./money.js";
// Entity Kind Registry runtime. Two responsibilities:
//
//   1. The cobblr_meta.entity_kinds table is the source of truth
//      for "what kinds exist?". Populated at boot from each
//      module's manifest.provides.entityKinds.
//
//   2. Modules register an in-process resolver per kind they own;
//      the platform routes platform.entities.lookup() calls to
//      those resolvers. No HTTP loopback.
//
// The kernel also enforces the cross-module READ trust boundary
// here: when a kind declares `exposableFields` in its manifest,
// `lookup()` projects ResolvedEntity.fields to that whitelist
// before returning. Anything not declared is private to the owning
// module. See docs/architecture/entity-resolver.md.

import { deletionWriter } from "./deleted-records.js";
import { historyWriter } from "./history-writes.js";
import { secretWriter, secretReadContextFor } from "./secret-fields.js";
import { runSecretPresence } from "./secret-presence.js";
import { isStoredSecret, isMaskedSecret, maskSecretValues, omitSecretValues, type SecretReadContext } from "@cobblr/platform-contract/secret-field";
import { noteResolverFailure } from "./resolver-failures.js";
import { sql, type Kysely } from "kysely";
import { perReadRequest, perRequest } from "../lib/request-context.js";
import type {
  EntityKindRecord,
  EntityInstanceListResolver,
  EntityInstanceResolver,
  EntityListQuery,
  EntityListResolver,
  EntityListResult,
  EntityResolver,
  EntityWriter,
  ResolvedEntity,
} from "@cobblr/platform-contract";
import { walkListPages } from "./entity-list-walk.js";
import { platform, viewQuery, SYSTEM_VIEWER, TRAIT_PRESETS, stockDisclosureFromConfig, traitAxisValue, isTextWhereOp, type EntityViewer, type FilterPredicate, type ListResolverOptions } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { instanceKindName } from "./instance-kind.js";
import { INSTANCE_ITEM_DETAIL, resolveDetailPath } from "@cobblr/platform-contract/instance-detail";
import { recordAddress } from "@cobblr/platform-contract/record-address";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { IMPLICIT_EXPOSABLE_PROPS } from "@cobblr/platform-contract/entity-metadata";
import { canonicalModuleName, getEntry, list as listManifests } from "../modules/registry.js";
import { assertModulesMounted } from "../modules/mount-state.js";

// Re-export so callers reaching detail-path logic through `entities` keep working
// while the ONE decision lives in the DB-free instance-detail module.
export { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";
import { applyCustomFieldValues } from "./custom-field-values.js";
import { applyComputedFields } from "./computed-fields.js";
import { applyRelationFields } from "./relation-fields.js";
import { applyMemberFields } from "./member-fields.js";
import { applyServedTitle } from "./served-title.js";
import { normalizeEntitySort } from "./sort.js";
import { fieldsNamedBy, refuseUnreadableFields } from "./field-scope-projection.js";
import { effectiveCapabilities } from "../auth/effective-capabilities.js";
import { ORG_ROLE_RANK } from "@cobblr/platform-contract/org-roles";
import { ttlCache } from "../lib/ttl-cache.js";

const resolvers = new Map<string, EntityResolver>();
const listResolvers = new Map<string, EntityListResolver>();
// Per-module resolver for the items of ANY of its instances. The platform
// calls it for `<instance_name>:item` kinds (resolving instance→module below),
// so views/data/search/calendar see instance entities through the generic
// layer. Modules register once (not per instance).
const instanceListResolvers = new Map<string, EntityInstanceListResolver>();
// The kinds and instance modules whose resolver runs `contains` itself (#6896).
// For any other, a text predicate is reported unapplied before the call: the
// resolvers skip an op they do not know, and would answer with everything.
const textOpsKinds = new Set<string>();
const textOpsModules = new Set<string>();
// The same for filter._tag: a resolver that does not say it runs it answers
// with every record, tagged or not (#7840).
const tagKinds = new Set<string>();
const tagModules = new Set<string>();

export function registerInstanceListResolver(
  moduleName: string,
  resolver: EntityInstanceListResolver,
  options: ListResolverOptions = {},
): void {
  instanceListResolvers.set(moduleName, resolver);
  if (options.textOps) textOpsModules.add(moduleName);
  else textOpsModules.delete(moduleName);
  if (options.tags) tagModules.add(moduleName);
  else tagModules.delete(moduleName);
}

// Single-entity twin of instanceListResolvers — lets a `<name>:item` LOOKUP
// resolve (and get computed fields) through the owning module, the same way
// list() does. Without this, instance detail/lookup returned null and computed
// fields never surfaced on instance pages.
const instanceResolvers = new Map<string, EntityInstanceResolver>();

export function registerInstanceResolver(
  moduleName: string,
  resolver: EntityInstanceResolver,
): void {
  instanceResolvers.set(moduleName, resolver);
}

/** The MODULE kind behind a kind string: identity for a real registered kind,
 *  and `<instance>:item` → its owning module's primary kind.
 *
 *  Instance kinds are synthesized per-org at read time and never land in
 *  `entity_kinds`, so anything keyed by the registry (actions, traits, the
 *  payload-key convention) misses on one and returns nothing — no error, just
 *  silence. Route those lookups through here. `lookup`/`list` don't need it:
 *  they have resolver-level fallbacks that reach the same records.
 *
 *  Checks the registry FIRST because a genuine module kind can look exactly
 *  like an instance one — `lists:item` is the lists module's own kind, and
 *  mapping it away would break lists. */
export async function baseKindOf(orgId: string, kind: string): Promise<string> {
  return (await resolveKind(orgId, kind)).base;
}

/** Both halves of a kind string: the module kind it resolves to and the
 *  named instance it lives in (null for a module's own kind, or for an
 *  instance name this workspace does not have). Registry first, because a
 *  genuine module kind can look like an instance one (`lists:item`). */
/** The registered kinds and each module's primary kind, read once and kept.
 *  resolveKind runs per record, and it asked the database "is this a
 *  registered kind?" every time: a list or a batch of a few hundred records
 *  queued 333 callers on the 80-client meta pool in CI (run 36982, #4876),
 *  every holder that same one-row lookup. The registry changes only when
 *  syncManifestRegistries writes it (boot, a module installed), which clears
 *  this; a minute's age bounds what another api process's sync can leave
 *  stale here. */
type KindRegistry = { at: number; ids: Set<string>; primaryByModule: Map<string, string> };
let kindRegistry: KindRegistry | null = null;
let kindRegistryLoading: Promise<KindRegistry> | null = null;
const KIND_REGISTRY_MAX_AGE_MS = 60_000;

async function kindRegistryNow(): Promise<KindRegistry> {
  if (kindRegistry && Date.now() - kindRegistry.at < KIND_REGISTRY_MAX_AGE_MS) return kindRegistry;
  kindRegistryLoading ??= meta
    .selectFrom("entity_kinds")
    .select(["id", "module_name", "is_primary"])
    .execute()
    .then((rows) => {
      const primaryByModule = new Map<string, string>();
      for (const r of rows) if (r.is_primary && !primaryByModule.has(r.module_name)) primaryByModule.set(r.module_name, r.id);
      kindRegistry = { at: Date.now(), ids: new Set(rows.map((r) => r.id)), primaryByModule };
      return kindRegistry;
    })
    .finally(() => {
      kindRegistryLoading = null;
    });
  return kindRegistryLoading;
}

export async function resolveKind(orgId: string, kind: string): Promise<{ base: string; instance: string | null }> {
  const registry = await kindRegistryNow();
  if (registry.ids.has(kind)) return { base: kind, instance: null };

  const name = instanceKindName(kind);
  if (!name) return { base: kind, instance: null };
  const inst = await meta
    .selectFrom("workspace_module_instances")
    .select(["module_name"])
    .where("org_id", "=", orgId)
    .where("instance_name", "=", name)
    .executeTakeFirst();
  if (!inst) return { base: kind, instance: null };

  // A module with no primary kind (lists) leaves the kind as-is rather than
  // guessing one of several; the instance is still the instance.
  return { base: registry.primaryByModule.get(inst.module_name) ?? kind, instance: name };
}

/** For a `<name>:item` kind with no exact single-entity resolver, find the
 *  instance's owning module + its registered instance resolver, bound to the
 *  instance name. Returns a plain EntityResolver, or null. Mirrors
 *  instanceFallbackResolver (the list twin). */
// Single-flight, not a cache (ttl 0): a list resolving its rows at once asks
// these the same question once per row, and every row's ask used to be its
// own meta query. GET /labels/queue with 60 labels held the whole meta pool on
// staging, and the requests waiting behind it answered 503 (#5875). Concurrent
// identical asks now share one query; nothing is kept once it answers, so a
// write is never followed by a stale read.
const instanceModuleInFlight = ttlCache<{ module_name: string } | undefined>(0);
const linkedSourcesInFlight = ttlCache<Array<{ id: string; slug: string; name: string }>>(0);

async function instanceFallbackEntityResolver(
  orgId: string,
  kind: string,
): Promise<EntityResolver | null> {
  const m = /^([a-z0-9][a-z0-9-]*):item$/.exec(kind);
  if (!m) return null;
  const instanceName = m[1]!;
  const row = await instanceModuleInFlight.get(`${orgId}:${instanceName}`, () =>
    meta
      .selectFrom("workspace_module_instances")
      .select(["module_name"])
      .where("org_id", "=", orgId)
      .where("instance_name", "=", instanceName)
      .executeTakeFirst(),
  );
  if (!row) return null;
  // A module's instance resolver may answer with its base kind on the row
  // (inventory's says inventory:part); the row is the requested kind here,
  // once, for every read path that goes through this (#7153).
  const fn = instanceResolvers.get(row.module_name);
  if (fn) return async (oid, id) => asRequested(await fn(oid, instanceName, id), kind);
  // A module that registered only its kind's resolver still answers for the
  // rows of its instances: read by the module kind, keep only this instance's
  // row. Without it every generic read of a sales instance's order came back
  // empty, and a label naming the order's own field printed its placeholder
  // (#3591). A resolver that does not report `instance` answers nothing here,
  // which is the safe side of the choice.
  const { base } = await resolveKind(orgId, kind);
  const baseFn = base !== kind ? resolvers.get(base) : undefined;
  if (!baseFn) return null;
  return async (oid, id) => {
    const e = await baseFn(oid, id);
    return e && (e.fields as Record<string, unknown> | undefined)?.instance === instanceName ? asRequested(e, kind) : null;
  };
}

/** A resolved row presented as the kind it was asked for. */
function asRequested<E extends { kind: string }>(e: E | null, kind: string): E | null {
  return e && e.kind !== kind ? { ...e, kind } : e;
}

/** For a `<name>:item` kind with no exact list resolver, find the instance's
 *  owning module + its registered instance resolver, bound to the instance
 *  name. Returns a plain EntityListResolver, or null if the kind isn't an
 *  instance / the module didn't register one. (Queries the meta-side
 *  workspace_module_instances directly to avoid an import cycle.) */
async function instanceFallbackResolver(
  orgId: string,
  kind: string,
): Promise<EntityListResolver | null> {
  const m = /^([a-z0-9][a-z0-9-]*):item$/.exec(kind);
  if (!m) return null;
  const instanceName = m[1]!;
  const row = await meta
    .selectFrom("workspace_module_instances")
    .select(["module_name"])
    .where("org_id", "=", orgId)
    .where("instance_name", "=", instanceName)
    .executeTakeFirst();
  if (!row) return null;
  const fn = instanceListResolvers.get(row.module_name);
  if (!fn) return null;
  const resolve: EntityListResolver = (oid, query) => fn(oid, instanceName, query);
  if (textOpsModules.has(row.module_name)) textOpsResolvers.add(resolve);
  if (tagModules.has(row.module_name)) tagResolvers.add(resolve);
  return resolve;
}
const textOpsResolvers = new WeakSet<EntityListResolver>();
const tagResolvers = new WeakSet<EntityListResolver>();

// In-process cache of the exposable-fields whitelist per kind. Filled
// lazily on first lookup; kept until process restart (kinds rarely
// change at runtime, and any change cycles through registry-sync at
// boot anyway).
const exposableFieldsCache = new Map<string, string[] | null>();

// In-process cache of the per-field read-scope map per kind (H2):
// { field_name: required_capability }. Same lifecycle as the
// exposable-fields cache. Null = no per-field gating for the kind.
const fieldReadScopesCache = new Map<string, Record<string, string> | null>();

// The modules a workspace has enabled, memoised briefly. Enablement CHANGES at
// runtime (enable/disable a module), so unlike the whitelist caches above this
// one must expire rather than live until restart.
const ENABLED_MODULES_TTL_MS = 30_000;
const enabledModulesCache = ttlCache<Set<string>>(ENABLED_MODULES_TTL_MS);

/** Has `orgId` enabled `moduleName`? Presence of an `org_modules` row is the
 *  signal - there is no enabled flag, disabling deletes the row.
 *
 *  Fails OPEN: meta being unreachable is not the same as "nothing is enabled",
 *  and answering "disabled" on a blip would make every list silently empty. */
export async function moduleEnabledForOrg(orgId: string, moduleName: string): Promise<boolean> {
  moduleName = canonicalModuleName(moduleName);
  try {
    const names = await enabledModulesCache.get(orgId, async () => {
      const rows = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", orgId)
        .execute();
      return new Set(rows.map((r) => r.module_name));
    });
    return names.has(moduleName);
  } catch {
    return true;
  }
}

/** Whether a kind's resolver may run against this workspace. A registered
 *  kind's module may be off there, and then it has no tables: its resolver can
 *  only raise `relation "<x>" does not exist`, which /healthz and deploy-gap
 *  count as a failing resolver (#7579). Every read path asks here, its own
 *  workspace and each linked source alike. A kind found only as an instance is
 *  org-scoped by its fallback already. */
async function kindModuleOn(orgId: string, kind: string, registered: boolean): Promise<boolean> {
  return !registered || (await moduleEnabledForOrg(orgId, kind.split(":")[0]!));
}

// One-time deprecation warning per kind that's still on the legacy
// (null) whitelist. Avoids log spam on hot paths.
const legacyWarnedKinds = new Set<string>();

/** A viewer's effective field-read access, resolved by the caller
 *  (the member-facing read endpoint) and passed into the projection.
 *  `all` — owner/admin: see every field regardless of scope.
 *  `caps` — the capability action_ids the viewer holds.
 *  Omitting the readScope entirely (viewer-less system / admin module
 *  API reads) means "see everything" — fully backward-compatible. */
export interface ViewerReadScope {
  all: boolean;
  caps: ReadonlySet<string>;
}

/** What SYSTEM_VIEWER reads with: everything. */
const SYSTEM_READ_SCOPE: ViewerReadScope = { all: true, caps: new Set() };

async function viewerReadScope(orgId: string, fieldReadScopes: Record<string, string> | null, viewer?: EntityViewer): Promise<ViewerReadScope | undefined> {
  if (viewer?.system) return SYSTEM_READ_SCOPE;
  if (!fieldReadScopes || !viewer) return undefined;
  return viewer.userId
    ? effectiveCapabilities(orgId, viewer.userId, viewer.role ?? "member")
    : { all: false, caps: new Set() };
}


/** The fields a reader may see on THIS workspace's records: the kind's
 *  exposable fields, and, for the person's own assistant, the fields the kind
 *  lets that assistant read too (a part's notes, #4798). Never used for a
 *  linked workspace's records, which keep the plain whitelist. */
async function ownWhitelist(orgId: string, kind: string, whitelist: string[] | null, viewer?: EntityViewer): Promise<string[] | null> {
  if (whitelist === null) return whitelist;
  // A person exporting their own collection gets every field their table
  // shows them, not the narrower set a foreign module may read: an export
  // through the whitelist wrote a Notes column with every cell blank (#7630).
  // Read scopes and secret masking still apply after this.
  if (viewer?.export && !viewer.assistant) {
    const record = (await listKindsForOrg(orgId)).find((k) => k.id === kind);
    return [...new Set([...whitelist, ...(record?.fields ?? []).map((f) => f.name)])];
  }
  if (!viewer?.assistant) return whitelist;
  const base = await baseKindOf(orgId, kind).catch(() => kind);
  const extra = assistantReadableFieldsOf(kind) ?? assistantReadableFieldsOf(base) ?? [];
  return extra.length ? [...new Set([...whitelist, ...extra])] : whitelist;
}

function assistantReadableFieldsOf(kind: string): string[] | null {
  for (const m of listManifests()) {
    const k = (m.provides?.entityKinds ?? []).find((x) => x.id === kind);
    if (k) return k.assistantReadableFields ?? null;
  }
  return null;
}

/** The registered kind whose field read scopes govern `kind` in this
 *  workspace: itself when registered, and for a named collection
 *  (`supplies:item`) its module's primary kind. A named collection is never
 *  in entity_kinds, so reading its scopes by its own id found none, and a
 *  member without inventory:view-costs read a part's cost through the
 *  collection (#7117). The field whitelist stays the collection's own: its
 *  reads return notes and serials the primary's list leaves out (#3807). */
async function policyKind(kind: string, orgId?: string): Promise<string> {
  if (!orgId) return kind;
  return perRequest(`policy-kind:${orgId}:${kind}`, () => baseKindOf(orgId, kind).catch(() => kind));
}

async function getExposableFields(kind: string): Promise<string[] | null> {
  if (exposableFieldsCache.has(kind)) {
    return exposableFieldsCache.get(kind) ?? null;
  }
  const row = await meta
    .selectFrom("entity_kinds")
    .select(["exposable_fields"])
    .where("id", "=", kind)
    .executeTakeFirst();
  const list = (row?.exposable_fields as string[] | null | undefined) ?? null;
  exposableFieldsCache.set(kind, list);
  return list;
}

/** Per-field read-scope map for a kind (H2): { field: capability }, or
 *  null when the kind gates no fields. The MANIFEST-declared scopes are
 *  cached by kind; per-WORKSPACE admin overrides (workspace_field_scopes)
 *  are merged on top when an orgId is given — "a workspace owner defines their own
 *  tiers." Per-org entries win. The per-org read is one small indexed
 *  query per resolver call (not per row), so it's cheap; not cached, so
 *  admin edits take effect immediately. */
/** A kind's read scopes in a workspace, for a caller outside this file (the wire
 *  engine holds an automation's event to them). */
export function fieldReadScopesOf(kind: string, orgId: string): Promise<Record<string, string> | null> {
  return getFieldReadScopes(kind, orgId);
}

async function getFieldReadScopes(
  kind: string,
  orgId?: string,
  reader?: unknown,
): Promise<Record<string, string> | null> {
  // A named collection takes its base kind's policy (#7117) for anyone
  // reading it; the workspace's own scopes on the base apply to it too, and
  // its own on top. A read with no viewer is a module's own work (a VIN
  // fill, a kit's stock check): without a reader there is nobody to hide a
  // field from, and the fail-closed projection would blind it.
  const base = reader ? await policyKind(kind, orgId) : kind;
  let manifest: Record<string, string> | null;
  if (fieldReadScopesCache.has(base)) {
    manifest = fieldReadScopesCache.get(base) ?? null;
  } else {
    const row = await meta
      .selectFrom("entity_kinds")
      .select(["field_read_scopes"])
      .where("id", "=", base)
      .executeTakeFirst();
    manifest =
      (row?.field_read_scopes as Record<string, string> | null | undefined) ??
      null;
    fieldReadScopesCache.set(base, manifest);
  }
  if (!orgId) return manifest;
  // Once per request, not once per row: this ran for every record of a list
  // and was half of a meta-pool burst in CI (#4876). Still read fresh on the
  // next request, so an admin's edit takes effect at once.
  const kinds = base === kind ? [kind] : [base, kind];
  const perOrg = await perRequest(`field-scopes:${orgId}:${kinds.join(",")}`, () =>
    meta
      .selectFrom("workspace_field_scopes")
      .select(["kind", "field", "capability"])
      .where("org_id", "=", orgId)
      .where("kind", "in", kinds)
      .execute(),
  );
  if (perOrg.length === 0) return manifest;
  const merged: Record<string, string> = { ...(manifest ?? {}) };
  // Per-org wins over the manifest, and the collection's own over its base's.
  for (const k of kinds) for (const r of perOrg) if (r.kind === k) merged[r.field] = r.capability;
  return merged;
}

/** Apply the read-trust boundary to a resolved entity, in two layers:
 *
 *  1. Kind whitelist (`exposableFields`): implicit cross-cutting props
 *     pass through untouched; `fields` is projected to the declared
 *     list. Legacy (null) kinds pass everything through with a one-time
 *     deprecation warning.
 *  2. Per-field read-scope (H2): if the kind gates fields by capability
 *     AND a viewer readScope is supplied that isn't all-access, drop any
 *     gated field the viewer lacks the capability for. A viewer-less
 *     read (system / admin module API) or an all-access viewer
 *     (owner/admin) sees everything — fully backward-compatible. */
/** Every string in a value, however nested. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (isStoredSecret(v) || isMaskedSecret(v)) return out;
  if (typeof v === "string") out.push(v);
  else if (typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

/** Whether `q` is in something this reader may not see and in nothing they
 *  may: a match they could only have got by reading a hidden field. */
function matchedOnlyWhatIsHidden(
  row: ResolvedEntity,
  q: string,
  whitelist: string[] | null,
  fieldReadScopes: Record<string, string>,
  readScope: ViewerReadScope | undefined,
  publicRead: boolean | undefined,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return false;
  const has = (v: unknown) => stringsIn(v).some((t) => t.toLowerCase().includes(needle));
  if (!has(row.fields) && !has(row.title) && !has(row.snippet)) return false;
  const seen = applyExposableProjection(row, whitelist, fieldReadScopes, readScope, publicRead);
  return !has(seen.fields) && !has(seen.title) && !has(seen.snippet);
}

function applyExposableProjection(
  resolved: ResolvedEntity,
  whitelist: string[] | null,
  fieldReadScopes?: Record<string, string> | null,
  readScope?: ViewerReadScope,
  publicRead?: boolean,
  viewer?: EntityViewer,
  secretContext?: SecretReadContext,
): ResolvedEntity {
  let fields: Record<string, unknown>;
  if (whitelist === null) {
    if (!legacyWarnedKinds.has(resolved.kind)) {
      legacyWarnedKinds.add(resolved.kind);
      console.warn(
        `[entities] kind '${resolved.kind}' has no exposableFields declared on its manifest. ` +
          `Returning the full ResolvedEntity.fields for cross-module reads. ` +
          `Declare exposableFields on the entity kind to lock in the read-time trust boundary. ` +
          `See docs/architecture/entity-resolver.md.`,
      );
    }
    // FAIL CLOSED on the anonymous public path: a kind with no declared
    // exposableFields (e.g. a custom/authoring kind) must NOT dump every
    // field — emails, costs, notes — to an unauthenticated reader. Internal
    // cross-module reads still get the legacy passthrough. See
    // docs/history/2026-06-10-prelaunch-audit.md #5.
    if (publicRead) {
      fields = {};
      for (const [name, value] of Object.entries(resolved.fields)) {
        if (IMPLICIT_EXPOSABLE_PROPS.has(name)) fields[name] = value;
      }
    } else {
      fields = { ...resolved.fields };
    }
  } else {
    const allowed = new Set(whitelist);
    fields = {};
    for (const [name, value] of Object.entries(resolved.fields)) {
      if (allowed.has(name) || IMPLICIT_EXPOSABLE_PROPS.has(name)) {
        fields[name] = value;
      }
    }
  }
  // Layer 2 — per-field read-scope gating, FAIL-CLOSED. When a kind
  // gates fields, a gated field is dropped UNLESS the viewer is
  // privileged (all-access — owner/admin) or holds the field's
  // capability. Crucially, a viewer-LESS read (public surfaces,
  // cross-module, system/cron) is treated as UNPRIVILEGED here: a gated
  // commercial field like `cost` must never leak to an unauthenticated
  // public reader just because no viewer was attached. A privileged
  // internal caller that legitimately needs everything passes a
  // readScope with `all: true`.
  if (fieldReadScopes && readScope?.all !== true) {
    const caps = readScope?.caps;
    const hidden = Object.entries(fieldReadScopes).filter(([, cap]) => !caps || !caps.has(cap)).map(([field]) => field);
    for (const field of hidden) {
      if (!secretContext || !isStoredSecret(fields[field])) delete fields[field];
    }
    // A custom field lives in the record's metadata (and is lifted to the top
    // level after this runs), so a gated one is dropped from there too, or
    // it would come back one step later.
    const bag = fields.metadata;
    if (hidden.length && bag && typeof bag === "object" && !Array.isArray(bag) && hidden.some((f) => Object.prototype.hasOwnProperty.call(bag, f))) {
      const kept = { ...(bag as Record<string, unknown>) };
      for (const field of hidden) {
        if (!secretContext || !isStoredSecret(kept[field])) delete kept[field];
      }
      fields.metadata = kept;
    }
  }
  if (!viewer?.system) {
    fields = (publicRead ? omitSecretValues(fields) : maskSecretValues(fields, secretContext ? { ...secretContext, kind: resolved.kind, recordId: resolved.id } : {
      role: viewer?.role ?? "member", userId: viewer?.userId ?? "", kind: resolved.kind, recordId: resolved.id,
      held: readScope?.all ? new Set(Object.values(fieldReadScopes ?? {})) : readScope?.caps ?? new Set(),
      scopes: new Map(Object.entries(fieldReadScopes ?? {})),
    })) as Record<string, unknown>;
  }
  // A search snippet quotes the record's words (a pattern's PDF, its notes),
  // which the field whitelist exists to keep from an anonymous reader.
  if (publicRead && resolved.snippet !== undefined) {
    const { snippet: _quoted, ...rest } = resolved;
    return { ...rest, fields };
  }
  return { ...resolved, fields };
}

export function registerResolver(kind: string, resolver: EntityResolver): void {
  resolvers.set(kind, resolver);
}

// ───────────────────── entity writers (in-process) ────────────────
//
// The WRITE counterpart to read resolvers: an in-process create/update/
// delete for a kind, registered by the owning module. Used by cross-module
// writers (the sync engine) that run with NO HTTP request / user token —
// the writer resolves its own tenant db from orgId and runs the module's
// own validation + events. There is intentionally no generic HTTP loopback.
const entityWriters = new Map<string, EntityWriter>();

export function registerEntityWriter(kind: string, writer: EntityWriter): void {
  entityWriters.set(kind, deletionWriter(kind, historyWriter(kind, secretWriter(kind, writer))));
}

/** The writer for a kind — INCLUDING an instance kind.
 *
 *  Takes an org because `<instance>:item` kinds are synthesized per-org and
 *  are never registered by anyone: only the owning module's real kind is in
 *  the map. A plain `entityWriters.get("bookshelf:item")` therefore misses,
 *  and every caller reads that miss as "this kind cannot be written" — no
 *  error, just a thing that quietly does not happen. Sending a book back to
 *  the scan inbox said "the created entry couldn't be removed automatically";
 *  the same miss silently disarmed undo (snapshot/restore), take/return, and
 *  containment for every instance item in the workspace.
 *
 *  Async and org-scoped ON PURPOSE: there is deliberately no synchronous
 *  by-kind door left, because a caller holding one cannot be instance-aware
 *  and the failure it produces is invisible.
 *
 *  Exact hits cost nothing — the registry lookup runs first and only a miss
 *  pays for the instance resolution. */
export async function getEntityWriterFor(
  orgId: string,
  kind: string,
): Promise<EntityWriter | undefined> {
  assertModulesMounted("An entity writer");
  const exact = entityWriters.get(kind);
  if (exact) return exact;
  const base = await baseKindOf(orgId, kind);
  return base === kind ? undefined : entityWriters.get(base);
}

export function registerListResolver(
  kind: string,
  resolver: EntityListResolver,
  options: ListResolverOptions = {},
): void {
  listResolvers.set(kind, resolver);
  if (options.textOps) textOpsKinds.add(kind);
  else textOpsKinds.delete(kind);
  if (options.tags) tagKinds.add(kind);
  else tagKinds.delete(kind);
}

/** Forget which modules a workspace has enabled. Called the moment enablement
 *  changes, so a module someone just switched on is visible on the very next
 *  read rather than after the TTL - a list that stays empty for thirty seconds
 *  after you enable it would be a worse bug than the one the cache prevents. */
export function clearEnabledModulesCache(orgId?: string): void {
  if (orgId) enabledModulesCache.delete(orgId);
  else enabledModulesCache.clear();
}

/** Clear the per-process exposable-fields cache. Called at the end
 *  of registry-sync so the next lookup reads the freshly-written
 *  whitelist. */
export function clearExposableFieldsCache(): void {
  kindRegistry = null;
  exposableFieldsCache.clear();
  fieldReadScopesCache.clear();
  legacyWarnedKinds.clear();
}

// Role hierarchy for min_target_role gating: a viewer's role must rank at or
// above the link's min_target_role to qualify. Imported rather than restated —
// this file used to carry its own copy of the same numbers, which is exactly
// how the module copies drifted into rejecting editors.
const ROLE_RANK = ORG_ROLE_RANK as Record<string, number>;

/** Find every active, non-expired workspace_link where `targetOrgId`
 *  is the target and `kind` is in the link's kinds[]. Returns the
 *  source org's id + slug + name so cross-workspace reads can attribute
 *  the result. Shared between list() and lookup().
 *
 *  M1 v0.5: When the link sets `min_target_role`, gate by the
 *  viewer's role in the target workspace. viewerUserId omitted
 *  → role-restricted links are excluded entirely (conservative for
 *  system callers like scheduled scanners). viewerUserId set
 *  → join through org_memberships, compare ranks. */
function activeLinkedSources(
  targetOrgId: string,
  kind: string,
  viewerUserId?: string,
): Promise<Array<{ id: string; slug: string; name: string }>> {
  return linkedSourcesInFlight.get(`${targetOrgId}:${kind}:${viewerUserId ?? ""}`, () => loadActiveLinkedSources(targetOrgId, kind, viewerUserId));
}

async function loadActiveLinkedSources(
  targetOrgId: string,
  kind: string,
  viewerUserId?: string,
): Promise<Array<{ id: string; slug: string; name: string }>> {
  try {
    let q = meta
      .selectFrom("workspace_links as l")
      .innerJoin("orgs as o", "o.id", "l.source_org_id")
      .where("l.target_org_id", "=", targetOrgId)
      .where("l.status", "=", "active")
      .where((eb) =>
        eb.or([
          eb("l.expires_at", "is", null),
          eb("l.expires_at", ">", sql<Date>`now()`),
        ]),
      )
      // Postgres text-array containment via SQL template — Kysely's
      // eb.fn doesn't have a clean array-contains helper.
      .where(sql<boolean>`${kind} = ANY(l.kinds)`);

    if (!viewerUserId) {
      // System / anonymous caller: only links with NO role
      // restriction qualify.
      const rows = await q
        .select(["l.source_org_id as id", "o.slug", "o.name"])
        .where("l.min_target_role", "is", null)
        .execute();
      return rows;
    }

    // Authed viewer: join their membership in the target org and
    // filter in SQL on the rank. We do the rank comparison in JS
    // after the fetch since the SQL CASE for the four-role ladder
    // is uglier than this short post-filter.
    const rows = await q
      .leftJoin("org_memberships as m", (j) =>
        j
          .onRef("m.org_id", "=", "l.target_org_id")
          .on("m.user_id", "=", viewerUserId),
      )
      .select([
        "l.source_org_id as id",
        "o.slug",
        "o.name",
        "l.min_target_role as min_target_role",
        "m.role as viewer_role",
      ])
      .execute();
    return rows.filter((r) => {
      if (!r.min_target_role) return true; // no restriction
      // Viewer needs a membership row at all + meeting the rank.
      if (!r.viewer_role) return false;
      const need = ROLE_RANK[r.min_target_role] ?? 0;
      const got = ROLE_RANK[r.viewer_role] ?? 0;
      return got >= need;
    });
  } catch (err) {
    // Meta-side failure shouldn't take down a regular list/lookup —
    // just degrade to isolated.
    console.error("[entities] linked-sources query failed:", (err as Error).message);
    return [];
  }
}

/** How a linked workspace's record is projected in the workspace reading it
 *  (#7118): by the SOURCE's policy, the kind's whitelist and the source
 *  workspace's own field scopes, and with no read scope at all. A person's
 *  grants (or all-access as owner) in the recipient workspace are not grants
 *  in the source, and the projection fails closed without a read scope, so a
 *  field the source gates stays hidden whoever reads it here. The list used
 *  the recipient's scopes and the recipient owner's all-access, so a source's
 *  costs showed in a list the single lookup withheld them from; both doors
 *  now take this one policy. */
async function linkedProjection(srcOrgId: string, kind: string): Promise<{ whitelist: string[] | null; fieldReadScopes: Record<string, string> | null }> {
  // A linked read always has a reader, the recipient's, so a linked
  // collection takes its base kind's policy in the source too.
  const [whitelist, fieldReadScopes] = await Promise.all([getExposableFields(kind), getFieldReadScopes(kind, srcOrgId, true)]);
  return { whitelist, fieldReadScopes };
}

/** Can this kind be looked up at all here? `lookup` answers null for a kind
 *  with no resolver and for a record that does not exist alike; a door that
 *  refuses a record it cannot find must know which it was, or it refuses
 *  every kind nobody wrote a resolver for (#3141). */
export async function canResolve(orgId: string, kind: string): Promise<boolean> {
  return !!(resolvers.get(kind) ?? (await instanceFallbackEntityResolver(orgId, kind)));
}

export class GuestScopeError extends Error {
  readonly status = 503;
  readonly code = "guest_scope_unavailable";
  constructor() { super("The shared records could not be checked. Try again in a moment."); }
  toJSON() { return { error: { code: this.code, message: this.message } }; }
}

async function guestRecordIds(orgId: string, kind: string, viewer?: EntityViewer): Promise<Set<string> | null> {
  if (viewer?.role !== "guest" || viewer.system) return null;
  return perRequest(`guest-records:${orgId}:${kind}:${viewer.userId ?? ""}`, async () => {
    const org = await meta.selectFrom("orgs").select("portal_config").where("id", "=", orgId).executeTakeFirst();
    const pinned = org?.portal_config?.pinned_views ?? [];
    const ids = new Set<string>();
    if (!pinned.length) return ids;
    const { getTenantDb } = await import("../db/tenant.js");
    const db = await getTenantDb(orgId) as unknown as Kysely<{ core_views_views: { id: string; entity_kind: string; owner_user_id: string | null; config: Record<string, unknown> } }>;
    const views = await db.selectFrom("core_views_views").select("config")
      .where("id", "in", pinned).where("entity_kind", "=", kind)
      // A workspace view, the one kind a guest can open (core-views visibleTo): a private one shares nothing.
      .where("owner_user_id", "is", null).execute();
    for (const view of views) {
      // SYSTEM-READ: evaluate the owner's selection, including hidden filter fields; only ids leave this scope.
      const selected = await walkListPages((limit, offset) => listUnscoped(orgId, kind, { ...viewQuery(view.config), limit, offset }, SYSTEM_VIEWER));
      if (!selected.complete || selected.failed || selected.unapplied?.length) throw new GuestScopeError();
      for (const row of selected.items) ids.add(row.id);
    }
    return ids;
  });
}

export async function guestMayReadRecord(orgId: string, kind: string, id: string): Promise<boolean> {
  return (await guestRecordIds(orgId, kind, { role: "guest" }))!.has(id);
}

export async function list(orgId: string, kind: string, query: EntityListQuery = {}, viewer?: EntityViewer): Promise<EntityListResult> {
  const allowed = await guestRecordIds(orgId, kind, viewer);
  if (!allowed) return listUnscoped(orgId, kind, query, viewer);
  if (!allowed.size) return { items: [], total: 0 };
  // Aggregates must never be computed over rows outside the guest's selection.
  if (normalizeGrouping(query.group_by).length) throw new GuestScopeError();
  const all = await walkListPages((limit, offset) => listUnscoped(orgId, kind, { ...query, limit, offset }, viewer));
  if (!all.complete || all.failed) throw new GuestScopeError();
  const rows = all.items.filter(row => allowed.has(row.id));
  const offset = query.offset ?? 0;
  return { items: rows.slice(offset, offset + (query.limit ?? 50)), total: rows.length, ...(all.unapplied?.length ? { unapplied: all.unapplied } : {}) };
}

export async function lookup(
  orgId: string,
  kind: string,
  id: string,
  viewer?: EntityViewer,
): Promise<ResolvedEntity | null> {
  const allowed = await guestRecordIds(orgId, kind, viewer);
  if (allowed && !allowed.has(id)) return null;
  const resolver = resolvers.get(kind) ?? (await instanceFallbackEntityResolver(orgId, kind));
  if (!resolver) return null;
  const publicRead = viewer?.publicRead === true;
  const whitelist = await getExposableFields(kind);
  const fieldReadScopes = await getFieldReadScopes(kind, orgId, viewer);
  const readScope = await viewerReadScope(orgId, fieldReadScopes, viewer);
  const secretContext = !viewer?.system && viewer?.userId ? await secretReadContextFor(orgId, viewer.userId, viewer.role ?? "member") : undefined;

  const registered = resolvers.has(kind);
  // Own workspace first — common case, no cross-workspace traffic.
  try {
    const resolved = (await kindModuleOn(orgId, kind, registered)) ? await resolver(orgId, id) : null;
    if (resolved) {
      // Compute AFTER projection: the template renders over exactly what the
      // reader is allowed to see (exposable natives + `metadata`, minus any
      // capability-gated field). So a computed template that references a
      // gated field — e.g. `{{cost}}` — renders empty on an unprivileged /
      // public read instead of baking the gated value into a string that
      // survives the trust boundary. Custom-field tier-1 still works because
      // inventory:part / assets:asset expose `metadata`.
      // Present the entity as the REQUESTED kind (the caller asked for
      // `<instance>:item`; a module resolver may return the base kind on the
      // row). Computed-field defs are keyed by the requested kind — without this
      // override, computed fields on an instance never resolve. The exposable
      // whitelist above was already computed from the requested kind, so this is
      // consistent.
      const own = await ownWhitelist(orgId, kind, whitelist, viewer);
      const projected = { ...applyExposableProjection(resolved, own, fieldReadScopes, readScope, publicRead, viewer, secretContext), kind };
      return applyServedTitle(await applyMemberFields(orgId, await applyRelationFields(orgId, await applyComputedFields(orgId, await applyCustomFieldValues(orgId, projected))), { publicRead }));
    }
  } catch (err) {
    console.error(`[entities] resolver for ${kind} failed:`, err);
    // Counted with the lists' failures on /healthz: a read that could not reach
    // the database answers "no such record" here, which a renewal took for a
    // changed expiry and refused (#7326).
    noteResolverFailure(kind, err);
  }

  // M1 v0.2 cross-workspace lookup: if the caller is the TARGET of an
  // active, non-expired link that includes this kind, try the source
  // workspace. First hit wins; same exposableFields projection plus
  // the `_source_workspace_*` attribution the list union uses.
  // M1 v0.5: links with min_target_role are gated against viewer.
  const linkedSources = await activeLinkedSources(orgId, kind, viewer?.userId);
  for (const src of linkedSources) {
    try {
      if (!(await kindModuleOn(src.id, kind, registered))) continue;
      const resolved = await resolver(src.id, id);
      if (!resolved) continue;
      const policy = await linkedProjection(src.id, kind);
      const projected = applyExposableProjection(resolved, policy.whitelist, policy.fieldReadScopes, undefined, publicRead);
      return {
        ...projected,
        fields: {
          ...projected.fields,
          _source_workspace_slug: src.slug,
          _source_workspace_name: src.name,
        },
      };
    } catch (err) {
      console.error(
        `[entities] cross-workspace lookup ${kind}:${id} from ${src.slug} failed:`,
        (err as Error).message,
      );
    }
  }
  return null;
}

/** Batched lookup — resolve N (kind, id) refs in one call. Foreign
 *  callers (other modules, the resolver, cross-module renderers)
 *  read joined data this way instead of N separate single-hop calls.
 *
 *  Same projection rules as lookup(): each kind's exposableFields
 *  whitelist is applied; null kinds get the legacy pass-through with
 *  a one-time deprecation warning.
 *
 *  Refs that don't resolve (deleted entity, unknown kind, resolver
 *  threw) are silently skipped — callers get back fewer results than
 *  they asked for, with `kind`+`id` on each result so they can match
 *  back to their input. Order is not guaranteed.
 *
 *  Per-kind concurrency: the resolver for one kind runs serially for
 *  all its ids (in case the resolver does batching internally — most
 *  don't, but this leaves the door open). Across kinds we fan out
 *  with Promise.all so a slow kind doesn't block fast ones. */
export async function lookupMany(
  orgId: string,
  refs: ReadonlyArray<{ kind: string; id: string }>,
  viewer?: EntityViewer,
): Promise<ResolvedEntity[]> {
  if (viewer?.role === "guest" && !viewer.system) {
    const permitted = [];
    for (const ref of refs) {
      if ((await guestRecordIds(orgId, ref.kind, viewer))?.has(ref.id)) permitted.push(ref);
    }
    refs = permitted;
  }
  if (refs.length === 0) return [];
  const secretContext = !viewer?.system && viewer?.userId ? await secretReadContextFor(orgId, viewer.userId, viewer.role ?? "member") : undefined;
  // Group refs by kind so each kind's resolver gets its own fan-out.
  const byKind = new Map<string, string[]>();
  for (const r of refs) {
    const arr = byKind.get(r.kind);
    if (arr) arr.push(r.id);
    else byKind.set(r.kind, [r.id]);
  }
  const results = await Promise.all(
    Array.from(byKind.entries()).map(async ([kind, ids]) => {
      // Same instance fallback lookup() and list() have. Without it the three
      // sibling read paths disagreed: a batched read of an instance record
      // returned nothing while a single read of the same record worked.
      const resolver = resolvers.get(kind) ?? (await instanceFallbackEntityResolver(orgId, kind));
      if (!resolver || !(await kindModuleOn(orgId, kind, resolvers.has(kind)))) return [] as ResolvedEntity[];
      const whitelist = await getExposableFields(kind);
      const fieldReadScopes = await getFieldReadScopes(kind, orgId, viewer);
      const readScope = await viewerReadScope(orgId, fieldReadScopes, viewer);
      const resolved = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await resolver(orgId, id);
            // As the kind it was asked for, as lookup() presents it: a caller
            // matches results back by `${kind}:${id}`, and a relation to a
            // named collection's record read null under the base kind (#7153).
            return r ? { ...applyExposableProjection(r, whitelist, fieldReadScopes, readScope, viewer?.publicRead, viewer, secretContext), kind } : null;
          } catch (err) {
            console.error(`[entities] resolver for ${kind}:${id} failed:`, err);
            return null;
          }
        }),
      );
      return resolved.filter((r): r is ResolvedEntity => r !== null);
    }),
  );
  return results.flat();
}

/** Walk entity_pairings from a source entity and return the resolved
 *  (and projected) target entities. The other half of the resolver
 *  primitive — kernel single-hop fetch (this) + manifest `exposable
 *  Fields` whitelist (in lookup) together form the trust boundary
 *  the entity-resolver.md doc specifies.
 *
 *  Direction:
 *    "in"  (default) — find entities that POINT AT the source via
 *                       this relation. Returns ResolvedEntity for
 *                       each pairing's source-side entity.
 *    "out"           — find entities the source POINTS OUT TO via
 *                       this relation. Returns ResolvedEntity for
 *                       each pairing's target-side entity.
 *
 *  Optional `kind` filter narrows discovered targets to that kind
 *  (only useful when one source pairs with multiple kinds via the
 *  same relation).
 *
 *  Same projection rules as lookup() — each discovered entity is
 *  projected through its kind's exposableFields whitelist before
 *  returning. */
export async function walkPairings(
  orgId: string,
  source: { kind: string; id: string },
  spec: { rel: string; dir?: "in" | "out"; kind?: string },
): Promise<ResolvedEntity[]> {
  const dir = spec.dir ?? "in";
  let q = meta
    .selectFrom("entity_pairings")
    .where("org_id", "=", orgId)
    .where("relationship_kind", "=", spec.rel);
  if (dir === "in") {
    q = q.where("target_kind", "=", source.kind).where("target_id", "=", source.id);
    if (spec.kind) q = q.where("source_kind", "=", spec.kind);
    const rows = await q
      .select(["source_kind as kind", "source_id as id"])
      .execute();
    return lookupMany(orgId, rows);
  } else {
    q = q.where("source_kind", "=", source.kind).where("source_id", "=", source.id);
    if (spec.kind) q = q.where("target_kind", "=", spec.kind);
    const rows = await q
      .select(["target_kind as kind", "target_id as id"])
      .execute();
    return lookupMany(orgId, rows);
  }
}

/** core-resolver v0.1: multi-hop pairing walk.
 *
 *  Chains N hops through entity_pairings, returning the resolved
 *  entities reached at the end. Each hop's spec is the same shape
 *  walkPairings accepts. We do the SQL traversal in batches per
 *  hop rather than calling walkPairings N times — each hop fans
 *  ALL its sources into a single WHERE IN, so cost is one query per
 *  hop instead of one per intermediate row.
 *
 *  Use case: "given a part, find every project whose tasks use it."
 *    part → [used-by] → task → [child-of] → project
 *  Two hops, one batched SQL call each, all results projected
 *  through exposableFields.
 *
 *  Dedup: identical (kind,id) values that appear in multiple paths
 *  collapse — callers get unique entities back, not duplicates.
 *
 *  Cycle / depth guard: each hop is bounded by `maxPerHop` (default
 *  500). A path that would explode the working set is truncated
 *  with a warning logged. Tune via the param when needed. */
export async function walkPath(
  orgId: string,
  source: { kind: string; id: string },
  hops: Array<{ rel: string; dir?: "in" | "out"; kind?: string }>,
  opts: { maxPerHop?: number } = {},
): Promise<ResolvedEntity[]> {
  if (hops.length === 0) return [];
  const maxPerHop = opts.maxPerHop ?? 500;

  // Current frontier — pairs of (kind, id) we've reached so far.
  // Starts as the single source.
  let frontier: Array<{ kind: string; id: string }> = [source];

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    const dir = hop.dir ?? "in";
    if (frontier.length === 0) break;
    if (frontier.length > maxPerHop) {
      console.warn(
        `[entities.walkPath] hop ${i} input ${frontier.length} > maxPerHop ${maxPerHop}; truncating.`,
      );
      frontier = frontier.slice(0, maxPerHop);
    }
    const sourceKinds = Array.from(new Set(frontier.map((f) => f.kind)));
    const sourceIds = Array.from(new Set(frontier.map((f) => f.id)));
    let q = meta
      .selectFrom("entity_pairings")
      .where("org_id", "=", orgId)
      .where("relationship_kind", "=", hop.rel);
    if (dir === "in") {
      // The frontier entities are the TARGETs of the pairings.
      q = q
        .where("target_kind", "in", sourceKinds)
        .where("target_id", "in", sourceIds);
      if (hop.kind) q = q.where("source_kind", "=", hop.kind);
      const rows = await q
        .select(["source_kind as kind", "source_id as id"])
        .execute();
      frontier = uniqRefs(rows);
    } else {
      q = q
        .where("source_kind", "in", sourceKinds)
        .where("source_id", "in", sourceIds);
      if (hop.kind) q = q.where("target_kind", "=", hop.kind);
      const rows = await q
        .select(["target_kind as kind", "target_id as id"])
        .execute();
      frontier = uniqRefs(rows);
    }
  }

  if (frontier.length === 0) return [];
  return lookupMany(orgId, frontier);
}

/** Helper: dedupe a list of (kind, id) refs. */
function uniqRefs(
  refs: Array<{ kind: string; id: string }>,
): Array<{ kind: string; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; id: string }> = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Can list() answer for this kind in this workspace? The same resolver
 *  lookup list() does, without asking it anything: a kind with no list
 *  resolver (a job, an order's line) always lists empty, so a search that
 *  offers it can only ever find nothing. */
export async function listable(orgId: string, kind: string): Promise<boolean> {
  if (listResolvers.has(kind)) return moduleEnabledForOrg(orgId, kind.split(":")[0]!);
  return !!(await instanceFallbackResolver(orgId, kind));
}

/** List entities of a kind. Returns { items: [] } when no list
 *  resolver is registered for the kind. Otherwise calls the
 *  resolver and projects each item through the kind's
 *  exposableFields whitelist — same trust boundary as lookup(). */
async function listUnscoped(
  orgId: string,
  kind: string,
  query: EntityListQuery = {},
  viewer?: EntityViewer,
): Promise<EntityListResult> {
  // A field its reader may not read is never matched, ordered or grouped by:
  // projected out of the answer, it still said, by which records came back,
  // what it held (#7838). A search is told the same fields (textSearchWhere).
  // A saved view's own query (dropUnreadable) was written by someone who may
  // read more: the parts naming a hidden field are left out and said, as a
  // filter the collection could not run, so the view still opens.
  const hiddenUnrun: FilterPredicate[] = [];
  if (viewer && !viewer.system && query.unreadable === undefined) {
    const unreadable = await hiddenFieldsFor(orgId, kind, viewer);
    if (query.dropUnreadable && unreadable.size) {
      const hides = (p: FilterPredicate) => unreadable.has(p.col) || (!!p.ref_col && unreadable.has(p.ref_col));
      // Said by field and kind of test only: the value the author compared
      // against is about the field too.
      hiddenUnrun.push(...(query.where ?? []).filter(hides).map((p) => ({ col: p.col, op: p.op })), ...Object.keys(query.filter ?? {}).filter((k) => unreadable.has(k)).map((col) => ({ col, op: "=" as const })));
      const groups = fieldsNamedBy({ group_by: query.group_by });
      query = {
        ...query,
        where: query.where?.filter((p) => !hides(p)),
        filter: query.filter ? Object.fromEntries(Object.entries(query.filter).filter(([k]) => !unreadable.has(k))) : undefined,
        sort: query.sort?.filter((f) => !unreadable.has(f.replace(/^-/, ""))),
        ...(groups.some((g) => unreadable.has(g)) ? { group_by: undefined, group_keys: undefined } : {}),
      };
    }
    refuseUnreadableFields(fieldsNamedBy(query), unreadable);
    query = { ...query, unreadable };
  }
  const valueFields = [...Object.keys(query.filter ?? {}), ...(query.sort ?? []).map((field) => field.replace(/^-/, "")), ...(query.where ?? []).filter((p) => p.op !== "empty" && p.op !== "not_empty").flatMap((p) => [p.col, ...(p.ref_col ? [p.ref_col] : [])])];
  if (valueFields.length) {
    const defs = await perRequest(`secret-defs:${orgId}:${kind}`, () => resolveFieldDefsForKind(orgId, kind));
    if (defs.some((d) => d.type === "secret" && valueFields.includes(d.name))) throw new GroupingError("Secret fields can only be filtered by empty or has a value.");
  }
  const presence = query.where?.filter((p) => p.op === "empty" || p.op === "not_empty") ?? [];
  if (presence.length) {
    const defs = await perRequest(`secret-defs:${orgId}:${kind}`, () => resolveFieldDefsForKind(orgId, kind));
    const hidden = await hiddenFieldsFor(orgId, kind, viewer ?? {});
    if (presence.some((p) => hidden.has(p.col) || !defs.some((d) => d.name === p.col && d.type === "secret"))) throw new GroupingError("Choose a readable secret field for an empty or has a value filter.");
    const { historyTableFor } = await import("./history-store.js");
    const table = await historyTableFor(orgId, kind);
    if (!table) throw new GroupingError("This collection does not support secret presence filters.");
    return runSecretPresence(orgId, table, presence.map((p) => ({ field: p.col, hasValue: p.op === "not_empty" })), () => list(orgId, kind, { ...query, where: query.where?.filter((p) => p.op !== "empty" && p.op !== "not_empty") }, viewer));
  }
  if (query.sort !== undefined) {
    query = { ...query, sort: normalizeEntitySort(query.sort) };
  }
  const publicRead = viewer?.publicRead === true;
  const resolver = listResolvers.get(kind) ?? (await instanceFallbackResolver(orgId, kind));
  if (!resolver) return { items: [], unlisted: "no-such-list" };
  // A kind whose module this workspace never enabled has no tables in that
  // tenant, so calling its resolver can only raise `relation "<x>" does not
  // exist`. listKindsForOrg already filters the kind LISTING for this reason
  // (2026-08-08), but callers that enumerate the process-global registry
  // instead - core-scan's findTracked walks `listScannable()` - arrive here
  // directly and were still probing every disabled kind on every scan.
  // Guarding the chokepoint covers them and anyone who shows up next.
  // Instance kinds are already org-scoped by instanceFallbackResolver.
  if (!(await kindModuleOn(orgId, kind, listResolvers.has(kind)))) return { items: [], unlisted: "module-off" };
  const whitelist = await getExposableFields(kind);
  const fieldReadScopes = await getFieldReadScopes(kind, orgId, viewer);
  const readScope = await viewerReadScope(orgId, fieldReadScopes, viewer);

  const by = normalizeGrouping(query.group_by);
  if (by.length) {
    const record = (await listKindsForOrg(orgId)).find((k) => k.id === kind);
    if (!record) throw new GroupingError("This collection is not available.");
    const hidden = await hiddenFieldsFor(orgId, kind, viewer ?? {});
    const own = await ownWhitelist(orgId, kind, whitelist, viewer);
    const allowed = (name: string) => !hidden.has(name) && (!own || own.includes(name) || own.includes("metadata"));
    const defs = [...record.fields, ...(await resolveFieldDefsForKind(orgId, kind)), { name: "created_at", type: "datetime" }, { name: "updated_at", type: "datetime" }];
    for (const group of by) {
      const def = defs.find((f) => f.name === group.field);
      if (group.field !== "title" && group.field !== "location" && (!def || !allowed(group.field) || !["text", "select", "boolean", "relation", "date", "datetime", "string", "enum", "entity"].includes(def.type))) throw new GroupingError("Choose a readable text, select, linked record, date or boolean column.");
      if (group.field === "location" && (!allowed("location_name") || hidden.has("location_id"))) throw new GroupingError("Choose a location field you can read.");
      if (group.bucket && (!def || !["date", "datetime"].includes(def.type))) throw new GroupingError("Date buckets need a date column.");
    }
    if (Object.keys(query.filter ?? {}).some((f) => hidden.has(f)) || query.where?.some((p) => hidden.has(p.col) || (p.ref_col && hidden.has(p.ref_col)))) throw new GroupingError("A grouped view cannot filter by a field you cannot read.");
    // Only what adds up is totalled (@cobblr/platform-contract/field-aggregate):
    // a per-unit field (length per ball, price each) is value x the kind's
    // quantity or nothing, never a sum of the values (#5079).
    const quantity = record.fields.find((f) => f.role === "quantity" && allowed(f.name))?.name;
    const fields = new Map<string, { name: string; money?: "amount" | "cents"; times?: string }>();
    const weightedBy: Record<string, string> = {};
    for (const f of defs) {
      if (!allowed(f.name)) continue;
      const money = moneyStorageOf(f);
      if (!money && f.type !== "number") continue;
      const how = aggregateOf({ type: f.type, aggregate: (f as { aggregate?: string | null }).aggregate, money });
      if (how === "none") continue;
      if (how === "per_unit") {
        if (!quantity) continue;
        weightedBy[f.name] = quantity;
      }
      fields.set(f.name, { name: f.name, ...(money ? { money } : {}), ...(how === "per_unit" ? { times: quantity } : {}) });
    }
    const hasStock = record.fields.some((f) => f.name === "spare_qty");
    const places = hasStock || by.some((g) => g.field === "location") ? await platform().placement.groupValues({ orgId, kind }) : undefined;
    const stock = hasStock ? places?.numbers : undefined;
    const hideFlag = query.filter?.hide_unavailable;
    const hideUnavailable = hideFlag === true || hideFlag === "true" || hideFlag === "1";
    query = { ...query, q: undefined, group_plan: { by, fields: [...fields.values()], weighted_by: weightedBy, currency: await workspaceCurrency(orgId), ...(stock ? { numbers: stock, ...(hideUnavailable ? { where: sql<boolean>`${stock.spare_qty!} > 0` } : {}) } : {}), ...(by.some((g) => g.field === "location") ? { values: places?.values } : {}), search: query.q, search_fields: [...new Set(["name", ...defs.filter((f) => f.type !== "secret" && allowed(f.name)).map((f) => f.name)])] } };
  }

  // Own-workspace results first.
  let items: ResolvedEntity[] = [];
  let total: number | undefined;
  // What the resolver could not filter by, said rather than swallowed: a
  // view that could not run its date window must not look like one that did.
  let unapplied: FilterPredicate[] | undefined;
  let failed = false;
  // A text predicate goes only to a resolver that said it runs one; for any
  // other it is reported, not handed over to be skipped (#6896).
  const runsText = listResolvers.has(kind) ? textOpsKinds.has(kind) : textOpsResolvers.has(resolver);
  const textUnrun = runsText ? [] : (query.where ?? []).filter((p) => isTextWhereOp(p.op));
  if (textUnrun.length) query = { ...query, where: query.where!.filter((p) => !isTextWhereOp(p.op)) };
  // A tag filter likewise: a kind that cannot say which of its records carry
  // a tag is reported, and a search for what carries one leaves it out.
  const runsTags = listResolvers.has(kind) ? tagKinds.has(kind) : tagResolvers.has(resolver);
  const tagUnrun: FilterPredicate[] = !runsTags && query.filter?._tag !== undefined ? [{ col: "_tag", op: "=" }] : [];
  if (tagUnrun.length) {
    const { _tag: _unrun, ...rest } = query.filter!;
    query = { ...query, filter: rest };
  }
  try {
    const result = await resolver(orgId, query);
    const notRun = [...hiddenUnrun, ...textUnrun, ...tagUnrun, ...(result.unapplied ?? [])];
    unapplied = notRun.length ? notRun : undefined;
    // Compute AFTER projection (see lookup() — gated fields are stripped
    // before the template runs, so a computed field can't leak them).
    // A search matches the whole row, hidden fields included, so a row the
    // reader can see only because a field they may not read matched would
    // tell them what that field says. Those rows are left out.
    const own = await ownWhitelist(orgId, kind, whitelist, viewer);
    // "Hidden" here is what the person may not see on the record itself: its
    // own table's fields, less what a read scope keeps from them. A field only
    // other modules may not read is not hidden from the person searching: a
    // part's serial, shown on its page, made the search for it drop the part
    // once the part said its serial (#8710). The public keep the narrow set.
    const judged = publicRead ? own : await ownWhitelist(orgId, kind, whitelist, { ...viewer, export: true, assistant: false });
    const rows = query.q && fieldReadScopes ? result.items.filter((r) => !matchedOnlyWhatIsHidden(r, query.q!, judged, fieldReadScopes, readScope, publicRead)) : result.items;
    items = await Promise.all(
      rows.map(async (r) =>
        applyServedTitle(await applyMemberFields(orgId, await applyRelationFields(
          orgId,
          await applyComputedFields(
            orgId,
            // Present each row as the REQUESTED kind so computed defs keyed by an
            // instance kind (`<name>:item`) resolve — same override + reasoning as
            // lookup(). No-op for base kinds (resolver already returns them).
            await applyCustomFieldValues(orgId, { ...applyExposableProjection(r, own, fieldReadScopes, readScope, publicRead, viewer), kind }),
            query.inputs,
          ),
        ), { publicRead })),
      ),
    );
    // A search's count cannot be told when rows were left out for matching
    // only what the reader may not read: the number would say they matched.
    total = query.q && fieldReadScopes && rows.length < result.items.length ? undefined : result.total;
  } catch (err) {
    // A workspace being deleted is not a kind that could not be read: the
    // request answers that the workspace is going (tenant-errors), never "Parts
    // could not be searched" for every kind it holds (#7682).
    // By its code, not its class: importing db/tenant here would load the
    // tenant credentials key into every test that reads entities.
    if ((err as { code?: unknown } | null)?.code === "workspace_deleting") throw err;
    console.error(`[entities] list resolver for ${kind} failed:`, err);
    noteResolverFailure(kind, err);
    if (by.length) throw err;
    failed = true;
  }

  // M1: union with any active+nonexpired workspace_links where THIS
  // org is the target and the link includes this kind. The source's
  // items go through the SAME exposableFields projection (since the
  // consumer is outside the source workspace — cross-workspace ==
  // cross-module from a trust perspective). Items get
  // `_source_workspace_slug` so the UI can render the badge.
  // M1 v0.5: min_target_role on the link gates whether viewer
  // qualifies for the share.
  const linkedSources = await activeLinkedSources(orgId, kind, viewer?.userId);
  if (by.length && linkedSources.length) throw new GroupingError("Grouped views of linked workspaces are not available yet.");
  for (const src of linkedSources) {
    try {
      if (!(await kindModuleOn(src.id, kind, listResolvers.has(kind)))) continue;
      const result = await resolver(src.id, query);
      const policy = await linkedProjection(src.id, kind);
      for (const r of result.items) {
        const projected = applyExposableProjection(
          r,
          policy.whitelist,
          policy.fieldReadScopes,
          undefined,
          publicRead,
        );
        items.push({
          ...projected,
          fields: {
            ...projected.fields,
            _source_workspace_slug: src.slug,
            _source_workspace_name: src.name,
          },
        });
      }
    } catch (err) {
      console.error(
        `[entities] cross-workspace list ${kind} from ${src.slug} failed:`,
        (err as Error).message,
      );
    }
  }

  // A resolver that did not count still yields a known total when the page
  // came back short: everything there is fits in it. Small workspaces (the
  // common case) then get "N of N" instead of "the first N, there may be more".
  // An empty page past the end says nothing about how many there are: it
  // used to report its own offset as the total (400 for 300 parts).
  if (total === undefined && typeof query.limit === "number" && items.length < query.limit && (items.length > 0 || !query.offset)) {
    total = (query.offset ?? 0) + items.length;
  }
  if (by.length && !query.group_plan?.result) throw new GroupingError("This collection does not support database grouping.");
  return { items, total, ...query.group_plan?.result, ...(unapplied ? { unapplied } : {}), ...(failed ? { failed: true as const } : {}) };
}

/** Every record a list query answers, walked a page at a time.
 *
 *  A resolver asked for no limit answers ONE page (50 for most), so a surface
 *  that shows "all of them" and calls list() once shows the first 50 and
 *  counts those: a fleet board read "50 3D printers" with 56 on file, and a
 *  state column whose only machine fell past row 50 was not drawn at all.
 *  The walk itself is walkListPages (entity-list-walk.ts), pure and tested. */
/** The fields of a kind this viewer may not read, by field read scope. A
 *  reader that already drops them from every row (list, lookup) needs this
 *  only to leave their COLUMNS out, e.g. an export, which would otherwise
 *  print an empty column named after a field the viewer is not to know about. */
export async function hiddenFieldsFor(orgId: string, kind: string, viewer: { userId?: string; role?: string }): Promise<Set<string>> {
  const scopes = await getFieldReadScopes(kind, orgId, viewer);
  if (!scopes) return new Set();
  const rs = viewer.userId ? await effectiveCapabilities(orgId, viewer.userId, viewer.role ?? "member") : { all: false, caps: new Set<string>() };
  if (rs.all) return new Set();
  return new Set(Object.entries(scopes).filter(([, cap]) => !rs.caps.has(cap)).map(([field]) => field));
}

export async function listAll(
  orgId: string,
  kind: string,
  query: EntityListQuery = {},
  viewer?: EntityViewer,
  opts: { pageSize?: number; cap?: number } = {},
): Promise<Omit<EntityListResult, "total"> & { total: number | null; complete: boolean }> {
  return walkListPages((limit, offset) => list(orgId, kind, { ...query, limit, offset }, viewer), opts);
}

/** The kind registry is written only by the boot's registry sync, so one
 *  request reads it once: a page that asked per module and per kind read the
 *  whole table 40 times a call (#7716). Each caller gets its own copy. */
export async function listKinds(): Promise<EntityKindRecord[]> {
  const rows = await perRequest("entity-kinds:all", () => meta.selectFrom("entity_kinds").selectAll().orderBy("id").execute());
  return structuredClone(rows).map(rowToKindRecord);
}

/** Find the NAMED (non-default) instance an id lives in, resolving the entity
 *  there. A BASE-kind lookup can't see an item in a named instance — the base
 *  resolver is scoped to the default instance (SELECT ... WHERE instance =
 *  '<module>') — so a Vehicle (assets instance) or a 3D Printer (machines
 *  instance) comes back null from it. This probes the module's named instances
 *  (`lookup("<instance>:item", id)`) until one resolves. The instance resolvers
 *  key on (id, instance) with NO user filter, so it works unauthenticated.
 *  Bounded, usually 1-3 named instances. The ONE place the probe lives, shared by
 *  detailPathForEntity + titleForEntity so they can't drift. */
async function probeNamedInstance(
  orgId: string,
  module: string,
  id: string,
): Promise<{ instance: string; entity: ResolvedEntity } | null> {
  // Rows arrive after their own title reads; an in-flight-only load can finish
  // before the next row asks. Shape writes invalidate this request's answer.
  const insts = await perRequest(`entity-named-instances:${orgId}:${module}`, () =>
    meta
      .selectFrom("workspace_module_instances")
      .select(["instance_name"])
      .where("org_id", "=", orgId)
      .where("module_name", "=", module)
      .where("is_default", "=", false)
      .execute(),
  );
  for (const inst of insts) {
    const hit = await lookup(orgId, `${inst.instance_name}:item`, id).catch(() => null);
    if (hit) return { instance: inst.instance_name, entity: hit };
  }
  return null;
}

/** The detail path a QR/scan/search hit for an entity should land on, INSTANCE
 *  AWARE. Resolves the entity (for its detailUrl + named-collection `instance`),
 *  confirms the instance is a named (non-default) one, then applies
 *  resolveDetailPath. A printed label for a Vehicle (an assets instance) lands on
 *  the Vehicle, not the base Assets page that can't load it. */
export async function detailPathForEntity(orgId: string, kind: string, id: string): Promise<string | undefined> {
  const entity = (await lookup(orgId, kind, id).catch(() => null)) as
    | { detailUrl?: unknown; instance?: unknown }
    | null;
  const detailUrl = entity && typeof entity.detailUrl === "string" && entity.detailUrl ? entity.detailUrl : null;
  const { base, instance: kindInstance } = await resolveKind(orgId, kind);
  const module = base.split(":")[0] ?? "";
  let namedInstance = kindInstance ?? (entity && typeof entity.instance === "string" && entity.instance ? entity.instance : null);
  if (!namedInstance && INSTANCE_ITEM_DETAIL[module]) {
    const probed = await probeNamedInstance(orgId, module, id);
    if (probed) namedInstance = probed.instance;
  }
  const rec = await getKind(base);
  return resolveDetailPath({ kind: base, id, instance: namedInstance, detailUrl, baseDetailRoute: rec?.detail_route ?? null });
}

/** The address for a record when it leaves the app. Unlike a detail path, it
 *  names the workspace explicitly, so a reader who belongs to several cannot
 *  be redirected through their default workspace. */
export async function recordAddressForEntity(
  orgId: string,
  kind: string,
  id: string,
  origin?: string | null,
): Promise<string | undefined> {
  const [path, org] = await Promise.all([
    detailPathForEntity(orgId, kind, id),
    meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst(),
  ]);
  if (!path || !org?.slug) return undefined;
  return recordAddress(origin || publicBaseUrl(), org.slug, path);
}

/** The entity's current system TITLE, INSTANCE AWARE — the stock name a label
 *  caption defaulted to at enqueue, re-resolved live so a trimmed caption can be
 *  reverted to it. Same probe as detailPathForEntity: try the given kind, and if
 *  that base lookup can't see the item (it lives in a named instance) probe the
 *  module's named instances. null when the entity no longer resolves. */
export async function titleForEntity(orgId: string, kind: string, id: string): Promise<string | null> {
  const direct = await lookup(orgId, kind, id).catch(() => null);
  if (direct && direct.title) return direct.title;
  const module = kind.split(":")[0] ?? "";
  const probed = await probeNamedInstance(orgId, module, id);
  return probed && probed.entity.title ? probed.entity.title : null;
}

/** The kind id an entity ACTUALLY lives under: the given base `kind` when the
 *  entity is in its module's default instance, or `<instance_name>:item` when it
 *  lives in a named instance (a machine filed under the "3D Printers" instance,
 *  which the base `machines:machine` kind can't see). Mirrors titleForEntity's
 *  probe. Pair it with a kind's display label (listKindsForOrg) to show an
 *  instance-aware name instead of the raw `module:kind`. Falls back to the given
 *  kind when nothing resolves. */
export async function resolvedKindForEntity(orgId: string, kind: string, id: string): Promise<string> {
  // Probe the module's NAMED instances first: if the entity lives in one, that's
  // its kind. Doing this before the base lookup means the result is right even if
  // the base kind reader doesn't filter instance rows out. Falls back to the
  // given kind (default instance, or no named instance holds it).
  const module = kind.split(":")[0] ?? "";
  const probed = await probeNamedInstance(orgId, module, id).catch(() => null);
  return probed ? `${probed.instance}:item` : kind;
}

/** The kinds a WORKSPACE sees: every manifest kind, plus one synthesized
 *  `<instance_name>:item` kind per named (non-default) instance in this org.
 *  A synthesized kind copies its module's PRIMARY kind's shape (fields,
 *  traits, exposable fields) and carries `instance_name` — its endpoints are
 *  then relative to /orgs/:slug/instances/<name>, not /modules/<module>.
 *  detail_route points at that module's real per-item instance detail page
 *  (INSTANCE_ITEM_DETAIL) when it has one, so useDetailRoute / the header
 *  search send an instance item to a detail that carries instance context;
 *  modules with no per-item instance route fall back to the instance LIST
 *  page. Multi modules without a declared primary kind simply synthesize
 *  nothing — never guessed.
 *  Fixes the pre-2026-07-10 gap where instance items were invisible to every
 *  registry consumer (search detail routes, MCP kind listing, generic
 *  surfaces). */
/** One kind's record as a workspace sees it (an instance kind included), or
 *  null. For a caller that needs the kind's own field declarations: which
 *  native columns carry a field role, and how a money column stores it. */
export async function kindRecordForOrg(orgId: string, kind: string): Promise<EntityKindRecord | null> {
  const recs = await listKindsForOrg(orgId).catch(() => [] as EntityKindRecord[]);
  return recs.find((r) => (r.id.includes(":") ? r.id : `${r.module_name}:${r.id}`) === kind) ?? null;
}

/** The kinds a workspace has, its instance kinds included. A feed resolves
 *  each kind it shows through this, so a read-only request asks once: the
 *  activity feed ran these three statements once per kind on the page, 12
 *  times for one read (2026-10-08). */
export async function listKindsForOrg(orgId: string): Promise<EntityKindRecord[]> {
  return [...(await perReadRequest(`kinds-for-org:${orgId}`, () => loadKindsForOrg(orgId)))];
}

async function loadKindsForOrg(orgId: string): Promise<EntityKindRecord[]> {
  const all = await listKinds();
  // ONLY the kinds this workspace enabled. The registry is process-global —
  // every loaded module registers its kinds — while enablement is per-org, so
  // an unfiltered list hands every consumer kinds whose tables do not exist in
  // that tenant. The identifier-field resolvable provider probes each kind it
  // is given, so Postgres answered `relation "records_records" does not exist`
  // 69 times in a week on prod, entirely from workspaces that simply never
  // enabled records/machines/assets (2026-08-08). Presence of an `org_modules`
  // row is the enabled signal: there is no enabled flag, disable deletes it.
  let base = all;
  try {
    const enabled = new Set(
      (
        await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()
      ).map((r) => r.module_name),
    );
    base = all.filter((k) => enabled.has(k.module_name));
  } catch (err) {
    // Meta unreachable is different from "nothing enabled": fall back to the
    // whole registry rather than telling a caller the workspace has no kinds.
    console.error("[entities] enabled-module filter failed, using all kinds:", (err as Error).message);
  }
  let instances: Array<{ module_name: string; instance_name: string; display_name: string }> = [];
  try {
    instances = await meta
      .selectFrom("workspace_module_instances")
      .select(["module_name", "instance_name", "display_name"])
      .where("org_id", "=", orgId)
      .where("is_default", "=", false)
      .execute();
  } catch (err) {
    console.error("[entities] instance-kind synthesis query failed:", (err as Error).message);
    return base;
  }
  if (instances.length === 0) return base;
  const primaryByModule = new Map(
    base.filter((k) => k.is_primary).map((k) => [k.module_name, k] as const),
  );

  // Per-instance stock-vs-catalog disclosure, resolved META-SIDE so this hot
  // path never opens a tenant pool. An instance whose base kind is bulk stock
  // (fungible) renders LEAN — a unique `catalog-record`, so combine/scan treat a
  // film as one-per-title, never summing a phantom quantity — until it shows
  // stock signal. The signal lives entirely in the instance's override config:
  // an explicit `stock` boolean (the user's toggle) wins; else the sticky
  // `stock_latched` marker (set by bundle install or the first stock-shaped
  // write); else lean. This mirrors the disclosure endpoint's meta-side rungs
  // exactly (override → latched → lean); the tenant-side data probe there is
  // only the latch-setter, never consulted here. See one-record-substrate.md.
  let overrideConfigByTarget = new Map<string, Record<string, unknown>>();
  try {
    const rows = await meta
      .selectFrom("entity_kind_overrides")
      .select(["target_id", "config"])
      .where("org_id", "=", orgId)
      .where("target_kind", "=", "instance")
      .execute();
    overrideConfigByTarget = new Map(
      rows.map((r) => [r.target_id, (r.config as Record<string, unknown> | null) ?? {}]),
    );
  } catch (err) {
    // A read failure here must not break kind synthesis — fall back to leaving
    // the primary's traits untouched (the pre-Phase-2 behaviour).
    console.error("[entities] instance disclosure lookup failed:", (err as Error).message);
  }

  const synthesized: EntityKindRecord[] = [];
  for (const inst of instances) {
    const primary = primaryByModule.get(inst.module_name);
    if (!primary) continue;
    const perItem = INSTANCE_ITEM_DETAIL[inst.module_name];

    // Downgrade a lean fungible-stock instance to the catalog-record traits.
    // Only applies when the base kind is fungible stock; every other module's
    // instances keep their primary traits unchanged.
    let traits = primary.traits;
    let profile = primary.profile;
    if (traitAxisValue(primary.traits as Record<string, unknown> | null, "identity") === "fungible") {
      const cfg = overrideConfigByTarget.get(`${inst.module_name}:${inst.instance_name}`) ?? {};
      const stock = stockDisclosureFromConfig(cfg) ?? false;
      if (!stock) {
        traits = TRAIT_PRESETS["catalog-record"] as EntityKindRecord["traits"];
        profile = "catalog-record";
      }
    }

    const id = `${inst.instance_name}:item`;
    synthesized.push({
      ...primary,
      id,
      // What a read of this kind actually strips, from the function the read
      // path itself asks (list/lookup → getExposableFields(kind)). Copying the
      // primary's list told an assistant that notes and serial numbers were
      // unreadable on an instance whose reads return them (#3807).
      exposable_fields: await getExposableFields(id),
      display_name: inst.display_name,
      display_name_plural: inst.display_name,
      traits,
      profile,
      detail_route: perItem
        ? perItem(inst.instance_name)
        : `/instances/${inst.instance_name}`,
      endpoints: {
        list: "/items",
        get: "/items/{id}",
        create: "/items",
        update: "/items/{id}",
        delete: "/items/{id}",
      },
      is_primary: false,
      instance_name: inst.instance_name,
    });
  }
  return [...base, ...synthesized];
}

export async function getKind(kind: string): Promise<EntityKindRecord | null> {
  const row = await perRequest(`entity-kind:${kind}`, () => meta.selectFrom("entity_kinds").selectAll().where("id", "=", kind).executeTakeFirst());
  return row ? rowToKindRecord(structuredClone(row)) : null;
}

// Server-managed field names per (org, kind). Values live in metadata, but a
// server_managed field def marks a value the SERVER owns — a client write is
// never accepted (the write route preserves the stored value). This mirrors
// the computed-defs cache: short TTL keeps a list() of N rows from doing N
// identical meta queries; a field-def write calls clearServerManagedCache for
// immediate freshness.
const SM_TTL_MS = 5_000;
const smCache = ttlCache<string[]>(SM_TTL_MS);

export function clearServerManagedCache(): void {
  smCache.clear();
}

export async function serverManagedFields(orgId: string, kind: string): Promise<string[]> {
  const key = `${orgId}:${kind}`;
  return smCache.get(key, async () => {
    let names: string[] = [];
    try {
      const rows = await meta
        .selectFrom("module_field_defs")
        .select("name")
        .where("org_id", "=", orgId)
        .where("entity_kind", "=", kind)
        .where("server_managed", "=", true)
        .execute();
      names = rows.map((r) => r.name);
    } catch (err) {
      console.error(`[server-managed] defs query for ${key} failed:`, (err as Error).message);
      names = [];
    }
    return names;
  });
}

function rowToKindRecord(row: {
  id: string;
  module_name: string;
  display_name: string;
  display_name_plural: string | null;
  icon: string | null;
  fields: unknown;
  detail_route: string | null;
  endpoints: unknown;
  version: string;
  is_primary?: boolean;
  traits: unknown | null;
  profile: string | null;
  label_code_overlay_default: boolean | null;
  exposable_fields: unknown | null;
  duplicate_scope?: string | null;
}): EntityKindRecord {
  return {
    id: row.id,
    module_name: row.module_name,
    module_instanceability: getEntry(row.module_name)?.manifest.instanceability ?? "single",
    display_name: row.display_name,
    display_name_plural: row.display_name_plural,
    icon: row.icon,
    fields: (row.fields as EntityKindRecord["fields"]) ?? [],
    detail_route: row.detail_route,
    endpoints: (row.endpoints as EntityKindRecord["endpoints"]) ?? null,
    version: row.version,
    is_primary: row.is_primary === true,
    traits: (row.traits as EntityKindRecord["traits"]) ?? null,
    profile: row.profile,
    label_code_overlay_default: row.label_code_overlay_default ?? null,
    exposable_fields: (row.exposable_fields as string[] | null) ?? null,
    duplicate_scope: row.duplicate_scope ?? null,
  };
}
