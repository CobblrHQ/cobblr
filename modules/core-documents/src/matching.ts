// Matching library items (documents, games, any library's) to records, in
// the background, so a record opens with its items already there (the owner, 2026-10-01: "it should come through
// automatically and immediately pretty much").
//
// Four ways a match is made, none of them on a page view:
//   1. A library is connected: every record is queued once, and the
//      sweep asks the system about a few of them a minute (gentle on a home
//      server behind a bridge).
//   2. A new item arrives: the library's webhook rings the doorbell, the
//      item is read once and scored against every record's stored facts
//      here, with no question per record.
//   3. A record is made or its name, serial or model changes: it is queued
//      at once and nudged.
//   4. Once a day, each system is asked what was added since the last look,
//      for anyone who skipped the webhook.
//
// What is found is a SUGGESTION. A suggestion found through a shared
// connection is the workspace's; one found through a person's own connection
// is theirs alone, because the workspace never agreed to see that person's
// documents.
//
// BORN WITH: the sweep's onEnable (backfillRecords), so a workspace enabled
// with records has them queued at once.

import { sql, type Kysely } from "kysely";
import { platform, SYSTEM_VIEWER } from "@cobblr/platform-contract";
import { ENTITY_SAVED_EVENT, type EntitySavedEvent } from "@cobblr/platform-contract/entity-saved";
import type { ServiceConnectionHolder } from "@cobblr/platform-contract/services";
import {
  LIBRARY_FIND,
  LIBRARY_GET,
  SUGGEST_AT,
  factsKey,
  recordFactsOf,
  scoreItemMatch,
  type LibraryItem,
  type LibraryFindInput,
  type LibraryFindOutput,
  type LibraryGetOutput,
  type LibraryPushSetup,
  type RecordFacts,
} from "@cobblr/platform-contract/library";
import type { CoreDocumentsDB } from "./db.js";

export type Db = Kysely<CoreDocumentsDB>;

export const MATCH_PASS = "core-documents.match";
/** Records asked about per workspace per round, across its systems. */
export const PER_ROUND = 5;
export const ROUND_MS = 60_000;
export const IDLE_MS = 10 * 60_000;
/** The daily look at what was added since the last one. */
export const CATCH_UP_EVERY_MS = 24 * 3600_000;
/** Pages of a day's additions read per library per catch-up. */
export const CATCH_UP_MAX_PAGES = 20;
/** Existing records queued by the one backfill. */
export const BACKFILL_LIMIT = 3000;
/** Tries a record gets while a system will not answer, before it waits for
 *  the daily round. */
const MAX_ATTEMPTS = 3;

/** Kinds whose records are not things a library item is about. */
function matchable(kind: string): boolean {
  return !kind.startsWith("core-documents:") && !kind.startsWith("core-scan:") && !kind.startsWith("core-ai:");
}

// ── Asking a library ────────────────────────────────────────────

/** The libraries that can find items here, and whose each is. */
export async function holdersOf(orgId: string): Promise<ServiceConnectionHolder[]> {
  return platform().services.connectionsFor(orgId, LIBRARY_FIND).catch(() => []);
}

/** A reading on one connection: the answer, or why there is none. */
export async function readOn<T>(orgId: string, credentialId: string, capability: string, input: unknown): Promise<T> {
  const ref = await platform().services.invoke({ orgId, capability, input, via: { credentialId } });
  const job = await platform().services.job(orgId, ref.id);
  if (!job) throw new Error("the reading went missing");
  if (job.status !== "done") throw new Error(job.error?.message ?? `the reading is ${job.status}`);
  return job.output as T;
}

export function findOn(orgId: string, credentialId: string, input: LibraryFindInput): Promise<LibraryItem[]> {
  return findPage(orgId, credentialId, input).then((o) => o.items);
}

