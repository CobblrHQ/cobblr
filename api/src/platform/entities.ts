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

import { sql } from "kysely";
import type {
  EntityKindRecord,
  EntityListQuery,
  EntityListResolver,
  EntityListResult,
  EntityResolver,
  ResolvedEntity,
} from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { applyComputedFields } from "./computed-fields.js";
import { normalizeEntitySort } from "./sort.js";
import { effectiveCapabilities } from "../auth/effective-capabilities.js";

const resolvers = new Map<string, EntityResolver>();
const listResolvers = new Map<string, EntityListResolver>();

// In-process cache of the exposable-fields whitelist per kind. Filled
// lazily on first lookup; kept until process restart (kinds rarely
// change at runtime, and any change cycles through registry-sync at
// boot anyway).
const exposableFieldsCache = new Map<string, string[] | null>();

// In-process cache of the per-field read-scope map per kind (H2):
// { field_name: required_capability }. Same lifecycle as the
// exposable-fields cache. Null = no per-field gating for the kind.
const fieldReadScopesCache = new Map<string, Record<string, string> | null>();

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

// Implicit cross-cutting props on ResolvedEntity that are ALWAYS
// exposable regardless of the manifest's `exposableFields`. These are
// the ones declared on the ResolvedEntity interface itself, used by
// every renderer to display "the entity" generically.
const IMPLICIT_EXPOSABLE_PROPS = new Set([
  "kind",
  "id",
  "title",
  "subtitle",
  "image_path",
  "detailUrl",
]);

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
 *  are merged on top when an orgId is given — "a beta tester defines his own
 *  tiers." Per-org entries win. The per-org read is one small indexed
 *  query per resolver call (not per row), so it's cheap; not cached, so
 *  admin edits take effect immediately. */
async function getFieldReadScopes(
  kind: string,
  orgId?: string,
): Promise<Record<string, string> | null> {
  let manifest: Record<string, string> | null;
  if (fieldReadScopesCache.has(kind)) {
    manifest = fieldReadScopesCache.get(kind) ?? null;
  } else {
    const row = await meta
      .selectFrom("entity_kinds")
      .select(["field_read_scopes"])
      .where("id", "=", kind)
      .executeTakeFirst();
    manifest =
      (row?.field_read_scopes as Record<string, string> | null | undefined) ??
      null;
    fieldReadScopesCache.set(kind, manifest);
  }
  if (!orgId) return manifest;
  const perOrg = await meta
    .selectFrom("workspace_field_scopes")
    .select(["field", "capability"])
    .where("org_id", "=", orgId)
    .where("kind", "=", kind)
    .execute();
  if (perOrg.length === 0) return manifest;
  const merged: Record<string, string> = { ...(manifest ?? {}) };
  for (const r of perOrg) merged[r.field] = r.capability; // per-org wins
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
function applyExposableProjection(
  resolved: ResolvedEntity,
  whitelist: string[] | null,
  fieldReadScopes?: Record<string, string> | null,
  readScope?: ViewerReadScope,
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
    fields = { ...resolved.fields };
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
    for (const [field, cap] of Object.entries(fieldReadScopes)) {
      if (!caps || !caps.has(cap)) delete fields[field];
    }
  }
  return { ...resolved, fields };
}

export function registerResolver(kind: string, resolver: EntityResolver): void {
  resolvers.set(kind, resolver);
}

export function registerListResolver(
  kind: string,
  resolver: EntityListResolver,
): void {
  listResolvers.set(kind, resolver);
}

/** Clear the per-process exposable-fields cache. Called at the end
 *  of registry-sync so the next lookup reads the freshly-written
 *  whitelist. */
export function clearExposableFieldsCache(): void {
  exposableFieldsCache.clear();
  fieldReadScopesCache.clear();
  legacyWarnedKinds.clear();
}

