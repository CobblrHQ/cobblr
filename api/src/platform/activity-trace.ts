// Every change leaves its trace. A record lives in its workspace's database
// and its History line in the server's, so the line is a second write, made
// after the first has committed: a refused connection to the server's
// database, or the api dying between the two, used to lose it for good while
// the change stood (#7921, the risk behind #8807).
//
// Two things close that, both kept in the workspace's own database (tables
// owned by core-activity-log, migrations/0001_trace_outbox.sql):
//   - a line the server's database refuses is kept there instead, and sent
//     by a round once it answers (`keepLine`);
//   - a change made through a record's writer leaves an intent there before
//     it writes, removed once its line has landed. One left behind (the api
//     died) is found by a round, which reads the record and writes the line
//     from what it was to what it now is (`beginIntent` / `endIntent`).
// Either line carries a trace id, unique in activity_log, so a line sent
// twice (a round that ran after the first send but before its delete) lands
// once.
//
// The round opens only workspaces worth opening, asked of the server's
// database in one read: a writer marks its workspace in activity_trace_marks
// (at most once a minute per process) before it leaves an intent, and a
// round opens a workspace only when its mark is newer than what a visit last
// covered, plus the ones this process kept a line for. An idle workspace is
// never opened, at boot or after (#9013).
import { randomUUID } from "node:crypto";
import { sql, type Generated, type Kysely, type Selectable } from "kysely";
import { isPlatformSet, platform } from "@cobblr/platform-contract";
import type { AuthMethod, MetaDB } from "../db/schema.js";
import { omitSecretValues, secretHistoryDiff } from "@cobblr/platform-contract/secret-field";
import { currentActor, currentVia } from "../lib/request-context.js";
import { historyBag, historyDiff } from "./record-history.js";

export const TRACE_PASS = "core-activity-log.traces";
/** An intent older than this belongs to a write that is long over: a live
 *  write writes its line within a request. */
export const INTENT_STALE_MS = 2 * 60 * 1000;
const PAGE = 200;

/** One activity_log row, as it is inserted. */
export interface ActivityLine {
  org_id: string;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown;
  auth_method: string;
  api_token_id: string | null;
  via_kind: string | null;
  via_label: string | null;
  trace_id: string | null;
  /** Null: the database's clock, now. A kept line carries the time it was
   *  made, so it lands where it happened. */
  occurred_at: string | null;
}

interface TraceDB {
  core_activity_log_pending: { id: string; line: unknown; created_at: Generated<Date>; attempts: Generated<number>; last_error: string | null };
  core_activity_log_intents: { id: string; kind: string; entity_id: string; before: unknown; who: unknown; force_log: Generated<boolean>; created_at: Generated<Date> };
}
interface Who { user_id: string | null; auth_method: string; api_token_id: string | null; via_kind: string | null; via_label: string | null }

/** The workspace's database; null on a platform with no workspaces (a unit
 *  test's), where there is nowhere to keep anything. */
const tdb = async (orgId: string): Promise<Kysely<TraceDB> | null> => {
  const tenants = isPlatformSet() ? platform().tenants : undefined;
  return tenants ? ((await tenants.getDb(orgId)) as Kysely<TraceDB>) : null;
};
const metaDb = async () => (await import("../db/meta.js")).meta;

/** How often one process marks a workspace it writes in. A mark stands for
 *  every intent left until a minute after it. */
export const MARK_EVERY_MS = 60_000;
/** A marked workspace that never goes quiet is still looked at this often. */
export const BUSY_RECHECK_MS = 60 * 60_000;

/** Workspaces this process kept a line or left an intent for. */
const waiting = new Set<string>();
/** When this process last marked each workspace. */
const marked = new Map<string, number>();
/** The marks the last round's candidates read, for its visits to cover. */
const due = new Map<string, TraceMark>();

export interface TraceMark { touched_at: Date; covered_at: Date | null; visited_at: Date | null }

/** Whether a round opens this workspace: marked since a visit last covered
 *  it, and either quiet long enough that every intent the mark stands for is
 *  stale, or not looked at for an hour (one that never goes quiet). */