/** One page of a find, and the cursor to the next when there is one. */
export async function findPage(orgId: string, credentialId: string, input: LibraryFindInput): Promise<{ items: LibraryItem[]; next: string | null }> {
  const o = await readOn<LibraryFindOutput>(orgId, credentialId, LIBRARY_FIND, input);
  return { items: o.items ?? [], next: typeof o.next === "string" && o.next ? o.next : null };
}

export function getOn(orgId: string, credentialId: string, ref: string, include: "thumb" | "none" = "none"): Promise<LibraryGetOutput> {
  return readOn<LibraryGetOutput>(orgId, credentialId, LIBRARY_GET, { ref, include });
}

// ── A record's facts ────────────────────────────────────────────────────

/** What a record says about itself now, or null when it is gone. */
export async function readFacts(orgId: string, kind: string, id: string): Promise<RecordFacts | null> {
  // SYSTEM-READ: matching reads a record's codes and short fields to find its library items, whoever can see those fields; nothing read here is shown, only the items it finds
  const e = await platform().entities.lookup(orgId, kind, id, SYSTEM_VIEWER).catch(() => null);
  if (!e || !e.title?.trim()) return null;
  const roled = await platform().entities.roledFieldsFor(orgId, kind).catch(() => []);
  return recordFactsOf({ title: e.title, fields: e.fields ?? {} }, roled);
}

/** Queue a record when its facts are new or changed; true when queued. */
export async function noteFacts(db: Db, kind: string, id: string, facts: RecordFacts, opts: { backlog?: boolean } = {}): Promise<boolean> {
  const key = factsKey(facts);
  const known = await db.selectFrom("core_documents_records").select(["facts_key"]).where("record_id", "=", id).executeTakeFirst();
  if (known && known.facts_key === key) return false;
  const row = {
    record_kind: kind,
    record_id: id,
    facts: JSON.stringify(facts),
    facts_key: key,
    status: "queued" as const,
    attempts: 0,
    // A backlog waits behind the record someone just made or edited.
    updated_at: opts.backlog ? new Date(0) : new Date(),
  };
  await db
    .insertInto("core_documents_records")
    .values(row)
    .onConflict((oc) => oc.column("record_id").doUpdateSet({ ...row, updated_at: new Date() }))
    .execute();
  return true;
}

// ── Storing what was found ──────────────────────────────────────────────

/** Keep a suggestion, unless the item is linked to that record already
 *  or the person said no to it. */
export async function suggest(db: Db, row: { kind: string; id: string }, holder: ServiceConnectionHolder, doc: LibraryItem, score: number, because: string | null): Promise<void> {
  const linked = await db
    .selectFrom("core_documents_linked")
    .select("ref")
    .where("record_id", "=", row.id)
    .where("connection_id", "=", holder.credentialId)
    .where("ref", "=", doc.ref)
    .executeTakeFirst();
  if (linked) return;
  const forUser = holder.shared ? null : holder.ownerUserId;
  await sql`
    insert into core_documents_suggestions
      (record_kind, record_id, connection_id, ref, title, created, tags, open_url, has_thumb, score, because, for_user_id,
       item_type, item_type_label, subtitle, open_label)
    values
      (${row.kind}, ${row.id}, ${holder.credentialId}, ${doc.ref}, ${doc.title}, ${doc.created ?? null}, ${JSON.stringify(doc.tags ?? [])}::jsonb,
       ${doc.open_url ?? null}, ${doc.has_thumb === true}, ${score}, ${because}, ${forUser},
       ${doc.type}, ${doc.type_label}, ${doc.subtitle ?? null}, ${doc.open_label ?? null})
    on conflict (record_id, connection_id, ref, coalesce(for_user_id::text, ''))
    do update set title = excluded.title, created = excluded.created, tags = excluded.tags, open_url = excluded.open_url,
      has_thumb = excluded.has_thumb, score = greatest(core_documents_suggestions.score, excluded.score), because = excluded.because,
      item_type = excluded.item_type, item_type_label = excluded.item_type_label, subtitle = excluded.subtitle, open_label = excluded.open_label
  `.execute(db);
}

