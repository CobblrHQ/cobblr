// A record made without a photo is offered one (#3818).
//
// A machine record, "Dremel 3D20", was made through the assistant and sat
// with a letter where its picture should be: only the scan inbox ever looked
// for pictures. Now every record made or renamed without a picture, by any
// door (the kernel's platform.entity.saved, which every module route and
// instance passes), is queued here, and a sweep looks for its picture on the
// same ladder the inbox climbs (name plus its maker, the heuristics, the
// stock-preview filter, no AI). What it finds is SUGGESTED: the record shows
// it with Use it, Show others and No thanks. A workspace may ask for the top
// match to be applied instead. A picture a person set is never replaced, and
// No thanks is remembered until the record's name changes.
//
// OFF until a workspace turns it on (#7447): an update never opts anyone in,
// and on upgrade the backfill had searched the web for every existing record.
// A suggested picture is held here, in the suggestion store, and is not a
// file in Files until someone says Use it; it had been stored as a file the
// moment it was found, so Files doubled and a No thanks kept the file.
//
// Background and trickled: the request that made the record never waits, and
// a 500-row import is 500 queued rows, looked at three per workspace per
// round, never 500 searches at once.
//
// BORN WITH: runSweepEnableSteps (its onEnable). A workspace enabled with
// records gets them queued and the backfill marked done at enable, not at the
// pass's first round.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ENTITY_SAVED_EVENT, type EntitySavedEvent } from "@cobblr/platform-contract/entity-saved";
import type { CoreScanDB } from "../db.js";
import { derivedQueryFor, fetchImage, imagePathForFile, storeFetchedImage, type FetchedImage } from "./entity-image.js";
import { pictureOptions } from "./picture-options.js";
import { pickPhotoOf } from "./shows-the-thing.js";
import { forHolding, HELD_DAYS, heldColumns, keepHeldWithinLifetime } from "./held-picture.js";
import { curatedImageUrl } from "./curated-images.js";
import { scanTargetsForOrg } from "./scan-target.js";

export const RECORD_PHOTO_PASS = "core-scan.record-photo-suggestions";
/** Records looked at per workspace per round. */
export const PER_ROUND = 3;
/** A round with more queued goes again soon; an empty one waits. */
export const ROUND_MS = 60_000;
export const IDLE_MS = 10 * 60_000;
/** Searches a record gets before it is left with none: one. A search that
 *  found nothing will find nothing on the same name a minute later, and a
 *  record goes back in the queue when its name changes or a person asks
 *  (the owner, on a placeholder that never filled: "try once"). */
export const MAX_ATTEMPTS = 1;
/** Existing records put in the queue per workspace by the one backfill. */
export const BACKFILL_LIMIT = 500;

type Db = Kysely<CoreScanDB>;

/** What happens to a saved record. Pure, so the whole queueing rule is one
 *  function a test can hold. */
export function queueDecision(
  event: Pick<EntitySavedEvent, "title" | "hasImage">,
  existing: { status: string; name: string } | null,
): "queue" | "forget" | "leave" {
  if (event.hasImage === null) return "leave"; // the kind has no picture
  if (event.hasImage) return existing && existing.status !== "applied" ? "forget" : "leave";
  const name = (event.title ?? "").trim();
  if (!name) return "leave";
  if (!existing) return "queue";
  // The same name as last time: whatever was decided stands, a No thanks
  // most of all. A new name is a new question.
  if (existing.name.trim().toLowerCase() === name.toLowerCase()) return "leave";
  return "queue";
}

/** Subscribe to the kernel's signal. Called once at module load. */
export function subscribeRecordPhotos(
  storeFor: (orgId: string) => Promise<SuggestionStore> = async (orgId) => kyselyStore((await platform().tenants.getDb(orgId)) as unknown as Db),
): void {
  platform().events.on(ENTITY_SAVED_EVENT, "core-scan", async (payload: unknown) => {
    const e = payload as EntitySavedEvent;
    // The scan's own records are not this pass's: the inbox finds their
    // pictures itself.
    if (e.kind.startsWith("core-scan:")) return;
    if (await noteSaved(await storeFor(e.orgId), e)) nudge(e.orgId);
  });
}