export function traceDue(m: TraceMark, now: number): boolean {
  const touched = m.touched_at.getTime();
  if (m.covered_at && m.covered_at.getTime() >= touched) return false;
  if (now - touched >= MARK_EVERY_MS + INTENT_STALE_MS) return true;
  return now - (m.visited_at?.getTime() ?? touched) >= BUSY_RECHECK_MS;
}

/** Whether a visit covered its mark: nothing was left, and every intent the
 *  mark stands for was old enough to be read. */
export function traceCovered(m: TraceMark, now: number, nothingLeft: boolean): boolean {
  return nothingLeft && now - m.touched_at.getTime() >= MARK_EVERY_MS + INTENT_STALE_MS;
}

async function markTouched(orgId: string): Promise<void> {
  const last = marked.get(orgId);
  if (last !== undefined && Date.now() - last < MARK_EVERY_MS) return;
  // To the millisecond, as a JS date holds it: a visit covers the mark it
  // read by writing that same value back.
  const now = sql<Date>`date_trunc('milliseconds', now())`;
  await (await metaDb()).insertInto("activity_trace_marks").values({ org_id: orgId, touched_at: now })
    .onConflict((oc) => oc.column("org_id").doUpdateSet({ touched_at: now })).execute();
  marked.set(orgId, Date.now());
}

const noted = (orgId: string) => {
  waiting.add(orgId);
  try {
    platform().sweeps.soon(TRACE_PASS, orgId);
  } catch {
    // no sweeps yet (a unit test, or before boot registered them): the
    // first round after boot visits every workspace
  }
};

/** The table is not there yet: a workspace whose core-activity-log
 *  migrations have not run (the boot that runs them is still under way). */
const missingTable = (err: unknown) => (err as { code?: string })?.code === "42P01";

/** Insert one line, once: a line with a trace id already in the log is
 *  the same line sent again. */
export async function insertLine(line: ActivityLine, db?: Kysely<MetaDB>): Promise<void> {
  const into = (db ?? (await metaDb())).insertInto("activity_log").values({
    org_id: line.org_id,
    user_id: line.user_id,
    module_name: line.module_name,
    action: line.action,
    entity_type: line.entity_type,
    entity_id: line.entity_id,
    diff: line.diff === null || line.diff === undefined ? null : (line.diff as object),
    auth_method: line.auth_method as AuthMethod,
    api_token_id: line.api_token_id,
    via_kind: line.via_kind,
    via_label: line.via_label,
    ...(line.trace_id ? { trace_id: line.trace_id } : {}),
    ...(line.occurred_at ? { occurred_at: new Date(line.occurred_at) } : {}),
  });
  await (line.trace_id ? into.onConflict((oc) => oc.column("trace_id").where("trace_id", "is not", null).doNothing()) : into).execute();
}

/** A line the server's database refused, kept in the workspace's own until a
 *  round sends it. False when the workspace's database would not take it
 *  either, and the caller's error stands. */
export async function keepLine(line: ActivityLine, refused: unknown): Promise<boolean> {
  const id = line.trace_id ?? randomUUID();
  try {
    const db = await tdb(line.org_id);
    if (!db) return false;
    await db.insertInto("core_activity_log_pending").values({ id, line: JSON.stringify({ ...line, trace_id: id, occurred_at: line.occurred_at ?? new Date().toISOString() }), last_error: String(refused).slice(0, 300) }).execute();
  } catch (err) {
    console.error(`[activity] a History line for ${line.org_id} could not be kept in the workspace either:`, err);
    return false;
  }
  console.error(`[activity] the server's database refused a History line for ${line.org_id}; kept in the workspace until it answers:`, refused);
  noted(line.org_id);
  return true;
}

/** Before a change through a record's writer: what the record was, and who
 *  is changing it, so its line can be written even if this process never
 *  gets to. Null when the workspace has no table for it yet. */