/** Match one record on one library: ask for items that look like it,
 *  keep the ones the rule agrees are about it, and drop the ones from that
 *  system it no longer finds (a renamed record's old matches). */
export async function matchRecordOn(orgId: string, db: Db, row: { kind: string; id: string; facts: RecordFacts }, holder: ServiceConnectionHolder): Promise<number> {
  const found = await findOn(orgId, holder.credentialId, { facts: row.facts, limit: 15 });
  // A search asks by name, and an item known by an outside id alone (a ROM
  // titled differently from the cartridge) is never in its answer. The ids
  // this library's items carry were remembered as they were read; the items
  // whose id this record holds are read back and scored by the same rule.
  await rememberItemIds(db, holder, found);
  const byId = await itemsByOutsideId(orgId, db, holder, row.facts, new Set(found.map((d) => d.ref)));
  const docs = [...found, ...byId];
  const kept: string[] = [];
  for (const doc of docs) {
    const { score, because } = scoreItemMatch(row.facts, doc);
    if (score < SUGGEST_AT) continue;
    await suggest(db, row, holder, doc, score, because);
    kept.push(doc.ref);
  }
  let stale = db
    .deleteFrom("core_documents_suggestions")
    .where("record_id", "=", row.id)
    .where("connection_id", "=", holder.credentialId)
    .where("dismissed_at", "is", null);
  if (kept.length) stale = stale.where("ref", "not in", kept);
  await stale.execute();
  return kept.length;
}

/** Score items a library named (a new one, the day's additions) against
 *  every record's stored facts, here, with no question per record. */
/** The most items one record reads back by outside id per library. */
const BY_ID_LIMIT = 5;

/** Keep the outside ids of items a library handed over, so a record that
 *  holds one later still finds its item. */
export async function rememberItemIds(db: Db, holder: ServiceConnectionHolder, docs: LibraryItem[]): Promise<void> {
  const rows = docs.flatMap((d) =>
    Object.entries(d.ids ?? {})
      .map(([catalogue, id]) => ({ connection_id: holder.credentialId, catalogue, outside_id: String(id).trim().toLowerCase(), ref: d.ref, seen_at: new Date() }))
      .filter((r) => r.outside_id),
  );
  if (!rows.length) return;
  await db
    .insertInto("core_documents_item_ids")
    .values(rows)
    .onConflict((oc) => oc.columns(["connection_id", "catalogue", "outside_id", "ref"]).doUpdateSet({ seen_at: new Date() }))
    .execute();
}

/** Items of this library whose remembered outside id is a value this record
 *  holds, read back whole. Whether the field that holds it is named after
 *  that catalogue is scoreItemMatch's call, as for every other item. */
async function itemsByOutsideId(orgId: string, db: Db, holder: ServiceConnectionHolder, facts: RecordFacts, skip: Set<string>): Promise<LibraryItem[]> {
  const values = [...new Set(Object.values(facts.fields ?? {}).map((v) => String(v).trim().toLowerCase()).filter((v) => v && v.length <= 80))];
  if (!values.length) return [];
  const hits = await db
    .selectFrom("core_documents_item_ids")
    .select("ref")
    .distinct()
    .where("connection_id", "=", holder.credentialId)
    .where("outside_id", "in", values)
    .limit(BY_ID_LIMIT + skip.size)
    .execute();
  const out: LibraryItem[] = [];
  for (const { ref } of hits) {
    if (skip.has(ref) || out.length >= BY_ID_LIMIT) continue;
    const got = await getOn(orgId, holder.credentialId, ref);
    if (got?.item) out.push(got.item);
  }
  return out;
}

