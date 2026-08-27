// The sync engine — the idempotent upsert + reconcile that BOTH the live
// webhook and the reconcile poll converge on. Everything is keyed by
// (connection, entity_type, external_id) through the synced_records id-map, so
// re-running is a no-op and the two paths never conflict. Parent hierarchy
// resolves through the same map (parent external id → mirrored Cobblr id).

import {
  platform,
  type SyncConnector,
  type SyncEntityType,
  type SyncRecord,
  type SyncFetchContext,
  type SyncWebhookHit,
  type ImportPlan,
  type ImportPlanItem,
} from "@cobblr/platform-contract";
import { createHash } from "node:crypto";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { edgeRelayFetch } from "./edge-fetch.js";

/** A resolved, decrypted handle to one sync connection. */
export interface SyncConnectionRef {
  orgId: string;
  connectorRowId: string; // core_integrations_connectors.id
  connectorId: string; // the registered SyncConnector id, e.g. "my-shop"
  baseUrl: string;
  credentials: Record<string, unknown>; // decrypted
  /** "direct" = the cloud fetches base_url itself (egress-guarded; reaches a
   *  private address only on a self-hosted instance). "edge" = the request rides
   *  the workspace's dial-out relay and a local bridge fetches base_url — so a
   *  hosted instance reaches a LAN source without ever touching the private IP. */
  transport: "direct" | "edge";
  /** Which edge bridge serves this connection (edge transport); null = default. */
  bridge: string | null;
  /** Per-connection target-instance override: entity-type key → instance slug.
   *  The USER's choice at connect time — lands rows in the instance they picked
   *  (e.g. their own yarn table), winning over the manifest's default
   *  `targetInstance`. Absent → the manifest default applies. Lets one built-in
   *  source (Ravelry) serve any instance, decoupled from any specific bundle. */
  targetInstances?: Record<string, string>;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  linked: number;
  tombstoned: number;
  total: number;
  /** Tags the source carried that could not be attached. Counted, never
   *  swallowed, so the numbers above are not a lie about what came across. */
  tagsFailed: number;
}

/** Normalised key for the import name-merge. Case-insensitive and
 *  punctuation/whitespace-insensitive, so near-duplicates link instead of
 *  duplicating — e.g. "Prusa Mini" ⇄ "Prusa MINI+" both → "prusa mini".
 *  Word boundaries are kept (runs of non-alphanumerics collapse to one space),
 *  so genuinely different names ("CR-10" vs "CR-10S") still don't collide. The
 *  both-sides import preview shows every resulting merge, so a wrong one is
 *  caught before it's written. */
export function matchKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Existing same-name entities not yet owned by this connection — the merge
 *  targets for a one-time import. Name → cobblr id, normalised via matchKey.
 *  Built from the writer's listForMatch minus anything already in the id-map, so
 *  a link never hijacks an entity another external id already mirrors. */
async function buildLinkMap(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<Map<string, { id: string; name: string }>> {
  const writer = platform().entities.getWriter(type.targetKind);
  if (!writer?.listForMatch) return new Map();
  const existing = await writer.listForMatch(ref.orgId);
  const mapped = await db
    .selectFrom("core_integrations_synced_records")
    .select(["cobblr_entity_id"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("deleted_at", "is", null)
    .execute();
  const taken = new Set(mapped.map((m) => m.cobblr_entity_id));
  const out = new Map<string, { id: string; name: string }>();
  for (const e of existing) {
    const key = matchKey(e.name);
    if (!key || taken.has(e.id) || out.has(key)) continue; // ambiguous dup name → skip
    out.set(key, { id: e.id, name: e.name }); // keep the original name for the preview
  }
  return out;
}

function fetchCtx(ref: SyncConnectionRef): SyncFetchContext {
  return {
    orgId: ref.orgId,
    baseUrl: ref.baseUrl,
    credentials: ref.credentials,
    // edge: ride the workspace's dial-out relay (the bridge fetches the LAN
    // source). direct: the cloud fetches itself, through the one per-tenant
    // egress policy (private targets allowed only on a self-hosted instance).
    fetch:
      ref.transport === "edge"
        ? edgeRelayFetch(ref)
        : (input, init) => platform().egress.guardedFetch(ref.orgId, input, init),
  };
}

function hashRecord(
  targetKind: string,
  parentCobblrId: string | null,
  fields: Record<string, unknown>,
  references?: SyncRecord["references"],
  targetInstance?: string | null,
  images?: SyncRecord["images"],
  tags?: SyncRecord["tags"],
): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        targetKind,
        parentCobblrId,
        fields,
        references: references ?? null,
        targetInstance: targetInstance ?? null,
        images: images ?? null,
        tags: tags ?? null,
      }),
    )
    .digest("hex");
}

