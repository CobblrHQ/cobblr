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
  connectorId: string; // the registered SyncConnector id, e.g. "companion app"
  baseUrl: string;
  credentials: Record<string, unknown>; // decrypted
  /** "direct" = the cloud fetches base_url itself (egress-guarded; reaches a
   *  private address only on a self-hosted instance). "edge" = the request rides
   *  the workspace's dial-out relay and a local bridge fetches base_url — so a
   *  hosted instance reaches a LAN source without ever touching the private IP. */
  transport: "direct" | "edge";
  /** Which edge bridge serves this connection (edge transport); null = default. */
  bridge: string | null;
}

export interface ReconcileResult {
  created: number;
  updated: number;
  linked: number;
  tombstoned: number;
  total: number;
}

/** Existing same-name entities not yet owned by this connection — the merge
 *  targets for a one-time import. Name → cobblr id, lowercased/trimmed. Built
 *  from the writer's listForMatch minus anything already in the id-map, so a
 *  link never hijacks an entity another external id already mirrors. */
async function buildLinkMap(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<Map<string, string>> {
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
  const out = new Map<string, string>();
  for (const e of existing) {
    const key = e.name.trim().toLowerCase();
    if (!key || taken.has(e.id) || out.has(key)) continue; // ambiguous dup name → skip
    out.set(key, e.id);
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
): string {
  return createHash("sha1")
    .update(JSON.stringify({ targetKind, parentCobblrId, fields }))
    .digest("hex");
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
  linkByName?: Map<string, string>,
): Promise<"created" | "updated" | "linked" | "noop"> {
  const writer = platform().entities.getWriter(type.targetKind);
  if (!writer) throw new Error(`sync: no entity writer registered for ${type.targetKind}`);

  const parentCobblrId = await resolveParent(db, ref, type.key, record.parentExternalId);
  const fields = { ...record.fields, parent_id: parentCobblrId };
  const hash = hashRecord(type.targetKind, parentCobblrId, record.fields);

  const existing = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", record.externalId)
    .executeTakeFirst();

  if (existing && !existing.deleted_at) {
    if (existing.source_hash === hash) return "noop";
    await writer.update(ref.orgId, existing.cobblr_entity_id, fields);
    await db
      .updateTable("core_integrations_synced_records")
      .set({ source_hash: hash, target_kind: type.targetKind, updated_at: new Date() })
      .where("id", "=", existing.id)
      .execute();
    return "updated";
  }

  // Import merge: an unmapped record whose name matches an existing entity →
  // adopt it (update in place + map) rather than create a duplicate.
  if (!existing && linkByName) {
    const key = String(record.fields.name ?? "").trim().toLowerCase();
    const matchId = key ? linkByName.get(key) : undefined;
    if (matchId) {
      linkByName.delete(key);
      await writer.update(ref.orgId, matchId, fields);
      await db
        .insertInto("core_integrations_synced_records")
        .values({
          connector_row_id: ref.connectorRowId,
          entity_type: type.key,
          target_kind: type.targetKind,
          external_id: record.externalId,
          cobblr_entity_id: matchId,
          source_hash: hash,
        })
        .execute();
      return "linked";
    }
  }

  // New record, or a previously tombstoned one resurfacing → fresh mirror.
  const cobblrId = await writer.create(ref.orgId, fields);
  if (existing) {
    await db
      .updateTable("core_integrations_synced_records")
      .set({
        cobblr_entity_id: cobblrId,
        source_hash: hash,
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
        source_hash: hash,
      })
      .execute();
  }
  return "created";
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
  for (const r of ordered) {
    const res = await upsertOne(db, ref, type, r, linkByName);
    if (res === "created") created++;
    else if (res === "updated") updated++;
    else if (res === "linked") linked++;
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
  return { created, updated, linked, tombstoned, total: records.length };
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

  const items: ImportPlanItem[] = [];
  const counts = { create: 0, update: 0, link: 0, unchanged: 0, delete: 0, total: live.length };
  for (const r of ordered) {
    const name = String(r.fields.name ?? r.externalId);
    const parentCobblrId = await resolveParent(db, ref, type.key, r.parentExternalId);
    const hash = hashRecord(type.targetKind, parentCobblrId, r.fields);
    const m = byExternal.get(r.externalId);
    if (m && !m.deleted_at) {
      if (m.source_hash === hash) {
        counts.unchanged++;
        items.push({ externalId: r.externalId, name, action: "unchanged", cobblrId: m.cobblr_entity_id });
      } else {
        counts.update++;
        items.push({ externalId: r.externalId, name, action: "update", cobblrId: m.cobblr_entity_id });
      }
      continue;
    }
    const key = name.trim().toLowerCase();
    const matchId = key ? linkByName.get(key) : undefined;
    if (matchId) {
      linkByName.delete(key); // one target per source row, mirrors apply
      counts.link++;
      items.push({ externalId: r.externalId, name, action: "link", cobblrId: matchId });
    } else {
      counts.create++;
      items.push({ externalId: r.externalId, name, action: "create" });
    }
  }
  // Deletes: mapped, non-tombstoned ids no longer present in the source.
  const present = new Set(records.map((r) => r.externalId));
  for (const m of mapRows) {
    if (!m.deleted_at && !present.has(m.external_id)) {
      counts.delete++;
      items.push({ externalId: m.external_id, name: m.external_id, action: "delete", cobblrId: m.cobblr_entity_id });
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