export async function matchItems(db: Db, holder: ServiceConnectionHolder, docs: LibraryItem[]): Promise<number> {
  if (!docs.length) return 0;
  await rememberItemIds(db, holder, docs);
  const records = await db.selectFrom("core_documents_records").select(["record_kind", "record_id", "facts"]).execute();
  let made = 0;
  for (const doc of docs) {
    for (const r of records) {
      const facts = (typeof r.facts === "string" ? JSON.parse(r.facts) : r.facts) as RecordFacts;
      const { score, because } = scoreItemMatch(facts, doc);
      if (score < SUGGEST_AT) continue;
      await suggest(db, { kind: r.record_kind, id: r.record_id }, holder, doc, score, because);
      made++;
    }
  }
  return made;
}

// ── The one backfill ────────────────────────────────────────────────────

/** Every record that exists is queued once, a few matched a minute after. */
export async function backfillRecords(orgId: string, db: Db): Promise<number> {
  const state = await db.selectFrom("core_documents_state").select("backfilled_at").executeTakeFirst();
  if (state?.backfilled_at) return 0;
  let queued = 0;
  // A read that fails is a failed backfill, not an empty workspace: it
  // throws, the round fails and the next one tries again. Read as "nothing
  // here" it stamped the backfill done with nothing queued, for good.
  const kinds = await platform().entities.listKindsForOrg(orgId);
  for (const k of kinds) {
    if (queued >= BACKFILL_LIMIT || !matchable(k.id)) continue;
    if (!(await platform().entities.listable(orgId, k.id))) continue;
    const roled = await platform().entities.roledFieldsFor(orgId, k.id);
    // SYSTEM-READ: the backfill reads every record's facts to match library items, as the record-save path does; nothing read here is shown
    const page = await platform()
      .entities.listAll(orgId, k.id, {}, SYSTEM_VIEWER, { cap: BACKFILL_LIMIT - queued });
    for (const e of page?.items ?? []) {
      if (!e.title?.trim()) continue;
      const known = await db.selectFrom("core_documents_records").select("record_id").where("record_id", "=", e.id).executeTakeFirst();
      if (known) continue;
      if (await noteFacts(db, e.kind ?? k.id, e.id, recordFactsOf({ title: e.title, fields: e.fields ?? {} }, roled), { backlog: true })) queued++;
    }
  }
  await db
    .insertInto("core_documents_state")
    .values({ id: true, backfilled_at: new Date() })
    .onConflict((oc) => oc.column("id").doUpdateSet({ backfilled_at: new Date() }))
    .execute();
  if (queued) console.log(`[core-documents] org ${orgId}: ${queued} existing records queued to be matched with library items`);
  return queued;
}

// ── One round ───────────────────────────────────────────────────────────