/** Resolve a record's cross-section references to mirrored Cobblr ids (null if
 *  the referenced entity hasn't been imported yet). Same id-map as resolveParent,
 *  but pointed at any section — e.g. a printer's location_id → a location. */
async function resolveReferences(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  record: SyncRecord,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!record.references) return out;
  for (const [field, r] of Object.entries(record.references)) {
    const row = await db
      .selectFrom("core_integrations_synced_records")
      .select("cobblr_entity_id")
      .where("connector_row_id", "=", ref.connectorRowId)
      .where("entity_type", "=", r.section)
      .where("external_id", "=", r.externalId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    out[field] = row?.cobblr_entity_id ?? null;
  }
  return out;
}

const orgSlugCache = new Map<string, string>();
/** The org's URL slug — needed to build the served file URL. Cached; slugs are
 *  effectively immutable for an org's lifetime. */
async function orgSlug(orgId: string): Promise<string> {
  const cached = orgSlugCache.get(orgId);
  if (cached) return cached;
  const meta = platform().db.meta as unknown as Kysely<{ orgs: { id: string; slug: string } }>;
  const row = await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst();
  const slug = row?.slug ?? orgId;
  orgSlugCache.set(orgId, slug);
  return slug;
}

/** Pull a record's images across: fetch each through the connector's transport
 *  (the edge bridge), store the bytes in core-files, and return target-field →
 *  served file URL. A single image that fails to fetch/store is skipped, never
 *  aborting the record. Called only on a real write (create/update), never noop.
 *  `missing` counts declared images that didn't resolve — the caller uses it to
 *  mark the record for retry so a transient miss (e.g. a bridge not yet updated
 *  to binary support) self-heals on the next reconcile instead of sticking. */
async function resolveImages(
  ref: SyncConnectionRef,
  type: SyncEntityType,
  record: SyncRecord,
): Promise<{ fields: Record<string, string>; missing: number }> {
  if (!record.images || !type.fetchBinary) return { fields: {}, missing: 0 };
  const out: Record<string, string> = {};
  const ctx = fetchCtx(ref);
  for (const [field, urlOrPath] of Object.entries(record.images)) {
    try {
      const img = await type.fetchBinary(ctx, urlOrPath);
      if (!img || img.bytes.byteLength === 0) continue;
      // Only store an actual image. A pre-binary edge bridge (or an error page)
      // hands the body back as JSON/text — storing that would be a corrupt
      // "photo" the unchanged-hash short-circuit would never re-pull. Skip it.
      const mt = (img.mimeType || "").toLowerCase();
      if (mt.includes("json") || mt.startsWith("text/")) continue;
      const stored = await platform().files.write(ref.orgId, img.bytes, {
        mimeType: img.mimeType,
        filename: `${type.key}-${record.externalId}`,
      });
      if (stored?.fileId) {
        const slug = await orgSlug(ref.orgId);
        out[field] = `/api/v1/orgs/${slug}/modules/core-files/files/${stored.fileId}/raw`;
      }
    } catch {
      /* one bad image shouldn't sink the whole record */
    }
  }
  return { fields: out, missing: Object.keys(record.images).length - Object.keys(out).length };
}

