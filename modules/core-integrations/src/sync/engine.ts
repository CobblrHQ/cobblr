// The sync engine — the idempotent upsert + reconcile that BOTH the live
// webhook and the reconcile poll converge on. Everything is keyed by
// (connection, entity_type, external_id) through the synced_records id-map, so
// re-running is a no-op and the two paths never conflict. Parent hierarchy
// resolves through the same map (parent external id → mirrored Cobblr id).

import {
  platform,
  type EntityWriter,
  DuplicateRecordError,
  type SyncConnector,
  type SyncEntityType,
  type SyncRecord,
  type SyncFetchContext,
  type SyncWebhookHit,
  type ImportPlan,
  type ImportPlanItem,
} from "@cobblr/platform-contract";
import {
  conflictPolicyOf,
  flattenFields,
  identityOf,
  mergeFields,
  nestWrite,
  type ConflictPolicy,
  type FieldChange,
  type FieldMap,
  type MatchCandidate,
  type MergeBase,
} from "@cobblr/platform-contract/sync-merge";
import { createHash } from "node:crypto";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { edgeRelayFetch } from "./edge-fetch.js";
import { reconcileHoldings, retireHoldingsOf } from "./holdings.js";
import { mapLimit } from "./map-limit.js";
import { deleteMirror } from "./delete-mirror.js";

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
  /** Values this run could not map and so left alone, one sentence each
   *  ("Dremel 3D20: couldn't map My Shop locations 66 (location_id)"). A
   *  run with any is a warning, never a silent ok (#3900). Only records the run
   *  WROTE are listed; one whose source and mapping state are unchanged was
   *  said the first time. */
  unmapped: string[];
  /** Records the target refused to write or delete, one sentence each.
   *  The rest of the run carries on; a run with any is a warning. */
  failed: string[];
  /** Fields where the person's Cobblr value was kept over a different one at
   *  the source (the section's rule is "Cobblr wins" or "ask"). Counted, so a
   *  run that kept something says so; listed below only when it is to ask. */
  kept: number;
  /** Disagreements the section's rule asks the person to settle ("ask me"):
   *  Cobblr's value was kept, and is listed again each run until settled. */
  conflicts: ConflictNote[];
  /** Source records that could be more than one record already here, or one
   *  only nearly the same name. Nothing was created or linked for them. */
  ambiguous: AmbiguousNote[];
}

export interface ConflictNote {
  record: string;
  external_id: string;
  field: string;
  cobblr: unknown;
  source: unknown;
}

export interface AmbiguousNote {
  record: string;
  external_id: string;
  candidates: Array<{ id: string; name: string }>;
}

const shown = (v: unknown): string => (v === null || v === undefined || v === "" ? "empty" : `"${String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 60)}"`);

/** The sentences a run carries on its sync's state row. */
export function conflictWords(result: Pick<ReconcileResult, "conflicts" | "ambiguous">): string[] {
  return [
    ...result.conflicts.map((c) => `${c.record}: ${c.field} is ${shown(c.cobblr)} here and ${shown(c.source)} at the source; yours is kept until you say`),
    ...result.ambiguous.map((a) => `${a.record}: could be ${a.candidates.map((c) => `"${c.name}"`).join(" or ")} already here; nothing was made or linked until you say which`),
  ];
}

/** What a finished run writes on its sync's state row. */
export function runStatusOf(result: ReconcileResult): {
  last_status: "ok" | "warning";
  last_error: string | null;
  last_conflicts: { conflicts: ConflictNote[]; ambiguous: AmbiguousNote[] };
} {
  const last_conflicts = { conflicts: result.conflicts.slice(0, 100), ambiguous: result.ambiguous.slice(0, 100) };
  const said = [...result.failed, ...result.unmapped, ...conflictWords(result)];
  if (!said.length) return { last_status: "ok", last_error: null, last_conflicts };
  const head = said.slice(0, 3).join("; ");
  const more = said.length > 3 ? ` (and ${said.length - 3} more)` : "";
  return { last_status: "warning", last_error: `${head}${more}`, last_conflicts };
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

/** Existing records of the target kind that no source record of this section
 *  already mirrors: what an unmapped source record could be. Built from the
 *  writer's listForMatch minus the id-map, so a link never takes a record
 *  another external id owns. */
async function loadCandidates(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  writer: EntityWriter | null | undefined,
): Promise<MatchCandidate[]> {
  if (!writer?.listForMatch) return [];
  const existing = await writer.listForMatch(ref.orgId);
  const mapped = await db
    .selectFrom("core_integrations_synced_records")
    .select(["cobblr_entity_id"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("deleted_at", "is", null)
    .execute();
  const taken = new Set(mapped.map((m) => m.cobblr_entity_id));
  return existing.filter((e) => !taken.has(e.id)).map((e) => ({ id: e.id, name: e.name, kind: e.kind ?? null, instance: e.instance ?? null, parentId: e.parentId }));
}

/** What one run carries from record to record: the section's rule, who has
 *  been taken, and what it asked about. */
interface RunCtx {
  policy: ConflictPolicy;
  candidates?: Promise<MatchCandidate[]>;
  taken: Set<string>;
  conflicts: ConflictNote[];
  ambiguous: AmbiguousNote[];
  kept: number;
  /** A person said "make it new": skip the identity ladder for this record. */
  forceCreate?: boolean;
}

function newRun(policy: ConflictPolicy): RunCtx {
  return { policy, taken: new Set(), conflicts: [], ambiguous: [], kept: 0 };
}

/** The section's rule, as the person set it (Cobblr wins until they say). */
async function policyOf(db: Kysely<CoreIntegrationsDB>, ref: SyncConnectionRef, typeKey: string): Promise<ConflictPolicy> {
  const row = await db
    .selectFrom("core_integrations_sync_state")
    .select("conflict_policy")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", typeKey)
    .executeTakeFirst();
  return conflictPolicyOf(row?.conflict_policy);
}

/** What a connector is given to reach its source: the workspace's relay or its egress guard, never the plain fetch. */
export function fetchCtx(ref: SyncConnectionRef): SyncFetchContext {
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
  holdings?: SyncRecord["holdings"],
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
        ...(holdings ? { holdings } : {}),
      }),
    )
    .digest("hex");
}