export async function beginIntent(orgId: string, kind: string, entityId: string, before: Record<string, unknown>, forceLog: boolean): Promise<string | null> {
  const actor = currentActor();
  const via = currentVia();
  const who: Who = { user_id: actor?.userId ?? null, auth_method: actor ? actor.authMethod : "system", api_token_id: actor?.apiTokenId ?? null, via_kind: via?.kind ?? null, via_label: via?.label ?? null };
  const id = randomUUID();
  const db = await tdb(orgId);
  if (!db) return null;
  // The mark first: an intent nobody can find is no better than none. A
  // server database that will not take the mark is remembered here, and
  // marked again each round until it does.
  await markTouched(orgId).catch((err) => {
    console.error(`[activity] could not mark ${orgId} for its History intents:`, err);
    noted(orgId);
  });
  try {
    await db.insertInto("core_activity_log_intents").values({ id, kind, entity_id: entityId, before: JSON.stringify(omitSecretValues(before)), who: JSON.stringify(who), force_log: forceLog }).execute();
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
  return id;
}

/** Its line has landed, or there was nothing to write. */
export async function endIntent(orgId: string, id: string): Promise<void> {
  try {
    await (await tdb(orgId))?.deleteFrom("core_activity_log_intents").where("id", "=", id).execute();
  } catch (err) {
    // The line is in the log under this id; a round that finds the intent
    // writes it again under the same id, which lands nothing.
    console.error(`[activity] an intent in ${orgId} outlived its line:`, err);
    noted(orgId);
  }
}

/** The write threw part-way: whether it changed the record is for a round
 *  to read, once the intent is old enough. */
export const leaveIntent = (orgId: string): void => noted(orgId);

/** Mark a workspace a line may be left in: before a change whose line is
 *  kept beside it (activity-outbox.ts), as before an intent. */
export async function markForTrace(orgId: string): Promise<void> {
  await markTouched(orgId).catch((err) => {
    console.error(`[activity] could not mark ${orgId} for its History lines:`, err);
    noted(orgId);
  });
}

/** A kept line was not sent: a round sends it. */
export const lineWaiting = (orgId: string): void => noted(orgId);

async function recoverIntent(orgId: string, i: Selectable<TraceDB["core_activity_log_intents"]>): Promise<boolean> {
  const w = await platform().entities.getWriter(orgId, i.kind).catch(() => null);
  const read = w?.snapshot?.bind(w) ?? w?.read?.bind(w);
  const now = read ? await read(orgId, i.entity_id) : null;
  if (!now) return false;
  const before = historyBag(typeof i.before === "string" ? JSON.parse(i.before) : i.before);
  const diff = historyDiff(before, omitSecretValues(now) as Record<string, unknown>);
  if (!(diff.changes as unknown[]).length && !i.force_log) return false;
  const who = (typeof i.who === "string" ? JSON.parse(i.who) : i.who) as Who;
  const [module, entityType] = i.kind.split(":");
  await insertLine({
    org_id: orgId,
    user_id: who.user_id,
    module_name: module ?? null,
    action: `${entityType ?? i.kind}_updated`,
    entity_type: entityType ?? i.kind,
    entity_id: i.entity_id,
    diff: secretHistoryDiff(diff),
    auth_method: who.auth_method,
    api_token_id: who.api_token_id,
    via_kind: who.via_kind,
    via_label: who.via_label,
    trace_id: i.id,
    occurred_at: new Date(i.created_at).toISOString(),
  });
  return true;
}

/** One workspace's round: send its kept lines, then write the line of every
 *  intent its write left behind. */
export async function sendTraces(orgId: string, db: Kysely<TraceDB>, now: Date): Promise<{ sent: number; recovered: number; backlog: boolean; left: boolean }> {
  const kept = await db.selectFrom("core_activity_log_pending").selectAll().orderBy("created_at").limit(PAGE).execute();
  let sent = 0;
  for (const k of kept) {
    const line = (typeof k.line === "string" ? JSON.parse(k.line) : k.line) as ActivityLine;
    try {
      await insertLine({ ...line, trace_id: k.id });
    } catch (err) {
      await db.updateTable("core_activity_log_pending").set({ attempts: sql`attempts + 1`, last_error: String(err).slice(0, 300) }).where("id", "=", k.id).execute();
      throw err;
    }
    await db.deleteFrom("core_activity_log_pending").where("id", "=", k.id).execute();
    sent++;
  }
  const left = await db.selectFrom("core_activity_log_intents").selectAll().where("created_at", "<", new Date(now.getTime() - INTENT_STALE_MS)).orderBy("created_at").limit(PAGE).execute();
  let recovered = 0;
  for (const i of left) {
    if (await recoverIntent(orgId, i)) recovered++;
    await db.deleteFrom("core_activity_log_intents").where("id", "=", i.id).execute();
  }
  const { rows } = await sql<{ more: boolean }>`select (exists (select 1 from core_activity_log_pending) or exists (select 1 from core_activity_log_intents)) as more`.execute(db);
  if (!rows[0]?.more) waiting.delete(orgId);
  return { sent, recovered, backlog: kept.length === PAGE || left.length === PAGE, left: !!rows[0]?.more };
}

export function registerTraceSweep(): void {
  platform().sweeps.register({
    name: TRACE_PASS,
    everyMs: 60_000,
    drainMs: 60_000,
    candidates: async (orgIds, { named }) => {
      if (named) return orgIds;
      // A workspace whose mark the server's database would not take: mark it now.
      for (const o of waiting) if (!marked.has(o)) await markTouched(o).catch(() => undefined);
      const scope = new Set(orgIds);
      const marks = await (await metaDb()).selectFrom("activity_trace_marks").selectAll()
        .where((eb) => eb.or([eb("covered_at", "is", null), eb("covered_at", "<", eb.ref("touched_at"))]))
        .execute();
      due.clear();
      const now = Date.now();
      for (const m of marks) if (scope.has(m.org_id) && traceDue(m, now)) due.set(m.org_id, m);
      return orgIds.filter((o) => waiting.has(o) || due.has(o));
    },
    visit: async ({ orgId, db, now }) => {
      const mark = due.get(orgId);
      due.delete(orgId);
      let result: Awaited<ReturnType<typeof sendTraces>>;
      try {
        result = await sendTraces(orgId, db as Kysely<TraceDB>, now);
      } catch (err) {
        if (!missingTable(err)) throw err;
        result = { sent: 0, recovered: 0, backlog: false, left: false };
      }
      if (mark) {
        await (await metaDb()).updateTable("activity_trace_marks")
          .set({ visited_at: now, ...(traceCovered(mark, now.getTime(), !result.left) ? { covered_at: mark.touched_at } : {}) })
          .where("org_id", "=", orgId).execute();
      }
      return result;
    },
  });
}

// ── Test doors (mounted only with COBBLR_TEST_ORG_POOL) ─────────────────

type Fault = "refuse" | "die";
/** Which line a `die` is for: a test's own, never another line written in
 *  the same workspace a moment earlier (an after-commit handler of the test
 *  before it took a die meant for this one, #9052). */
export interface FaultMatch { action?: string; entityId?: string }
const faults = new Map<string, { fault: Fault; match: FaultMatch }>();
/** `refuse`: the server's database refuses this workspace's History lines
 *  until cleared. `die`: the next line `match` names is lost the way a
 *  process dying after the change would lose it, once. */
export function setTraceFaultForTests(orgId: string, fault: Fault | null, match: FaultMatch = {}): { dieLeft: boolean } {
  // Whether a die was still waiting, so a test can tell its own line took it
  // without reading History, which a background round may have filled by
  // then (#9052).
  const dieLeft = faults.get(orgId)?.fault === "die";
  if (fault) faults.set(orgId, { fault, match });
  else faults.delete(orgId);
  return { dieLeft };
}
export function metaRefusedForTests(orgId: string): boolean {
  return faults.get(orgId)?.fault === "refuse";
}
export function diesHereForTests(orgId: string, line: { action: string; entityId: string }): boolean {
  const f = faults.get(orgId);
  if (f?.fault !== "die") return false;
  if (f.match.action && f.match.action !== line.action) return false;
  if (f.match.entityId && f.match.entityId !== line.entityId) return false;
  faults.delete(orgId);
  return true;
}