async function resolveParent(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  entityType: string,
  parentExternalId: string | null | undefined,
): Promise<string | null> {
  if (!parentExternalId) return null;
  const p = await db
    .selectFrom("core_integrations_synced_records")
    .select("cobblr_entity_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", entityType)
    .where("external_id", "=", parentExternalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return p?.cobblr_entity_id ?? null;
}

/** Upsert ONE mapped record into its target kind, keyed by external id.
 *  Idempotent: unchanged source (same hash) is a no-op. Parent is resolved
 *  through the id-map; an unknown parent yields a null parent_id (orphan) that
 *  the next reconcile heals once the parent is synced. */
async function upsertOne(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  record: SyncRecord,
  /** When set (import only), an unmapped record whose name matches an entry is
   *  ADOPTED into that existing entity instead of creating a duplicate. Consumed
   *  on use so two source rows can't both claim the same target. */
  linkByName?: Map<string, { id: string; name: string }>,
): Promise<{ action: "created" | "updated" | "linked" | "noop"; tagsFailed: number }> {
  const writer = platform().entities.getWriter(type.targetKind);
  if (!writer) throw new Error(`sync: no entity writer registered for ${type.targetKind}`);

  const parentCobblrId = await resolveParent(db, ref, type.key, record.parentExternalId);
  // Instance precedence: per-record instanceBy routing → the user's per-connection
  // target choice → the manifest's static default.
  const instance = record.instance ?? ref.targetInstances?.[type.key] ?? type.targetInstance ?? null;
  const hash = hashRecord(type.targetKind, parentCobblrId, record.fields, record.references, instance, record.images, record.tags);

  const existing = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", record.externalId)
    .executeTakeFirst();

  // Unchanged source → no-op BEFORE any image fetch: pulling an image is a
  // network round-trip through the bridge, only worth it when actually writing.
  if (existing && !existing.deleted_at && existing.source_hash === hash) return { action: "noop", tagsFailed: 0 };

  // We're writing — resolve references + pull any images now (once per change).
  const { fields: imageFields, missing: missingImages } = await resolveImages(ref, type, record);
  const fields = {
    ...record.fields,
    parent_id: parentCobblrId,
    ...(await resolveReferences(db, ref, record)),
    ...(instance ? { instance } : {}),
    ...imageFields,
  };
  // If a declared image didn't come across (e.g. the bridge hasn't self-updated to
  // binary support yet), store a RETRY-marked hash so the next reconcile re-pulls
  // it instead of short-circuiting on an unchanged hash — self-heals once ready.
  const storedHash = missingImages > 0 ? `${hash}:img-retry` : hash;

  if (existing && !existing.deleted_at) {
    await writer.update(ref.orgId, existing.cobblr_entity_id, fields);
    await db
      .updateTable("core_integrations_synced_records")
      .set({ source_hash: storedHash, target_kind: type.targetKind, updated_at: new Date() })
      .where("id", "=", existing.id)
      .execute();
    return { action: "updated", tagsFailed: await attachTags(ref.orgId, type.targetKind, existing.cobblr_entity_id, record.tags) };
  }

  // Import merge: an unmapped record whose name matches an existing entity →
  // adopt it (update in place + map) rather than create a duplicate.
  if (!existing && linkByName) {
    const key = matchKey(String(record.fields.name ?? ""));
    const matched = key ? linkByName.get(key) : undefined;
    if (matched) {
      linkByName.delete(key);
      await writer.update(ref.orgId, matched.id, fields);
      await db
        .insertInto("core_integrations_synced_records")
        .values({
          connector_row_id: ref.connectorRowId,
          entity_type: type.key,
          target_kind: type.targetKind,
          external_id: record.externalId,
          cobblr_entity_id: matched.id,
          source_hash: storedHash,
        })
        .execute();
      return { action: "linked", tagsFailed: await attachTags(ref.orgId, type.targetKind, matched.id, record.tags) };
    }
  }

  // New record, or a previously tombstoned one resurfacing → fresh mirror.
  const cobblrId = await writer.create(ref.orgId, fields);
  if (existing) {
    await db
      .updateTable("core_integrations_synced_records")
      .set({
        cobblr_entity_id: cobblrId,
        source_hash: storedHash,
        target_kind: type.targetKind,
        deleted_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
  } else {
    await db
      .insertInto("core_integrations_synced_records")
      .values({
        connector_row_id: ref.connectorRowId,
        entity_type: type.key,
        target_kind: type.targetKind,
        external_id: record.externalId,
        cobblr_entity_id: cobblrId,
        source_hash: storedHash,
      })
      .execute();
  }
  return { action: "created", tagsFailed: await attachTags(ref.orgId, type.targetKind, cobblrId, record.tags) };
}

/** Attach the record's tags to the mirrored entity. A failure is COUNTED, never
 *  swallowed: the Homebox CSV importer once reported a clean import while its
 *  tag attaches had silently failed, and the number it printed was a lie. */
async function attachTags(orgId: string, targetKind: string, id: string, tags: string[] | undefined): Promise<number> {
  if (!tags?.length) return 0;
  let failed = 0;
  for (const tagName of tags) {
    try {
      await platform().tags.attach({ orgId, tagName, target: { kind: targetKind, id } });
    } catch (err) {
      failed += 1;
      console.warn(`[sync] tag "${tagName}" not attached to ${targetKind}/${id}:`, (err as Error).message);
    }
  }
  return failed;
}

/** Tombstone one external id: delete the mirror + mark the map row. */
async function tombstoneOne(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  externalId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return false;
  const writer = platform().entities.getWriter(type.targetKind);
  if (writer) {
    try {
      await writer.delete(ref.orgId, row.cobblr_entity_id);
    } catch {
      /* mirror already gone — tombstone anyway */
    }
  }
  await db
    .updateTable("core_integrations_synced_records")
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where("id", "=", row.id)
    .execute();
  return true;
}

/** Order records so a parent is always upserted before its children — the
 *  first pass then resolves parent_id without a second pass. Cycles / missing
 *  parents fall through and resolve as orphans (healed next reconcile). */
function topoSort(records: SyncRecord[]): SyncRecord[] {
  const byId = new Map(records.map((r) => [r.externalId, r]));
  const done = new Set<string>();
  const out: SyncRecord[] = [];
  const visit = (r: SyncRecord, stack: Set<string>): void => {
    if (done.has(r.externalId) || stack.has(r.externalId)) return;
    stack.add(r.externalId);
    const parent = r.parentExternalId ? byId.get(r.parentExternalId) : undefined;
    if (parent) visit(parent, stack);
    stack.delete(r.externalId);
    if (!done.has(r.externalId)) {
      done.add(r.externalId);
      out.push(r);
    }
  };
  for (const r of records) visit(r, new Set());
  return out;
}

/** Full reconcile of one entity type: pull everything, upsert (parents first),
 *  tombstone whatever vanished from the source. The poll's job + the safety net
 *  behind the webhook. */
export async function runReconcile(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  /** linkOnMatch: merge an unmapped source record into an existing same-name
   *  entity instead of duplicating it. On for the one-time IMPORT; off for the
   *  live poll/webhook (which is strict external-id). */
  opts: { linkOnMatch?: boolean } = {},
): Promise<ReconcileResult> {
  const records = await type.fetchAll(fetchCtx(ref));
  const ordered = topoSort(records.filter((r) => !r.deleted));
  const linkByName = opts.linkOnMatch ? await buildLinkMap(db, ref, type) : undefined;
  let created = 0;
  let updated = 0;
  let linked = 0;
  let tagsFailed = 0;
  for (const r of ordered) {
    const res = await upsertOne(db, ref, type, r, linkByName);
    tagsFailed += res.tagsFailed;
    if (res.action === "created") created++;
    else if (res.action === "updated") updated++;
    else if (res.action === "linked") linked++;
  }
  // Delete-detection: a mapped, non-tombstoned id that's gone from the source.
  const present = new Set(records.map((r) => r.externalId));
  const mapped = await db
    .selectFrom("core_integrations_synced_records")
    .select(["external_id"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("deleted_at", "is", null)
    .execute();
  let tombstoned = 0;
  for (const m of mapped) {
    if (!present.has(m.external_id) && (await tombstoneOne(db, ref, type, m.external_id))) {
      tombstoned++;
    }
  }
  return { created, updated, linked, tombstoned, total: records.length, tagsFailed };
}

/** Dry run: what runReconcile WOULD do, computed without a single write — the
 *  import preview. Classifies each source record (create / update / link /
 *  unchanged) and flags mapped ids that vanished from the source (delete). */
export async function planReconcile(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<ImportPlan> {
  const records = await type.fetchAll(fetchCtx(ref));
  const live = records.filter((r) => !r.deleted);
  const ordered = topoSort(live);
  const linkByName = await buildLinkMap(db, ref, type);

  // Current id-map for this (connection, entity type).
  const mapRows = await db
    .selectFrom("core_integrations_synced_records")
    .select(["external_id", "cobblr_entity_id", "source_hash", "deleted_at"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .execute();
  const byExternal = new Map(mapRows.map((m) => [m.external_id, m]));

  const writer = platform().entities.getWriter(type.targetKind);
  // Read an existing entity's CURRENT fields so the preview shows the match
  // both-sides (what's there now vs what the source would write). Best-effort —
  // a writer without `read` just yields the id + name.
  const readMatch = async (
    id: string,
    fallbackName: string,
  ): Promise<{ id: string; name: string; fields: Record<string, unknown> | null }> => {
    const f = writer?.read ? await writer.read(ref.orgId, id).catch(() => null) : null;
    return { id, name: String((f?.name as string | undefined) ?? fallbackName), fields: f };
  };

  const items: ImportPlanItem[] = [];
  const counts = { create: 0, update: 0, link: 0, unchanged: 0, delete: 0, total: live.length };
  for (const r of ordered) {
    const name = String(r.fields.name ?? r.externalId);
    const parentCobblrId = await resolveParent(db, ref, type.key, r.parentExternalId);
    const hash = hashRecord(type.targetKind, parentCobblrId, r.fields, r.references, r.instance ?? ref.targetInstances?.[type.key] ?? type.targetInstance, r.images, r.tags);
    // Show the resolved cross-section references in the preview (e.g. location_id
    // → the mirrored Cobblr id, or null if that section isn't imported yet).
    const fields = { ...r.fields, ...(await resolveReferences(db, ref, r)) };
    const m = byExternal.get(r.externalId);
    if (m && !m.deleted_at) {
      if (m.source_hash === hash) {
        // unchanged: identical hash, nothing to diff — skip the extra read.
        counts.unchanged++;
        items.push({ externalId: r.externalId, name, action: "unchanged", cobblrId: m.cobblr_entity_id, fields, match: { id: m.cobblr_entity_id, name } });
      } else {
        counts.update++;
        items.push({ externalId: r.externalId, name, action: "update", cobblrId: m.cobblr_entity_id, fields, match: await readMatch(m.cobblr_entity_id, name) });
      }
      continue;
    }
    const key = matchKey(name);
    const matched = key ? linkByName.get(key) : undefined;
    if (matched) {
      linkByName.delete(key); // one target per source row, mirrors apply
      counts.link++;
      items.push({ externalId: r.externalId, name, action: "link", cobblrId: matched.id, fields, match: await readMatch(matched.id, matched.name) });
    } else {
      counts.create++;
      items.push({ externalId: r.externalId, name, action: "create", fields });
    }
  }
  // Deletes: mapped, non-tombstoned ids no longer present in the source.
  const present = new Set(records.map((r) => r.externalId));
  for (const m of mapRows) {
    if (!m.deleted_at && !present.has(m.external_id)) {
      counts.delete++;
      const match = await readMatch(m.cobblr_entity_id, m.external_id);
      items.push({ externalId: m.external_id, name: match.name, action: "delete", cobblrId: m.cobblr_entity_id, match });
    }
  }
  return { entityType: type.key, targetKind: type.targetKind, counts, items };
}

/** Live webhook fast path: one record changed or was deleted. Uses the body's
 *  record when the webhook carries it, else fetchOne. Goes through the SAME
 *  upsert as reconcile, so the two are convergent + conflict-free. */
export async function applyWebhookHit(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  connector: SyncConnector,
  hit: SyncWebhookHit,
): Promise<void> {
  const type = connector.entityTypes.find((t) => t.key === hit.entityType);
  if (!type) return;
  if (hit.deleted) {
    await tombstoneOne(db, ref, type, hit.externalId);
    return;
  }
  const record =
    hit.record ?? (type.fetchOne ? await type.fetchOne(fetchCtx(ref), hit.externalId) : null);
  if (!record) return;
  if (record.deleted) {
    await tombstoneOne(db, ref, type, hit.externalId);
    return;
  }
  await upsertOne(db, ref, type, record);
}