/** One round for one workspace. Answers whether more is waiting. */
export async function matchRound(orgId: string, db: Db, now = new Date(), holders?: ServiceConnectionHolder[]): Promise<boolean> {
  const systems = holders ?? (await holdersOf(orgId));
  if (!systems.length) return false;
  await backfillRecords(orgId, db);

  // A library seen for the first time matches every record once: the
  // connect-time pass, which asks the library about each record. And its
  // first catch-up reads the library's whole collection (up to the page
  // bound) and scores each item against every record here: the only way an
  // item matched by an outside id alone (a ROM whose title is not the
  // cartridge's) is ever found, since a search by name cannot find it.
  for (const h of systems) {
    const seen = await db.selectFrom("core_documents_connections").select("connection_id").where("connection_id", "=", h.credentialId).executeTakeFirst();
    if (seen) continue;
    await db.insertInto("core_documents_connections").values({ connection_id: h.credentialId, caught_up_to: null, caught_up_at: null }).onConflict((oc) => oc.column("connection_id").doNothing()).execute();
    await db.updateTable("core_documents_records").set({ status: "queued", attempts: 0 }).execute();
    console.log(`[core-documents] org ${orgId}: a new library (${h.label}); every record will be matched with it`);
  }

  // The daily catch-up, for a system that sends no webhook.
  for (const h of systems) {
    const c = await db.selectFrom("core_documents_connections").selectAll().where("connection_id", "=", h.credentialId).executeTakeFirst();
    if (c?.caught_up_at && now.getTime() - new Date(c.caught_up_at).getTime() < CATCH_UP_EVERY_MS) continue;
    try {
      const since = (c?.caught_up_to ? new Date(c.caught_up_to) : new Date(0)).toISOString();
      // Every page of what was added, so a busy day is not cut at the first
      // fifty; bounded, so a library that never stops paging cannot hold the
      // round.
      let made = 0;
      let cursor: string | undefined;
      for (let page = 0; page < CATCH_UP_MAX_PAGES; page++) {
        const got = await findPage(orgId, h.credentialId, { since, limit: 50, ...(cursor ? { cursor } : {}) });
        made += await matchItems(db, h, got.items);
        if (!got.next) break;
        cursor = got.next;
      }
      await db.updateTable("core_documents_connections").set({ caught_up_to: now, caught_up_at: now }).where("connection_id", "=", h.credentialId).execute();
      if (made) console.log(`[core-documents] org ${orgId}: ${made} suggestions from items added to ${h.label} since ${since}`);
    } catch (err) {
      console.warn(`[core-documents] org ${orgId}: catching up with ${h.label} failed: ${(err as Error).message}`);
    }
  }

  const queued = await db
    .selectFrom("core_documents_records")
    .select(["record_kind", "record_id", "facts", "attempts"])
    .where("status", "=", "queued")
    .orderBy("updated_at", "desc")
    .limit(PER_ROUND + 1)
    .execute();
  let unreachable = false;
  for (const q of queued.slice(0, PER_ROUND)) {
    const facts = (typeof q.facts === "string" ? JSON.parse(q.facts) : q.facts) as RecordFacts;
    let failed = false;
    let lastError: string | null = null;
    for (const h of systems) {
      try {
        await matchRecordOn(orgId, db, { kind: q.record_kind, id: q.record_id, facts }, h);
      } catch (err) {
        failed = true;
        lastError = `${h.label} didn't answer`;
        console.warn(`[core-documents] org ${orgId}: matching ${q.record_kind}/${q.record_id} on ${h.label} failed: ${(err as Error).message}`);
      }
    }
    const tries = q.attempts + 1;
    await db
      .updateTable("core_documents_records")
      .set(
        failed
          ? { attempts: tries, last_error: lastError, ...(tries >= MAX_ATTEMPTS ? { status: "done" as const } : {}) }
          : { status: "done", attempts: tries, matched_at: new Date(), last_error: null },
      )
      .where("record_id", "=", q.record_id)
      .execute();
    // A system that does not answer is not asked again this round.
    if (failed) {
      unreachable = true;
      break;
    }
  }
  return queued.length > PER_ROUND && !unreachable;
}

// ── Signals ─────────────────────────────────────────────────────────────

const NUDGE_AFTER_MS = 2_000;
const nudges = new Map<string, ReturnType<typeof setTimeout>>();
/** A round soon, coalesced: a burst of saves is one round. */
export function nudge(orgId: string): void {
  if (nudges.has(orgId)) return;
  const t = setTimeout(() => {
    nudges.delete(orgId);
    void Promise.resolve()
      .then(() => platform().sweeps.run(MATCH_PASS, { orgIds: [orgId] }))
      .catch((err) => console.error(`[core-documents] org ${orgId}: a matching round failed:`, (err as Error).message));
  }, NUDGE_AFTER_MS);
  if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
  nudges.set(orgId, t);
}

/** A record made or changed, by any door: matched again when its facts
 *  moved. */
export function subscribeRecordSaves(): void {
  platform().events.on(ENTITY_SAVED_EVENT, "core-documents", async (payload: unknown) => {
    const e = payload as EntitySavedEvent;
    if (!matchable(e.kind)) return;
    setImmediate(() => {
      void (async () => {
        if (!(await holdersOf(e.orgId)).length) return;
        const facts = await readFacts(e.orgId, e.kind, e.id);
        if (!facts) return;
        const db = (await platform().tenants.getDb(e.orgId)) as Db;
        if (await noteFacts(db, e.kind, e.id, facts)) nudge(e.orgId);
      })().catch((err) => console.warn(`[core-documents] org ${e.orgId}: noting a saved record failed: ${(err as Error).message}`));
    });
  });
}