/** Look at a workspace's queue soon, not at the next idle round, so a record
 *  made a moment ago is offered its picture while the person is still
 *  looking at it. Coalesced: a burst of saves (an import) is one nudge, and
 *  the round itself takes three, the rest following the drain cadence; a
 *  round another visit kept from running is asked for again (sweeps.soon). */
export function nudge(orgId: string): void {
  platform().sweeps.soon(RECORD_PHOTO_PASS, orgId);
}

/** Where the queue lives. The Kysely store below in the product; a test
 *  holds the same rules against an in-memory one. */
export interface SuggestionStore {
  get(kind: string, id: string): Promise<{ status: string; name: string } | null>;
  queue(e: EntitySavedEvent): Promise<void>;
  forget(kind: string, id: string): Promise<void>;
  /** The queued rows, newest first. */
  queued(limit: number): Promise<Array<{ entity_kind: string; entity_id: string; attempts: number }>>;
  /** Write only a row still queued: a No thanks or a picture set while the
   *  search was out is never overwritten. */
  settle(kind: string, id: string, set: { status: "queued" | "suggested" | "none" | "applied"; attempts?: number; file_id?: string; source_url?: string; query?: string; held?: FetchedImage }): Promise<void>;
  autoApply(): Promise<boolean>;
  /** Whether this workspace looks for pictures at all (#7447): off until it
   *  turns it on. */
  enabled(): Promise<boolean>;
  /** Whether this workspace's existing records were queued already. */
  backfilled(): Promise<boolean>;
  markBackfilled(): Promise<void>;
  /** The workspace's settings row, made if missing, every setting at its
   *  default (suggestions off): what a workspace is born with. */
  ensureConfig(): Promise<void>;
  /** Queue a record not seen before; one already known is left as it is. */
  queueIfAbsent(kind: string, id: string, name: string): Promise<boolean>;
  /** A person asked: search this record again, whatever it was. */
  requeue(kind: string, id: string): Promise<boolean>;
}