// Role hierarchy for min_target_role gating. Higher index = more
// privileged. A viewer's role must be at index >= the link's
// min_target_role index to qualify.
const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

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
async function activeLinkedSources(
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

export async function lookup(
  orgId: string,
  kind: string,
  id: string,
  viewer?: { userId?: string },
): Promise<ResolvedEntity | null> {
  const resolver = resolvers.get(kind);
  if (!resolver) return null;
  const whitelist = await getExposableFields(kind);
  // Single-hop / cross-module lookups carry no resolved capability set,
  // so read-scope gating here is fail-closed: gated fields are withheld
  // (these paths feed cross-module renderers + internal callers, which
  // never need commercial fields like cost). Member-facing field
  // visibility flows through list() with a viewer.
  const fieldReadScopes = await getFieldReadScopes(kind, orgId);

  // Own workspace first — common case, no cross-workspace traffic.
  try {
    const resolved = await resolver(orgId, id);
    if (resolved) {
      // Compute AFTER projection: the template renders over exactly what the
      // reader is allowed to see (exposable natives + `metadata`, minus any
      // capability-gated field). So a computed template that references a
      // gated field — e.g. `{{cost}}` — renders empty on an unprivileged /
      // public read instead of baking the gated value into a string that
      // survives the trust boundary. Custom-field tier-1 still works because
      // inventory:part / assets:asset expose `metadata`.
      const projected = applyExposableProjection(resolved, whitelist, fieldReadScopes);
      return applyComputedFields(orgId, projected);
    }
  } catch (err) {
    console.error(`[entities] resolver for ${kind} failed:`, err);
  }

  // M1 v0.2 cross-workspace lookup: if the caller is the TARGET of an
  // active, non-expired link that includes this kind, try the source
  // workspace. First hit wins; same exposableFields projection plus
  // the `_source_workspace_*` attribution the list union uses.
  // M1 v0.5: links with min_target_role are gated against viewer.
  const linkedSources = await activeLinkedSources(orgId, kind, viewer?.userId);
  for (const src of linkedSources) {
    try {
      const resolved = await resolver(src.id, id);
      if (!resolved) continue;
      const projected = applyExposableProjection(resolved, whitelist, fieldReadScopes);
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
): Promise<ResolvedEntity[]> {
  if (refs.length === 0) return [];
  // Group refs by kind so each kind's resolver gets its own fan-out.
  const byKind = new Map<string, string[]>();
  for (const r of refs) {
    const arr = byKind.get(r.kind);
    if (arr) arr.push(r.id);
    else byKind.set(r.kind, [r.id]);
  }
  const results = await Promise.all(
    Array.from(byKind.entries()).map(async ([kind, ids]) => {
      const resolver = resolvers.get(kind);
      if (!resolver) return [] as ResolvedEntity[];
      const whitelist = await getExposableFields(kind);
      // Cross-module batched read — fail-closed on gated fields (no
      // viewer capability set here; commercial fields never flow to
      // foreign module renderers).
      const fieldReadScopes = await getFieldReadScopes(kind, orgId);
      const resolved = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await resolver(orgId, id);
            return r ? applyExposableProjection(r, whitelist, fieldReadScopes) : null;
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

/** List entities of a kind. Returns { items: [] } when no list
 *  resolver is registered for the kind. Otherwise calls the
 *  resolver and projects each item through the kind's
 *  exposableFields whitelist — same trust boundary as lookup(). */
export async function list(
  orgId: string,
  kind: string,
  query: EntityListQuery = {},
  viewer?: { userId?: string; role?: string },
): Promise<EntityListResult> {
  if (query.sort !== undefined) {
    query = { ...query, sort: normalizeEntitySort(query.sort) };
  }
  const resolver = listResolvers.get(kind);
  if (!resolver) return { items: [] };
  const whitelist = await getExposableFields(kind);
  const fieldReadScopes = await getFieldReadScopes(kind, orgId);
  // Resolve the viewer's field-read access ONLY when the kind actually
  // gates fields AND a viewer was supplied. No viewer = trusted
  // internal / admin-module-API path = see everything (backward compat).
  // A supplied-but-unidentified viewer is gated conservatively (no caps).
  let readScope: ViewerReadScope | undefined;
  if (fieldReadScopes && viewer) {
    readScope = viewer.userId
      ? await effectiveCapabilities(orgId, viewer.userId, viewer.role ?? "member")
      : { all: false, caps: new Set() };
  }

  // Own-workspace results first.
  let items: ResolvedEntity[] = [];
  let total: number | undefined;
  try {
    const result = await resolver(orgId, query);
    // Compute AFTER projection (see lookup() — gated fields are stripped
    // before the template runs, so a computed field can't leak them).
    items = await Promise.all(
      result.items.map(async (r) =>
        applyComputedFields(
          orgId,
          applyExposableProjection(r, whitelist, fieldReadScopes, readScope),
        ),
      ),
    );
    total = result.total;
  } catch (err) {
    console.error(`[entities] list resolver for ${kind} failed:`, err);
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
  for (const src of linkedSources) {
    try {
      const result = await resolver(src.id, query);
      for (const r of result.items) {
        const projected = applyExposableProjection(
          r,
          whitelist,
          fieldReadScopes,
          readScope,
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

  return { items, total };
}

export async function listKinds(): Promise<EntityKindRecord[]> {
  const rows = await meta
    .selectFrom("entity_kinds")
    .selectAll()
    .orderBy("id")
    .execute();
  return rows.map(rowToKindRecord);
}

export async function getKind(kind: string): Promise<EntityKindRecord | null> {
  const row = await meta
    .selectFrom("entity_kinds")
    .selectAll()
    .where("id", "=", kind)
    .executeTakeFirst();
  return row ? rowToKindRecord(row) : null;
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
  traits: unknown | null;
  profile: string | null;
  exposable_fields: unknown | null;
}): EntityKindRecord {
  return {
    id: row.id,
    module_name: row.module_name,
    display_name: row.display_name,
    display_name_plural: row.display_name_plural,
    icon: row.icon,
    fields: (row.fields as EntityKindRecord["fields"]) ?? [],
    detail_route: row.detail_route,
    endpoints: (row.endpoints as EntityKindRecord["endpoints"]) ?? null,
    version: row.version,
    traits: (row.traits as EntityKindRecord["traits"]) ?? null,
    profile: row.profile,
    exposable_fields: (row.exposable_fields as string[] | null) ?? null,
  };
}