/** Resolve a record's cross-section references to mirrored Cobblr ids (null if
 *  the referenced entity hasn't been imported yet). Same id-map as resolveParent,
 *  but pointed at any section — e.g. a printer's location_id → a location. */
/** Whether a Cobblr record is already the mirror of a DIFFERENT source record
 *  on this sync. */
async function mirroredByAnother(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  cobblrId: string,
  externalId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .select("external_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("cobblr_entity_id", "=", cobblrId)
    .where("external_id", "!=", externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return !!row;
}

/** The values a sync write is about to replace, for its history line: every
 *  plain field the write changes, as it was. A sync's history used to carry
 *  only the record's name, so a location it overwrote could not be put back
 *  from the log (#3900). Best-effort: a kind without `read` records nothing. */
async function replacedValues(
  writer: EntityWriter,
  orgId: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<{ was?: Record<string, unknown> }> {
  if (!writer.read) return {};
  const now = await writer.read(orgId, id).catch(() => null);
  if (!now) return {};
  const was: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "metadata" || k === "instance" || !(k in now)) continue;
    const before = now[k];
    if (before !== null && typeof before === "object") continue;
    if ((before ?? null) !== (v ?? null)) was[k] = before ?? null;
  }
  return Object.keys(was).length ? { was } : {};
}

/** A source value the sync could not turn into a Cobblr record: a reference
 *  (a machine's location) or a parent pointing at a source id no sync has
 *  mapped yet. */
export interface Unmapped {
  field: string;
  section: string;
  externalId: string;
}

/** Cross-section references resolved through the id-map. Only a MAPPED value
 *  is returned: an id with no Cobblr counterpart yet says nothing about the
 *  record, and writing it as null erased a location the owner had set every
 *  20 minutes (#3900). It is reported instead, and the caller leaves the
 *  field as it is. */
async function resolveReferences(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  record: SyncRecord,
): Promise<{ values: Record<string, string | null>; unmapped: Unmapped[] }> {
  const values: Record<string, string | null> = {};
  const unmapped: Unmapped[] = [];
  if (!record.references) return { values, unmapped };
  for (const [field, r] of Object.entries(record.references)) {
    const row = await db
      .selectFrom("core_integrations_synced_records")
      .select("cobblr_entity_id")
      .where("connector_row_id", "=", ref.connectorRowId)
      .where("entity_type", "=", r.section)
      .where("external_id", "=", r.externalId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row) values[field] = row.cobblr_entity_id;
    else unmapped.push({ field, section: r.section, externalId: r.externalId });
  }
  return { values, unmapped };
}

/** Where the unmapped values are, folded into the stored hash: an unchanged
 *  source whose reference later maps must still be written, and one that stays
 *  unmapped must not be rewritten (and re-logged) every run. */
function unmappedMark(unmapped: readonly Unmapped[]): string {
  return unmapped.length ? `:unmapped:${unmapped.map((u) => `${u.field}=${u.section}/${u.externalId}`).sort().join(",")}` : "";
}

/** "couldn't map My Shop locations 66 (location_id)", the words a run and
 *  a record's history carry. */
export function unmappedWords(unmapped: readonly Unmapped[], source: string): string[] {
  return unmapped.map((u) => `couldn't map ${source} ${u.section} ${u.externalId} (${u.field}), so it was left as it was`);
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

/** The record's fields as Cobblr holds them now: flat for the merge, with its
 *  metadata kept whole for the writer. Null when the kind cannot be read, in
 *  which case nothing can be protected and the source's values are written. */
async function readOurs(
  writer: EntityWriter,
  orgId: string,
  id: string,
): Promise<{ flat: FieldMap | null; metadata: Record<string, unknown> | null }> {
  if (!writer.read) return { flat: null, metadata: null };
  const now = await writer.read(orgId, id).catch(() => null);
  if (!now) return { flat: null, metadata: null };
  const meta = now.metadata && typeof now.metadata === "object" && !Array.isArray(now.metadata) ? (now.metadata as Record<string, unknown>) : null;
  return { flat: flattenFields(now), metadata: meta };
}

const filled = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

/** What the id-map remembers of a record's last run, if it is the shape the
 *  merge reads (a row from before this lands has none). */
function baseOf(raw: unknown): MergeBase | null {
  const r = raw as { source?: unknown; left?: unknown } | null;
  return r && typeof r.source === "object" && r.source && typeof r.left === "object" && r.left ? { source: r.source as FieldMap, left: r.left as FieldMap } : null;
}

/** What to remember of a record after a run: the source's word, and the record
 *  as the writer reads it back for every field that is now settled. */
function remember(prev: MergeBase | null, nextSource: FieldMap, settled: readonly string[], now: FieldMap | null): MergeBase {
  const left: FieldMap = { ...(prev?.left ?? {}) };
  for (const k of settled) left[k] = now?.[k] ?? null;
  return { source: nextSource, left };
}

type UpsertAction = "created" | "updated" | "linked" | "noop" | "ask";

/** Upsert ONE mapped record into its target kind, keyed by external id.
 *  Idempotent: unchanged source (same hash) is a no-op. Parent is resolved
 *  through the id-map; an unknown parent yields a null parent_id (orphan) that
 *  the next reconcile heals once the parent is synced.
 *
 *  A record that is already there (mapped, carrying the source's id, or one
 *  of the same name and kind) is merged field by field under the section's
 *  rule: what the person changed in Cobblr is kept, never written over. One
 *  that might be several is asked about, never created or guessed (#6336). */
function upsertOne(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  record: SyncRecord,
  run: RunCtx,
): Promise<{ action: UpsertAction; tagsFailed: number; unmapped: Unmapped[] }> {
  return oneAtATime(`${ref.connectorRowId}:${type.key}:${record.externalId}`, async () => {
    const res = await upsertOneLocked(db, ref, type, record, run);
    if (!record.holdings || res.action === "ask") return res;
    return { ...res, unmapped: [...res.unmapped, ...(await settleHoldings(db, ref, type, record))] };
  });
}

/** The card is written; make its other places match the source's. Runs on an
 *  unchanged card too: it is cheap (one read, a hash per place) and a place
 *  that could not be written last time, its location not mirrored yet, is
 *  written now. */
async function settleHoldings(db: Kysely<CoreIntegrationsDB>, ref: SyncConnectionRef, type: SyncEntityType, record: SyncRecord): Promise<Unmapped[]> {
  const writer = await platform().entities.getWriter(ref.orgId, type.targetKind);
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .select("cobblr_entity_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", record.externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!writer || !row) return [];
  const card = writer.read ? await writer.read(ref.orgId, row.cobblr_entity_id).catch(() => null) : null;
  const out = await reconcileHoldings({
    db,
    ref,
    writer,
    targetKind: type.targetKind,
    typeKey: type.key,
    cardExternalId: record.externalId,
    cardId: row.cobblr_entity_id,
    card: card as Record<string, unknown> | null,
    holdings: record.holdings ?? [],
  });
  return out.unmapped.map((u) => ({ field: "holding location", section: u.section, externalId: u.externalId }));
}

/** Work for one source id runs one at a time, in order. Create-or-link is a
 *  look then a write, so two pushes for the same new record (a webhook retry,
 *  a push racing a poll) both looked, both found nothing, and both created: a
 *  second machine the id-map never pointed at. The id-map's first-writer-wins
 *  insert withdraws the loser's copy, but not before the loser's own look at
 *  the first copy could miss it. Waiting turns the second push into a plain
 *  update of what the first made. Held per source id, so different records
 *  still run side by side. */
const turns = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = turns.get(key) ?? Promise.resolve();
  const mine = before.then(work, work);
  const tail = mine.catch(() => undefined);
  turns.set(key, tail);
  try {
    return await mine;
  } finally {
    if (turns.get(key) === tail) turns.delete(key);
  }
}

async function upsertOneLocked(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  record: SyncRecord,
  run: RunCtx,
): Promise<{ action: UpsertAction; tagsFailed: number; unmapped: Unmapped[] }> {
  const writer = await platform().entities.getWriter(ref.orgId, type.targetKind);
  if (!writer) throw new Error(`sync: no entity writer registered for ${type.targetKind}`);

  const parentCobblrId = await resolveParent(db, ref, type.key, record.parentExternalId);
  // Instance precedence: per-record instanceBy routing → the user's per-connection
  // target choice → the manifest's static default.
  const instance = record.instance ?? ref.targetInstances?.[type.key] ?? type.targetInstance ?? null;
  // References first, so the hash knows what could not be mapped yet.
  const refs = await resolveReferences(db, ref, record);
  const unmapped = [...refs.unmapped];
  // A parent the source names but no sync has mapped is the same case: the
  // record keeps the parent it has rather than being moved to the top.
  const parentUnmapped = !!record.parentExternalId && parentCobblrId === null;
  if (parentUnmapped) unmapped.push({ field: "parent_id", section: type.key, externalId: String(record.parentExternalId) });
  const unmappedSaid = unmapped.length ? unmappedWords(unmapped, type.sourceLabel || ref.connectorId) : [];
  const name = String(record.fields.name ?? record.externalId);
  const hash =
    hashRecord(type.targetKind, parentCobblrId, record.fields, record.references, instance, record.images, record.tags, record.holdings) + unmappedMark(unmapped) + `:p=${run.policy}`;

  const existing = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", record.externalId)
    .executeTakeFirst();

  // Unchanged source → no-op BEFORE any image fetch: pulling an image is a
  // network round-trip through the bridge, only worth it when actually writing.
  if (existing && !existing.deleted_at && existing.source_hash === hash) return { action: "noop", tagsFailed: 0, unmapped: [] };

  const baseFields: Record<string, unknown> = {
    ...record.fields,
    ...(parentUnmapped ? {} : { parent_id: parentCobblrId }),
    ...refs.values,
    ...(instance ? { instance } : {}),
  };

  /** Merge the source record into a record that is already there. */
  const mergeInto = async (targetId: string, how: "mapped" | "key" | "name" | "duplicate"): Promise<{ action: UpsertAction; tagsFailed: number; unmapped: Unmapped[] }> => {
    const base = how === "mapped" ? baseOf(existing?.synced_fields) : null;
    const ours = await readOurs(writer, ref.orgId, targetId);
    // A photo the person put on it is theirs: not fetched, not replaced, unless
    // the section is set to the source winning.
    let images: { fields: Record<string, string>; missing: number } = { fields: {}, missing: 0 };
    if (record.images && type.fetchBinary) {
      const have = ours.flat?.image_path;
      const baseHas = !!base && "image_path" in base;
      const theirsOwn = filled(have) && (!baseHas || String(have) !== String(base!.image_path));
      if (run.policy === "source" || !theirsOwn) images = await resolveImages(ref, type, record);
    }
    const fields = { ...baseFields, ...images.fields };
    const merged = mergeFields({ ours: ours.flat, theirs: flattenFields(fields), base, policy: run.policy });
    const keptFields: string[] = [];
    let asked = false;
    for (const c of merged.changes) {
      if (c.decision === "write") continue;
      run.kept++;
      keptFields.push(c.field);
      if (c.decision === "ask") {
        asked = true;
        // Named as the person knows it: the record's own name here, not the source's.
        run.conflicts.push({ record: String(ours.flat?.name ?? name), external_id: record.externalId, field: c.field, cobblr: c.ours, source: c.theirs });
      }
    }
    const storedHash = `${missingImagesHash(hash, images.missing)}${asked ? ":ask" : ""}`;
    const keptNote = unmappedSaid.length || keptFields.length ? { kept: [...unmappedSaid, ...keptFields.map((f) => `kept your ${f}`)] } : {};
    const toWrite = nestWrite(merged.write, ours.metadata);
    const wrote = Object.keys(merged.write).length > 0;
    let now = ours.flat;
    if (wrote) {
      const was = await replacedValues(writer, ref.orgId, targetId, toWrite);
      await writer.update(ref.orgId, targetId, toWrite);
      now = (await readOurs(writer, ref.orgId, targetId)).flat;
      await logSyncWrite(ref, type, "updated", targetId, { name: record.fields.name ?? null, ...(how === "mapped" ? {} : { adopted: true }), ...was, ...keptNote });
    } else if (how !== "mapped") {
      await logSyncWrite(ref, type, "updated", targetId, { name: record.fields.name ?? null, adopted: true, ...keptNote });
    }
    run.taken.add(targetId);
    const remembered = remember(base, merged.nextSource, merged.settled, now);
    if (how === "mapped") {
      await db
        .updateTable("core_integrations_synced_records")
        .set({ source_hash: storedHash, synced_fields: remembered as never, target_kind: type.targetKind, updated_at: new Date() })
        .where("id", "=", existing!.id)
        .execute();
    } else {
      await mapTo(db, ref, type, record.externalId, targetId, storedHash, remembered);
    }
    const tagsFailed = await attachTags(ref.orgId, type.targetKind, targetId, record.tags);
    return { action: how === "mapped" ? (wrote ? "updated" : "noop") : "linked", tagsFailed, unmapped };
  };

  if (existing && !existing.deleted_at) return mergeInto(existing.cobblr_entity_id, "mapped");

  // A record that is not mapped yet may still BE a record that is here: one
  // that carries this source's id (made by hand, or by an assistant, before the
  // sync reached it: #3836), else the one of the same name and kind. The key is
  // exact, a name is a guess, so the key goes first, and a name that is not
  // clearly one record is asked about instead of guessed.
  if (!existing && !run.forceCreate) {
    const found = await adoptableByKey(db, ref, type, writer, record.externalId);
    if (found && !run.taken.has(found)) return mergeInto(found, "key");
    if (writer.listForMatch) {
      const all = await (run.candidates ??= loadCandidates(db, ref, type, writer));
      const pool = all.filter((c) => !run.taken.has(c.id));
      const kind = typeof record.fields.kind === "string" ? record.fields.kind : null;
      const who = identityOf({ name, kind, instance, ...(parentUnmapped ? {} : { parentId: parentCobblrId }) }, pool);
      if ("link" in who) return mergeInto(who.link, "name");
      if ("ask" in who) {
        run.ambiguous.push({
          record: name,
          external_id: record.externalId,
          candidates: who.ask.map((id) => ({ id, name: pool.find((c) => c.id === id)?.name ?? id })),
        });
        return { action: "ask", tagsFailed: 0, unmapped: [] };
      }
    }
  }

  // New record, or a previously tombstoned one resurfacing → fresh mirror.
  const { fields: imageFields, missing: missingImages } = await resolveImages(ref, type, record);
  const fields = { ...baseFields, ...imageFields };
  // If a declared image didn't come across (e.g. the bridge hasn't self-updated to
  // binary support yet), store a RETRY-marked hash so the next reconcile re-pulls
  // it instead of short-circuiting on an unchanged hash — self-heals once ready.
  const storedHash = missingImagesHash(hash, missingImages);
  const theirsFlat = flattenFields(fields);
  let cobblrId: string;
  try {
    cobblrId = await writer.create(ref.orgId, fields);
  } catch (err) {
    // The target refused a second record of this name in this place: the one
    // already there IS this record (a room made by hand before the source
    // had it). Link to it, unless another source record already mirrors it,
    // in which case the refusal stands and the run says so.
    const there = err instanceof DuplicateRecordError ? err.existingId : null;
    if (!there || (await mirroredByAnother(db, ref, type, there, record.externalId))) throw err;
    return mergeInto(there, "duplicate");
  }
  run.taken.add(cobblrId);
  const syncedFields = remember(null, theirsFlat, Object.keys(theirsFlat), (await readOurs(writer, ref.orgId, cobblrId)).flat ?? theirsFlat);
  if (existing) {
    await db
      .updateTable("core_integrations_synced_records")
      .set({
        cobblr_entity_id: cobblrId,
        source_hash: storedHash,
        synced_fields: syncedFields as never,
        target_kind: type.targetKind,
        deleted_at: null,
        updated_at: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
  } else {
    // The id-map write is FIRST WRITER WINS, because the row this record looked
    // for a moment ago can exist by the time we write it.
    //
    // A reconcile for one (connection, entity type) holds a lock, but the live
    // webhook upserts one record outside it, so a push and a poll can both miss
    // the mapping, both create, and both write the id-map. Last-writer-wins used
    // to repoint the mapping and leave the first copy behind as a duplicate
    // nothing mirrored any more (the CI race of 2026-09-01 was the same shape).
    // Now the loser withdraws the copy it just made and writes into the winner's.
    const inserted = await db
      .insertInto("core_integrations_synced_records")
      .values({
        connector_row_id: ref.connectorRowId,
        entity_type: type.key,
        target_kind: type.targetKind,
        external_id: record.externalId,
        cobblr_entity_id: cobblrId,
        source_hash: storedHash,
        synced_fields: syncedFields as never,
      })
      .onConflict((oc) => oc.columns(["connector_row_id", "entity_type", "external_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) {
      const winner = await db
        .selectFrom("core_integrations_synced_records")
        .select(["cobblr_entity_id", "deleted_at"])
        .where("connector_row_id", "=", ref.connectorRowId)
        .where("entity_type", "=", type.key)
        .where("external_id", "=", record.externalId)
        .executeTakeFirst();
      if (winner && !winner.deleted_at && winner.cobblr_entity_id !== cobblrId) {
        await writer.delete(ref.orgId, cobblrId);
        await writer.update(ref.orgId, winner.cobblr_entity_id, fields);
        await logSyncWrite(ref, type, "updated", winner.cobblr_entity_id, { name: record.fields.name ?? null, ...(unmappedSaid.length ? { kept: unmappedSaid } : {}) });
        return { action: "updated", tagsFailed: await attachTags(ref.orgId, type.targetKind, winner.cobblr_entity_id, record.tags), unmapped };
      }
      await mapTo(db, ref, type, record.externalId, cobblrId, storedHash, syncedFields);
    }
  }
  await logSyncWrite(ref, type, "created", cobblrId, { name: record.fields.name ?? null, ...(unmappedSaid.length ? { kept: unmappedSaid } : {}) });
  return { action: "created", tagsFailed: await attachTags(ref.orgId, type.targetKind, cobblrId, record.tags), unmapped };
}

/** A hash that says an image did not come across, so the next run pulls it. */
function missingImagesHash(hash: string, missing: number): string {
  return missing > 0 ? `${hash}:img-retry` : hash;
}

/** The existing record that already carries this source record's key, when
 *  the source declares one and the target kind can look it up. Oldest first,
 *  and never one the id-map already mirrors from a DIFFERENT source record. */
async function adoptableByKey(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  writer: EntityWriter | null | undefined,
  externalId: string,
): Promise<string | null> {
  if (!type.keyField || !writer?.findByKey) return null;
  const found = await writer.findByKey(ref.orgId, type.keyField, externalId);
  if (!found) return null;
  const taken = await db
    .selectFrom("core_integrations_synced_records")
    .select("external_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("cobblr_entity_id", "=", found)
    .where("external_id", "!=", externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return taken ? null : found;
}

/** Point this source record's id-map row at `cobblrId` (insert, or revive and
 *  repoint a tombstoned one). An upsert for the same reason as the create path:
 *  two reconciles can overlap. */
async function mapTo(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  externalId: string,
  cobblrId: string,
  storedHash: string,
  syncedFields: MergeBase | null = null,
): Promise<void> {
  await db
    .insertInto("core_integrations_synced_records")
    .values({
      connector_row_id: ref.connectorRowId,
      entity_type: type.key,
      target_kind: type.targetKind,
      external_id: externalId,
      cobblr_entity_id: cobblrId,
      source_hash: storedHash,
      synced_fields: syncedFields as never,
    })
    .onConflict((oc) =>
      oc.columns(["connector_row_id", "entity_type", "external_id"]).doUpdateSet({
        cobblr_entity_id: cobblrId,
        source_hash: storedHash,
        synced_fields: syncedFields as never,
        target_kind: type.targetKind,
        deleted_at: null,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** An activity row for what the sync did to a record, attributed to the sync
 *  itself. Records a sync created used to appear with nothing in the history
 *  saying where they came from (#3836). Never fails the sync: the write already
 *  happened, and a missing history line is not a reason to undo it. */
async function logSyncWrite(
  ref: SyncConnectionRef,
  type: SyncEntityType,
  action: "created" | "updated",
  id: string,
  diff: Record<string, unknown>,
): Promise<void> {
  const [module, entityType] = type.targetKind.split(":");
  try {
    await platform().activity.log({
      orgId: ref.orgId,
      userId: null,
      action,
      ref: { module: module ?? null, entityType: entityType ?? type.targetKind, entityId: id },
      diff,
      // The source by its own name: the feed says "Homebox updated 47
      // places" with the sync's icon (#6564).
      via: { kind: "sync", label: type.sourceLabel || ref.connectorId },
    });
  } catch (err) {
    console.warn(`[sync] activity for ${type.targetKind}/${id} not written:`, (err as Error).message);
  }
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

/** How many tombstones a reconcile runs at once. */
const TOMBSTONE_CONCURRENCY = 4;

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
  const writer = await platform().entities.getWriter(ref.orgId, type.targetKind);
  if (!writer) throw new Error(`sync: no entity writer registered for ${type.targetKind}`);
  await retireHoldingsOf({ db, ref, writer, targetKind: type.targetKind, typeKey: type.key, cardExternalId: externalId, cardId: row.cobblr_entity_id });
  await deleteMirror(writer, ref.orgId, row.cobblr_entity_id);
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
/** The lock one reconcile of a given sync holds, so two never overlap. */
export function reconcileLockName(connectorRowId: string, entityTypeKey: string): string {
  return `core-integrations.reconcile:${connectorRowId}:${entityTypeKey}`;
}

/** Raised when another reconcile of the same sync is already running. Callers
 *  decide what that means: the worker skips (its next tick will catch up), a
 *  person pressing Import is told to wait rather than shown a database error. */
export class ReconcileBusyError extends Error {
  constructor(msg = "A sync is already running for this connection. Try again in a moment.") {
    super(msg);
    this.name = "ReconcileBusyError";
  }
}

export async function runReconcile(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<ReconcileResult> {
  // ONE reconcile of a sync at a time. The poll worker and the import/live
  // routes reconcile the same (connection, entity type) from different places,
  // and two at once do the same work twice: duplicate creates raced on the
  // id-map's unique constraint (CI, 2026-09-01) and the counts returned to the
  // caller were whatever its own half managed.
  let out: ReconcileResult | null = null;
  const run = await platform().exclusive.run(reconcileLockName(ref.connectorRowId, type.key), async () => {
    out = await reconcileOnce(db, ref, type);
  });
  if (!run.ran || !out) throw new ReconcileBusyError();
  return out;
}

async function reconcileOnce(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<ReconcileResult> {
  const records = await type.fetchAll(fetchCtx(ref));
  const ordered = topoSort(records.filter((r) => !r.deleted));
  const run = newRun(await policyOf(db, ref, type.key));
  let created = 0;
  let updated = 0;
  let linked = 0;
  let tagsFailed = 0;
  const unmapped: string[] = [];
  const failed: string[] = [];
  const source = type.sourceLabel || ref.connectorId;
  for (const r of ordered) {
    // One record the target refuses must not fail the section: a single
    // duplicate name stopped every location syncing, run after run, and left
    // everything that pointed at them unmapped (#3900). It is said on the run.
    let res: Awaited<ReturnType<typeof upsertOne>>;
    try {
      res = await upsertOne(db, ref, type, r, run);
    } catch (err) {
      failed.push(`${String(r.fields.name ?? r.externalId)}: ${(err as Error).message}`);
      continue;
    }
    tagsFailed += res.tagsFailed;
    for (const w of unmappedWords(res.unmapped, source)) unmapped.push(`${String(r.fields.name ?? r.externalId)}: ${w}`);
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
  // A few at a time: each is a writer delete (the record kept in Recently
  // deleted, its events, its history), about 230 ms apiece, so a source that
  // dropped 130 parts held the sync's lock for 20 s one by one, and past a
  // minute on a busy box. Distinct records; the tenant pool holds five.
  const gone = mapped.filter((m) => !present.has(m.external_id));
  const done = await mapLimit(gone, TOMBSTONE_CONCURRENCY, async (m) => {
    try {
      return await tombstoneOne(db, ref, type, m.external_id);
    } catch (err) {
      failed.push(`${source} ${m.external_id}: could not delete: ${(err as Error).message}`);
      return false;
    }
  });
  const tombstoned = done.filter(Boolean).length;
  return { created, updated, linked, tombstoned, total: records.length, tagsFailed, unmapped, failed, kept: run.kept, conflicts: run.conflicts, ambiguous: run.ambiguous };
}

/** Dry run: what runReconcile WOULD do, computed without a single write — the
 *  preview and the dry run. It makes the same decisions the run makes, by the
 *  same rules (sync-merge.ts), so what it says is what a run does: each source
 *  record is created, linked to the record that is already there, updated (with
 *  each field the two sides disagree about and what the section's rule does
 *  with it), left alone, or asked about; and mapped ids that vanished from the
 *  source are flagged for delete. */
export async function planReconcile(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
): Promise<ImportPlan> {
  const records = await type.fetchAll(fetchCtx(ref));
  const live = records.filter((r) => !r.deleted);
  const ordered = topoSort(live);
  const run = newRun(await policyOf(db, ref, type.key));

  // Current id-map for this (connection, entity type).
  const mapRows = await db
    .selectFrom("core_integrations_synced_records")
    .select(["external_id", "cobblr_entity_id", "source_hash", "synced_fields", "deleted_at"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .execute();
  const byExternal = new Map(mapRows.map((m) => [m.external_id, m]));

  const writer = await platform().entities.getWriter(ref.orgId, type.targetKind);
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
  const counts = { create: 0, update: 0, link: 0, unchanged: 0, delete: 0, ask: 0, total: live.length };
  for (const r of ordered) {
    const name = String(r.fields.name ?? r.externalId);
    const parentCobblrId = await resolveParent(db, ref, type.key, r.parentExternalId);
    const instance = r.instance ?? ref.targetInstances?.[type.key] ?? type.targetInstance ?? null;
    const refs = await resolveReferences(db, ref, r);
    const parentUnmapped = !!r.parentExternalId && parentCobblrId === null;
    const unmapped = [...refs.unmapped];
    if (parentUnmapped) unmapped.push({ field: "parent_id", section: type.key, externalId: String(r.parentExternalId) });
    const hash = hashRecord(type.targetKind, parentCobblrId, r.fields, r.references, instance, r.images, r.tags, r.holdings) + unmappedMark(unmapped) + `:p=${run.policy}`;
    // Show the resolved cross-section references in the preview (e.g. location_id
    // → the mirrored Cobblr id, or left out if that section isn't imported yet).
    const fields = { ...r.fields, ...refs.values };
    const theirs = flattenFields({ ...r.fields, ...(parentUnmapped ? {} : { parent_id: parentCobblrId }), ...refs.values, ...(instance ? { instance } : {}) });
    const m = byExternal.get(r.externalId);

    // Which record this one is, by the order the run asks: its stored id, the
    // source's id on a record, one of the same name and kind.
    let target: { id: string; name: string; base: MergeBase | null; how: "mapped" | "link" } | null = null;
    if (m && !m.deleted_at) {
      if (m.source_hash === hash) {
        counts.unchanged++;
        items.push({ externalId: r.externalId, name, action: "unchanged", cobblrId: m.cobblr_entity_id, fields, match: { id: m.cobblr_entity_id, name } });
        run.taken.add(m.cobblr_entity_id);
        continue;
      }
      target = { id: m.cobblr_entity_id, name, base: baseOf(m.synced_fields), how: "mapped" };
    } else if (!m) {
      const byKey = await adoptableByKey(db, ref, type, writer, r.externalId);
      if (byKey && !run.taken.has(byKey)) target = { id: byKey, name, base: null, how: "link" };
      else if (writer?.listForMatch) {
        const all = await (run.candidates ??= loadCandidates(db, ref, type, writer));
        const pool = all.filter((c) => !run.taken.has(c.id));
        const kind = typeof r.fields.kind === "string" ? r.fields.kind : null;
        const who = identityOf({ name, kind, instance, ...(parentUnmapped ? {} : { parentId: parentCobblrId }) }, pool);
        if ("link" in who) target = { id: who.link, name: pool.find((c) => c.id === who.link)?.name ?? name, base: null, how: "link" };
        else if ("ask" in who) {
          counts.ask++;
          items.push({
            externalId: r.externalId,
            name,
            action: "ask",
            fields,
            candidates: who.ask.map((id) => ({ id, name: pool.find((c) => c.id === id)?.name ?? id })),
          });
          continue;
        }
      }
    }
    if (!target) {
      counts.create++;
      items.push({ externalId: r.externalId, name, action: "create", fields });
      continue;
    }
    run.taken.add(target.id);
    const ours = await readOurs(writer!, ref.orgId, target.id);
    const merged = mergeFields({ ours: ours.flat, theirs, base: target.base, policy: run.policy });
    const match = await readMatch(target.id, target.name);
    const asked = merged.changes.some((c) => c.decision === "ask");
    const writes = merged.changes.some((c) => c.decision === "write");
    const changes: FieldChange[] = merged.changes;
    if (target.how === "link") {
      counts.link++;
      items.push({ externalId: r.externalId, name, action: "link", cobblrId: target.id, fields, match, ...(changes.length ? { changes } : {}) });
    } else if (asked) {
      counts.ask++;
      items.push({ externalId: r.externalId, name, action: "ask", cobblrId: target.id, fields, match, changes });
    } else if (writes) {
      counts.update++;
      items.push({ externalId: r.externalId, name, action: "update", cobblrId: target.id, fields, match, changes });
    } else {
      counts.unchanged++;
      items.push({ externalId: r.externalId, name, action: "unchanged", cobblrId: target.id, fields, match, ...(changes.length ? { changes } : {}) });
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
  // How many more places each record will be kept in, whatever happens to its card.
  const placesOf = new Map(live.map((r) => [r.externalId, r.holdings?.length ?? 0]));
  for (const it of items) {
    const n = placesOf.get(it.externalId);
    if (n && it.action !== "delete") it.holdings = n;
  }
  return { entityType: type.key, targetKind: type.targetKind, policy: run.policy, counts, items };
}

/** A person's answer to what a run asked about. A source record that could be
 *  more than one record already here: it IS this one (link), or it is new
 *  (create). A field the two sides disagree about under "ask me": keep Cobblr's
 *  value, or take the source's. The answer is the one thing that happens, not
 *  something the next run decides: the id-map is written and the record merged
 *  (link), the record is made (create), or the field is settled and remembered
 *  so it is not asked again (keep, take). */
export type AskedAnswer =
  | { action: "link"; cobblrId: string }
  | { action: "create" }
  | { action: "keep" | "take"; field: string };

export async function resolveAsked(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  externalId: string,
  answer: AskedAnswer,
): Promise<{ action: "linked" | "created" | "kept" | "taken" }> {
  const writer = await platform().entities.getWriter(ref.orgId, type.targetKind);
  if (!writer) throw new Error(`sync: no entity writer registered for ${type.targetKind}`);
  const record = type.fetchOne ? await type.fetchOne(fetchCtx(ref), externalId) : ((await type.fetchAll(fetchCtx(ref))).find((r) => r.externalId === externalId) ?? null);
  if (!record || record.deleted) throw new Error("the source no longer has that record");
  const run = newRun(await policyOf(db, ref, type.key));
  const locked = await platform().exclusive.run(reconcileLockName(ref.connectorRowId, type.key), async () => {
    if (answer.action === "create") {
      run.forceCreate = true;
      await upsertOne(db, ref, type, record, run);
      return;
    }
    if (answer.action === "link") {
      if (!(await readOurs(writer, ref.orgId, answer.cobblrId)).flat) throw new Error("that record is not here any more");
      if (await mirroredByAnotherRecord(db, ref, type, answer.cobblrId)) throw new Error("another source record already mirrors that one");
      await mapTo(db, ref, type, externalId, answer.cobblrId, "", null);
      await upsertOne(db, ref, type, record, run);
      return;
    }
    await settleField(db, ref, type, writer, record, answer);
  });
  if (!locked.ran) throw new ReconcileBusyError();
  return { action: answer.action === "link" ? "linked" : answer.action === "create" ? "created" : answer.action === "keep" ? "kept" : "taken" };
}

/** Settle one field of a mapped record: remember what the record holds as what
 *  the sync left (keep), or write the source's value and remember that (take),
 *  and drop the stored hash so the next run looks at the record afresh. */
async function settleField(
  db: Kysely<CoreIntegrationsDB>,
  ref: SyncConnectionRef,
  type: SyncEntityType,
  writer: EntityWriter,
  record: SyncRecord,
  answer: { action: "keep" | "take"; field: string },
): Promise<void> {
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("external_id", "=", record.externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new Error("that source record is not mirrored here yet");
  const parentCobblrId = await resolveParent(db, ref, type.key, record.parentExternalId);
  const refs = await resolveReferences(db, ref, record);
  const instance = record.instance ?? ref.targetInstances?.[type.key] ?? type.targetInstance ?? null;
  const theirs = flattenFields({ ...record.fields, ...(record.parentExternalId && parentCobblrId === null ? {} : { parent_id: parentCobblrId }), ...refs.values, ...(instance ? { instance } : {}) });
  if (!(answer.field in theirs)) throw new Error(`the source does not send ${answer.field}`);
  const ours = await readOurs(writer, ref.orgId, row.cobblr_entity_id);
  if (answer.action === "take") {
    await writer.update(ref.orgId, row.cobblr_entity_id, nestWrite({ [answer.field]: theirs[answer.field] }, ours.metadata));
    await logSyncWrite(ref, type, "updated", row.cobblr_entity_id, { name: record.fields.name ?? null, took: [answer.field] });
  }
  const now = answer.action === "take" ? (await readOurs(writer, ref.orgId, row.cobblr_entity_id)).flat : ours.flat;
  const prev = baseOf(row.synced_fields);
  const remembered = remember(prev, { ...(prev?.source ?? {}), [answer.field]: theirs[answer.field] }, [answer.field], now);
  await db
    .updateTable("core_integrations_synced_records")
    .set({ synced_fields: remembered as never, source_hash: null, updated_at: new Date() })
    .where("id", "=", row.id)
    .execute();
}

/** Whether any source record of this section already mirrors this record. */
async function mirroredByAnotherRecord(db: Kysely<CoreIntegrationsDB>, ref: SyncConnectionRef, type: SyncEntityType, cobblrId: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .select("external_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .where("cobblr_entity_id", "=", cobblrId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return !!row;
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
  await upsertOne(db, ref, type, record, newRun(await policyOf(db, ref, type.key)));
}