export function kyselyStore(db: Db): SuggestionStore {
  const T = "core_scan_record_photo_suggestions" as const;
  return {
    // ONE row per record, whatever kind name a save arrived under: a machine
    // in a collection is saved as `<collection>:item` by one door and as the
    // module's own kind by another, and two rows for one record answered the
    // page differently on every open (one "suggested", one "none").
    get: async (_kind, id) =>
      (await db.selectFrom(T).select(["status", "name"]).where("entity_id", "=", id).orderBy("updated_at", "desc").executeTakeFirst()) ?? null,
    queue: async (e) => {
      const name = (e.title ?? "").trim();
      const fresh = { name, status: "queued" as const, file_id: null, source_url: null, ...heldColumns(null), attempts: 0, updated_at: new Date() };
      const moved = await db.updateTable(T).set(fresh).where("entity_id", "=", e.id).executeTakeFirst();
      if (Number(moved.numUpdatedRows ?? 0) > 0) return;
      await db
        .insertInto(T)
        .values({ entity_kind: e.kind, entity_id: e.id, name, user_id: e.userId })
        .onConflict((oc) => oc.columns(["entity_kind", "entity_id"]).doUpdateSet(fresh))
        .execute();
    },
    forget: async (_kind, id) => {
      await db.deleteFrom(T).where("entity_id", "=", id).execute();
    },
    // Newest first: the record someone made a moment ago is the one they are
    // looking at, and an import's backlog trickles in behind it.
    queued: (limit) => db.selectFrom(T).select(["entity_kind", "entity_id", "attempts"]).where("status", "=", "queued").orderBy("updated_at", "desc").limit(limit).execute(),
    settle: async (kind, id, { held, ...set }) => {
      await db
        .updateTable(T)
        // A preview, never the whole download, and only for HELD_DAYS (#8941).
        .set({ ...set, ...(held ? heldColumns(await forHolding(held)) : {}), updated_at: new Date() })
        .where("entity_kind", "=", kind)
        .where("entity_id", "=", id)
        .where("status", "=", "queued")
        .execute();
    },
    autoApply: () => readAutoApply(db),
    enabled: () => readSuggestOn(db),
    backfilled: async () => {
      const row = await db.selectFrom("core_scan_photo_suggest_config").select("backfilled_at").executeTakeFirst().catch(() => undefined);
      return !!row?.backfilled_at;
    },
    markBackfilled: async () => {
      await db
        .insertInto("core_scan_photo_suggest_config")
        .values({ id: true, backfilled_at: new Date() })
        .onConflict((oc) => oc.column("id").doUpdateSet({ backfilled_at: new Date(), updated_at: new Date() }))
        .execute();
    },
    ensureConfig: async () => {
      await db.insertInto("core_scan_photo_suggest_config").values({ id: true }).onConflict((oc) => oc.column("id").doNothing()).execute();
    },
    queueIfAbsent: async (kind, id, name) => {
      // Known under any kind name is known.
      if (await db.selectFrom(T).select("entity_id").where("entity_id", "=", id).executeTakeFirst()) return false;
      // Dated at the epoch: the queue is newest first, and a backlog of old
      // records must wait behind the record someone made a moment ago.
      const r = await db
        .insertInto(T)
        .values({ entity_kind: kind, entity_id: id, name, updated_at: new Date(0) })
        .onConflict((oc) => oc.columns(["entity_kind", "entity_id"]).doNothing())
        .executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    requeue: async (kind, id) => {
      const r = await db
        .updateTable(T)
        .set({ status: "queued", attempts: 0, file_id: null, source_url: null, ...heldColumns(null), updated_at: new Date() })
        .where("entity_kind", "=", kind)
        .where("entity_id", "=", id)
        .executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0) > 0;
    },
  };
}

/** The row a record answers with, when an older workspace still holds more
 *  than one for it: a picture waiting for an answer, then one being looked
 *  for, then none found; the newest of a kind. Every surface reads the same
 *  one, every time. */
const STANDING: Record<string, number> = { suggested: 0, queued: 1, none: 2 };
export function oneRowPerRecord<T extends { entity_id: string; status: string; updated_at?: Date | string | null }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  const rank = (r: T) => STANDING[r.status] ?? 9;
  const when = (r: T) => (r.updated_at ? new Date(r.updated_at).getTime() : 0);
  for (const r of rows) {
    const cur = best.get(r.entity_id);
    if (!cur || rank(r) < rank(cur) || (rank(r) === rank(cur) && when(r) > when(cur))) best.set(r.entity_id, r);
  }
  return [...best.values()];
}

/** A person pressed Search on a record whose picture was not found: ask
 *  once more, soon. The only door back into the queue for a record the
 *  search already gave up on. */
export async function searchAgain(orgId: string, store: SuggestionStore, kind: string, id: string): Promise<boolean> {
  if (!(await store.requeue(kind, id))) return false;
  nudge(orgId);
  return true;
}

/** Queue, forget or leave one saved record; true when it was queued. */
export async function noteSaved(store: SuggestionStore, e: EntitySavedEvent): Promise<boolean> {
  const decision = queueDecision(e, await store.get(e.kind, e.id));
  if (decision === "leave") return false;
  // Off: nothing new is queued for a search nobody turned on.
  if (decision === "queue" && !(await store.enabled())) return false;
  if (decision === "forget") {
    await store.forget(e.kind, e.id);
    return false;
  }
  await store.queue(e);
  return true;
}

/** Does the record still have no picture? Asked again right before anything
 *  is written, so a picture set meanwhile is never replaced. */