export const DOCUMENT_ADDED_EVENT = "core-documents.document.added";

/** Each library's webhook setup, by its program (the adapter's group). */
const PUSH_SETUPS = new Map<string, LibraryPushSetup>();
export function registerPushSetup(provider: string, setup: LibraryPushSetup): void {
  PUSH_SETUPS.set(provider, setup);
}
export function pushSetupOf(provider: string): LibraryPushSetup | null {
  return PUSH_SETUPS.get(provider) ?? null;
}

/** A new document in a system: read it once and score it here. Which system
 *  rang is not trusted from the push, so each one here is asked for that
 *  ref, and the first that has it answers. */
export function subscribeDocumentAdded(): void {
  platform().events.on(DOCUMENT_ADDED_EVENT, "core-documents", async (payload: unknown) => {
    const p = payload as { orgId?: string; ref?: string };
    if (!p.orgId || !p.ref) return;
    const orgId = p.orgId;
    const ref = p.ref;
    setImmediate(() => {
      void (async () => {
        const db = (await platform().tenants.getDb(orgId)) as Db;
        for (const h of await holdersOf(orgId)) {
          const got = await getOn(orgId, h.credentialId, ref).catch(() => null);
          if (!got?.item) continue;
          const made = await matchItems(db, h, [got.item]);
          if (made) console.log(`[core-documents] org ${orgId}: a new item in ${h.label} matched ${made} record(s)`);
          return;
        }
      })().catch((err) => console.warn(`[core-documents] org ${orgId}: matching a new document failed: ${(err as Error).message}`));
    });
  });
}

/** The ref a push names: Paperless's workflow webhook sends whatever body
 *  its placeholders make, so the document's id is read from the likely
 *  places (an explicit id, or the document's own address). Nothing else in
 *  the push is trusted: the document is read back through the connection. */
export function refFromPush(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["document_id", "doc_id", "id"]) {
    const v = b[k];
    if ((typeof v === "number" || typeof v === "string") && /^\d{1,12}$/.test(String(v).trim())) return String(v).trim();
  }
  for (const k of ["doc_url", "document_url", "url"]) {
    const v = b[k];
    const m = typeof v === "string" ? /\/documents\/(\d{1,12})(?:\/|$)/.exec(v) : null;
    if (m) return m[1]!;
  }
  return null;
}

export function registerDocumentsInbound(): void {
  platform().integrations.registerInboundHandler({
    id: "document-added",
    label: "A new document in your document system (Paperless-ngx workflow webhook)",
    describeWebhookConfig: () => ({}),
    emits: [DOCUMENT_ADDED_EVENT],
    handle: async (req, ctx) => {
      const ref = refFromPush(req.body);
      // A doorbell, not a data channel: a body that names no document is a
      // 400 so a misconfigured workflow finds out; webhooks retry on errors.
      if (!ref) return { status: 400, body: { error: 'expected the new document\'s address, e.g. { "doc_url": "{doc_url}" }' } };
      await ctx.emit(DOCUMENT_ADDED_EVENT, { orgId: ctx.orgId, ref });
      return { status: 202, body: { ok: true } };
    },
  });
}

/** The kernel's walk. Registered once at boot. */
export function registerMatchSweep(): void {
  platform().sweeps.register({
    name: MATCH_PASS,
    everyMs: IDLE_MS,
    drainMs: ROUND_MS,
    module: "core-documents",
    visit: async ({ orgId, db }) => {
      const more = await matchRound(orgId, db as Db);
      return { backlog: more };
    },
    onEnable: async ({ orgId, db }) => {
      if ((await holdersOf(orgId)).length && (await backfillRecords(orgId, db as Db))) nudge(orgId);
    },
  });
}