export async function recordHasNoPicture(orgId: string, kind: string, id: string): Promise<boolean | null> {
  const e = await platform().entities.lookup(orgId, kind, id).catch(() => null);
  if (!e) return null; // gone, or not resolvable
  return !(typeof e.image_path === "string" && e.image_path.trim());
}

/** Put a stored picture on the record, through its kind's own writer. False
 *  when the record has a picture now, or its kind cannot be written here. */
export async function putPictureOn(orgId: string, orgSlug: string, kind: string, id: string, fileId: string): Promise<boolean> {
  if ((await recordHasNoPicture(orgId, kind, id)) !== true) return false;
  const writer = await platform().entities.getWriter(orgId, kind);
  if (!writer) return false;
  await writer.update(orgId, id, { image_path: imagePathForFile(orgSlug, fileId) });
  return true;
}

export async function readAutoApply(db: Db): Promise<boolean> {
  const row = await db.selectFrom("core_scan_photo_suggest_config").select("auto_apply").executeTakeFirst().catch(() => undefined);
  return row?.auto_apply === true;
}

export async function readSuggestOn(db: Db): Promise<boolean> {
  const row = await db.selectFrom("core_scan_photo_suggest_config").select("suggest_on").executeTakeFirst().catch(() => undefined);
  return row?.suggest_on === true;
}

export async function writeSuggestOn(db: Db, on: boolean): Promise<void> {
  await db
    .insertInto("core_scan_photo_suggest_config")
    .values({ id: true, suggest_on: on })
    .onConflict((oc) => oc.column("id").doUpdateSet({ suggest_on: on, updated_at: new Date() }))
    .execute();
}

export async function writeAutoApply(db: Db, on: boolean): Promise<void> {
  await db
    .insertInto("core_scan_photo_suggest_config")
    .values({ id: true, auto_apply: on })
    .onConflict((oc) => oc.column("id").doUpdateSet({ auto_apply: on, updated_at: new Date() }))
    .execute();
}

/** The searches, injectable for the test. */
export interface SuggestDeps {
  /** "refused" when the engine turned the ask away: that says nothing about
   *  the record, so it costs the record no try and ends the round. */
  find: (orgId: string, kind: string, id: string) => Promise<{ url: string; query: string } | null | "refused">;
  /** Fetch the picture found, storing nothing: a suggestion holds it. */
  fetch: (url: string) => Promise<FetchedImage | null>;
  /** Write a held picture into Files: only when the workspace asked for the
   *  top match to be applied, or a person said Use it. */
  keep: (orgId: string, image: FetchedImage, url: string, query: string) => Promise<string | null>;
  hasNoPicture: (orgId: string, kind: string, id: string) => Promise<boolean | null>;
  apply: (orgId: string, orgSlug: string, kind: string, id: string, fileId: string) => Promise<boolean>;
  /** The records that already exist without a picture, for the one backfill. */
  existingWithoutPicture?: (orgId: string, limit: number) => Promise<Array<{ kind: string; id: string; title: string }>>;
}

/** What a record is called and how to search for it, and the search: real by
 *  default, a fixture in the test. */
export interface FindSeams {
  describe: typeof derivedQueryFor;
  search: typeof pictureOptions;
  /** The hand-picked catalog (a known printer's own photo), asked first. */
  curated?: typeof curatedImageUrl;
}

/** The picture to suggest for one record: the best-ranked one that shows it,
 *  never simply the first one back. A banner sharing the maker's name with
 *  the record is not a picture of it. */
export async function findPictureFor(
  orgId: string,
  kind: string,
  id: string,
  seams: FindSeams = { describe: derivedQueryFor, search: pictureOptions, curated: curatedImageUrl },
): Promise<{ url: string; query: string } | null | "refused"> {
  const { query, name, brand } = await seams.describe(orgId, kind, id);
  if (!query) return null;
  const curated = await seams.curated?.(query);
  if (curated) return { url: curated, query };
  const { items, throttled } = await seams.search({ query, brand, limit: 8 });
  if (!items.length && throttled) return "refused";
  const url = pickPhotoOf(items, { name: name ?? query, brand })?.url ?? null;
  return url ? { url, query } : null;
}

const REAL: SuggestDeps = {
  find: (orgId, kind, id) => findPictureFor(orgId, kind, id),
  fetch: async (url) => (await fetchImage(url)).image,
  keep: (orgId, image, url, query) => storeFetchedImage(orgId, image, { kind: "web", original_url: url, query, at: new Date().toISOString() }),
  hasNoPicture: recordHasNoPicture,
  apply: putPictureOn,
  existingWithoutPicture: async (orgId, limit) => {
    const out: Array<{ kind: string; id: string; title: string }> = [];
    for (const k of await scanTargetsForOrg(orgId).catch(() => [])) {
      if (out.length >= limit) break;
      const page = await platform().entities.list(orgId, k.kind, { limit: Math.min(200, limit - out.length) }).catch(() => null);
      for (const e of page?.items ?? []) {
        const img = (e as { image_path?: unknown }).image_path;
        if (typeof img === "string" && img.trim()) continue;
        if (!e.title?.trim()) continue;
        out.push({ kind: e.kind, id: e.id, title: e.title });
      }
    }
    return out.slice(0, limit);
  },
};

/** The one backfill: every record that already exists without a picture
 *  goes in the queue once, and the rounds work through it a few a minute.
 *  A record the queue already knows (searched, declined, applied) is left
 *  alone. Runs once per workspace. */
export async function backfillExisting(orgId: string, store: SuggestionStore, deps: SuggestDeps = REAL): Promise<number> {
  if (await store.backfilled()) return 0;
  let queued = 0;
  for (const r of (await deps.existingWithoutPicture?.(orgId, BACKFILL_LIMIT)) ?? []) {
    if (await store.queueIfAbsent(r.kind, r.id, r.title.trim())) queued++;
  }
  await store.markBackfilled();
  if (queued) console.log(`[core-scan] org ${orgId}: record pictures: ${queued} existing records without one queued, a few a minute`);
  return queued;
}

/** One round for one workspace: look at the oldest queued records, up to
 *  PER_ROUND. Answers whether more are waiting. */
export async function suggestRound(orgId: string, orgSlug: string, store: SuggestionStore, deps: SuggestDeps = REAL): Promise<boolean> {
  // Off: no backfill, no search, nothing written (#7447).
  if (!(await store.enabled())) return false;
  await backfillExisting(orgId, store, deps).catch((err) =>
    console.error(`[core-scan] org ${orgId}: queueing existing records for pictures failed:`, (err as Error).message),
  );
  const queued = await store.queued(PER_ROUND + 1);
  const autoApply = queued.length ? await store.autoApply() : false;
  const tally = { suggested: 0, applied: 0, none: 0, again: 0, gone: 0, refused: false };
  for (const q of queued.slice(0, PER_ROUND)) {
    const tried = q.attempts + 1;
    const giveUp = tried >= MAX_ATTEMPTS;
    try {
      const none = await deps.hasNoPicture(orgId, q.entity_kind, q.entity_id);
      if (none !== true) {
        // It has a picture now, or it is gone: nothing to suggest.
        await store.forget(q.entity_kind, q.entity_id);
        tally.gone++;
        continue;
      }
      const found = await deps.find(orgId, q.entity_kind, q.entity_id);
      if (found === "refused") {
        // The engine said no to US; ask again next round, and ask nothing
        // more now, since the rest of the round would be the burst again.
        tally.refused = true;
        break;
      }
      const image = found ? await deps.fetch(found.url) : null;
      if (!found || !image) {
        await store.settle(q.entity_kind, q.entity_id, { attempts: tried, status: giveUp ? "none" : "queued", ...(found ? { query: found.query } : {}) });
        if (giveUp) tally.none++;
        else tally.again++;
        continue;
      }
      // Held, not filed: only a workspace that asked for the top match to be
      // applied gets a file now, and only when it lands on the record.
      const fileId = autoApply ? await deps.keep(orgId, image, found.url, found.query) : null;
      const applied = !!fileId && (await deps.apply(orgId, orgSlug, q.entity_kind, q.entity_id, fileId));
      await store.settle(
        q.entity_kind,
        q.entity_id,
        applied ? { status: "applied", file_id: fileId!, source_url: found.url, query: found.query } : { status: "suggested", held: image, source_url: found.url, query: found.query },
      );
      if (applied) tally.applied++;
      else tally.suggested++;
    } catch (err) {
      platform().health.notePassFailure("core-scan.record-photos", orgId, err);
      console.error(`[core-scan] org ${orgId}: suggesting a picture for ${q.entity_kind}/${q.entity_id} failed:`, (err as Error).message);
      await store.settle(q.entity_kind, q.entity_id, { attempts: tried, status: giveUp ? "none" : "queued" }).catch(() => undefined);
    }
  }
  if (queued.length) {
    console.log(
      `[core-scan] org ${orgId}: record pictures: ${tally.suggested} suggested, ${tally.applied} applied, ${tally.none} with none, ${tally.again} to ask again, ${tally.gone} no longer need one${tally.refused ? "; the picture search refused, round ended" : ""}`,
    );
  }
  return queued.length > PER_ROUND || tally.refused;
}

/** What a workspace gets the moment core-scan is enabled: its existing
 *  records without a picture queued, and the backfill marked done. Queues
 *  only; the rounds do the searching, so an enable never waits on the web.
 *  Answers how many were queued. */
export async function photosOnEnable(orgId: string, store: SuggestionStore, deps: SuggestDeps = REAL): Promise<number> {
  // Off for every workspace until it turns suggestions on (#7447): enabling
  // the module queues nothing, and the workspace is born with its settings
  // row (off), the same as one that existed before.
  await store.ensureConfig();
  if (!(await store.enabled())) return 0;
  return backfillExisting(orgId, store, deps);
}

/** The kernel's walk. Registered once at boot. */
export function registerRecordPhotoSweep(): void {
  platform().sweeps.register({
    name: RECORD_PHOTO_PASS,
    everyMs: IDLE_MS,
    drainMs: ROUND_MS,
    module: "core-scan",
    visit: async ({ orgId, db }) => {
      // The lifetime is kept whether or not suggestions are on: a workspace
      // that turned them off still holds what it was offered (#8941).
      const held = await keepHeldWithinLifetime(db as Db).catch((err) => {
        platform().health.notePassFailure("core-scan.held-picture-lifetime", orgId, err);
        console.error(`[core-scan] org ${orgId}: keeping held suggestion pictures to their lifetime failed:`, (err as Error).message);
        return { dropped: 0, shrunk: 0, savedBytes: 0, more: false };
      });
      if (held.dropped || held.shrunk) {
        console.log(`[core-scan] org ${orgId}: held suggestion pictures: ${held.dropped} past ${HELD_DAYS} days or answered let go, ${held.shrunk} shrunk to a preview (${Math.round(held.savedBytes / 1024)} KB freed)`);
      }
      const slug = (await platform().orgs.get(orgId).catch(() => null))?.slug;
      if (!slug) return { backlog: held.more };
      const more = await suggestRound(orgId, slug, kyselyStore(db as Db));
      return { backlog: more || held.more };
    },
    // The backfill, at enable: a workspace enabled with records queues them
    // at once (the rounds then search a few a minute), and a new one is born
    // with the "done" marker instead of waiting a round for it (#4091).
    onEnable: async ({ orgId, db }) => {
      if (await photosOnEnable(orgId, kyselyStore(db as Db))) nudge(orgId);
    },
  });
}
