// ActivityLog primitive. Every CRUD that matters routes through
// here; modules will call `activity.log(...)` from their handlers.
// Append-only — no updates, no deletes by hand.
//
// Retention (audit F8): the table grows forever by default — fine for a
// personal box, a liability on a public host. Setting
// ACTIVITY_LOG_RETENTION_DAYS enables a probabilistic sweep (~1% of writes
// prune rows past the window; best-effort, never blocks the write) — same
// pattern as product_events. Unset (default) = keep everything.

import { keepActivityReferenceTitles } from "./activity-references.js";
import { currentHistoryWrite, historyDiff, noteCreatedLog } from "./record-history.js";
import { changesOf } from "@cobblr/platform-contract/activity-changes";
import { secretHistoryDiff } from "@cobblr/platform-contract/secret-field";
import { sql, type Kysely } from "kysely";
import type { MetaDB } from "../db/schema.js";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { currentActor, currentVia, runOutsideRequestScope, type Via } from "../lib/request-context.js";
import type { AuthMethod } from "../db/schema.js";

export interface ActivityRef {
  /** Module name, or `null` for platform-level events. */
  module: string | null;
  /** What kind of thing (e.g. "part", "org", "user"). */
  entityType: string;
  /** The ID inside that module's DB — text so any PK type fits. */
  entityId: string;
}

export interface LogParams {
  orgId: string;
  /** Falsy values (null / undefined) → the helper falls back to the
   *  current-request actor in ALS. Pass `null` explicitly to force a
   *  system entry. */
  userId?: string | null;
  action: string;
  ref: ActivityRef;
  diff?: unknown;
  /** The record as it was: with a patch `diff`, the fields that really
   *  changed are stored beside it as `changes` (old → new, custom fields
   *  included; platform-contract activity-changes). */
  before?: unknown;
  /** Override the auth method. Default: pull from request context if
   *  one is set, else 'system'. */
  authMethod?: AuthMethod;
  /** Override the API token id. Default: pull from request context. */
  apiTokenId?: string | null;
  /** How the write was made (MCP, assistant, automation). Default: the
   *  current async chain's via (runVia), else none. Pass null to force none. */
  via?: Via | null;
}

type WriteObserver = (orgId: string, ref: ActivityRef) => void;
const writeObservers: WriteObserver[] = [];
/** Told of every row written, after it is: something in that workspace
 *  changed. A module's own route logs its edit here even when it emits no
 *  event, so this is the one place a hand edit is always seen. Must be cheap
 *  for a workspace it does not care about. */
export function observeActivity(fn: WriteObserver): void {
  writeObservers.push(fn);
}

export async function log(p: LogParams, db: Kysely<MetaDB> = meta): Promise<void> {
  // Auto-resolve actor from the current request's AsyncLocalStorage
  // context when caller didn't override.
  const actor = currentActor();
  const userId = p.userId !== undefined ? p.userId : (actor?.userId ?? null);
  const authMethod: AuthMethod =
    p.authMethod ?? (actor ? actor.authMethod : "system");
  const apiTokenId =
    p.apiTokenId !== undefined ? p.apiTokenId : (actor?.apiTokenId ?? null);
  const via = p.via !== undefined ? p.via : currentVia();
  const write = p.action === "updated" || p.action.endsWith("_updated")
    ? currentHistoryWrite(p.orgId, `${p.ref.module}:${p.ref.entityType}`, p.ref.entityId)
    : null;
  const after = write ? await write.readAfter() : null;
  const rawDiff = write && after ? historyDiff(write.before, after) :
    p.before !== undefined && p.diff && typeof p.diff === "object" && !Array.isArray(p.diff)
      ? { ...(p.diff as Record<string, unknown>), changes: changesOf(p.before, p.diff), ...((p.before as { id?: unknown })?.id === p.ref.entityId ? { version_before: p.before } : {}) }
      : p.diff;

  const diff = await keepActivityReferenceTitles(p.orgId, [`${p.ref.module}:${p.ref.entityType}`], secretHistoryDiff(rawDiff));

  await db
    .insertInto("activity_log")
    .values({
      org_id: p.orgId,
      user_id: userId,
      module_name: p.ref.module,
      action: p.action,
      entity_type: p.ref.entityType,
      entity_id: p.ref.entityId,
      diff: diff === undefined ? null : (secretHistoryDiff(diff) as object),
      auth_method: authMethod,
      api_token_id: apiTokenId,
      via_kind: via?.kind ?? null,
      via_label: via?.label ?? null,
    })
    .execute();
  if (write) write.logged = true;
  if (p.action.endsWith("_created")) noteCreatedLog(p.ref.module, p.ref.entityType, p.ref.entityId);
  for (const fn of writeObservers) {
    try {
      runOutsideRequestScope(() => fn(p.orgId, p.ref));
    } catch (err) {
      console.error("[activity] observer failed:", err);
    }
  }

  const days = env.ACTIVITY_LOG_RETENTION_DAYS;
  if (days && Math.random() < 0.01) {
    runOutsideRequestScope(() => void meta
      .deleteFrom("activity_log")
      .where("occurred_at", "<", sql<Date>`now() - interval '${sql.raw(String(days))} days'`)
      .execute()
      .catch((err) => console.error("[activity] retention sweep failed:", (err as Error).message)));
  }
}

/** The name each record of a kind was created with, for the ones whose
 *  creation name matches `pattern` (case-insensitive, run by the database),
 *  from the creation entry of its log. The first entry wins (a record is
 *  created once). */
export async function createdNamesMatching(
  orgId: string,
  p: { module: string; entityType: string; pattern: string; limit?: number },
): Promise<Array<{ entityId: string; name: string }>> {
  const rows = await meta
    .selectFrom("activity_log")
    .select(["entity_id", sql<string>`diff->>'name'`.as("name")])
    .where("org_id", "=", orgId)
    .where("module_name", "=", p.module)
    .where("entity_type", "=", p.entityType)
    .where("action", "=", `${p.entityType}_created`)
    .where(sql<boolean>`diff->>'name' ~* ${p.pattern}`)
    .orderBy("occurred_at", "asc")
    .limit(p.limit ?? 5000)
    .execute();
  const seen = new Set<string>();
  const out: Array<{ entityId: string; name: string }> = [];
  for (const r of rows) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    out.push({ entityId: r.entity_id, name: r.name });
  }
  return out;
}

/** The newest change anyone recorded on these records, or null for none. */
export async function newestChangeOn(orgId: string, ids: readonly string[]): Promise<number | null> {
  if (!ids.length) return null;
  const row = await meta
    .selectFrom("activity_log")
    .select((eb) => eb.fn.max("id").as("id"))
    .where("org_id", "=", orgId)
    .where("entity_id", "in", [...ids])
    .executeTakeFirst();
  return row?.id == null ? null : Number(row.id);
}

/** The newest entry of this action on one record: where a run that logs its
 *  own line once it is done (a recount applied) ends. */
export async function entryOf(orgId: string, p: { entityId: string; action: string }): Promise<number | null> {
  const row = await meta
    .selectFrom("activity_log")
    .select((eb) => eb.fn.max("id").as("id"))
    .where("org_id", "=", orgId)
    .where("entity_id", "=", p.entityId)
    .where("action", "=", p.action)
    .executeTakeFirst();
  return row?.id == null ? null : Number(row.id);
}

/** What someone else changed on these records after entry `after`, as the
 *  sentence an Undo refuses with, or null when nobody did. A change the
 *  platform made on its own (a wire, a sweep) is not someone's change, and
 *  the person's own later change is theirs to stack (#7924). */
export async function changeSince(orgId: string, p: { ids: readonly string[]; after: number; userId: string | null }): Promise<string | null> {
  if (!p.ids.length) return null;
  const userId = p.userId;
  const later = await meta
    .selectFrom("activity_log as a")
    .leftJoin("users as u", "u.id", "a.user_id")
    .select(["a.user_id", "a.action", "u.display_name"])
    .where("a.org_id", "=", orgId)
    .where("a.entity_id", "in", [...p.ids])
    .where("a.id", ">", p.after)
    .where("a.auth_method", "!=", "system")
    .where((eb) => (userId ? eb.or([eb("a.user_id", "is", null), eb("a.user_id", "!=", userId)]) : eb.val(true)))
    .orderBy("a.id", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!later) return null;
  const who = later.display_name ?? "someone else";
  return `This changed after it was done (${who} ${saidAs(later.action)} it since), so Undo would take that away too. Nothing was undone; look at it and change it back yourself if you still need to.`;
}

function saidAs(action: string): string {
  const verb = action.replace(/^.*?_?(created|updated|deleted|lent|returned|restored|moved|adjusted|archived)$/, "$1");
  return verb === action ? "changed" : verb;
}

/** One row of a bulk write (an import of thousands): `diff.import_row` marks
 *  it, so a record's own History carries it while the workspace's and the
 *  person's feeds leave it to the bulk write's one summary line (#5963). */
export const IMPORT_ROW = "import_row";

/** Many entries from one bulk write, by one person, in one INSERT per chunk:
 *  every record a 40k-row import makes gets its own History line without 40k
 *  round trips. Each entry's diff is marked IMPORT_ROW. */
export async function logMany(p: { orgId: string; userId?: string | null; rows: ReadonlyArray<{ action: string; ref: ActivityRef; diff?: Record<string, unknown> }> }): Promise<void> {
  if (!p.rows.length) return;
  const actor = currentActor();
  const userId = p.userId !== undefined ? p.userId : (actor?.userId ?? null);
  const authMethod: AuthMethod = actor ? actor.authMethod : "system";
  const apiTokenId = actor?.apiTokenId ?? null;
  const via = currentVia();
  const CHUNK = 500;
  for (let i = 0; i < p.rows.length; i += CHUNK) {
    await meta
      .insertInto("activity_log")
      .values(p.rows.slice(i, i + CHUNK).map((r) => ({
        org_id: p.orgId,
        user_id: userId,
        module_name: r.ref.module,
        action: r.action,
        entity_type: r.ref.entityType,
        entity_id: r.ref.entityId,
        diff: secretHistoryDiff({ ...(r.diff ?? {}), [IMPORT_ROW]: true }) as object,
        auth_method: authMethod,
        api_token_id: apiTokenId,
        via_kind: via?.kind ?? null,
        via_label: via?.label ?? null,
      })))
      .execute();
  }
  for (const r of p.rows) {
    if (r.action.endsWith("_created")) noteCreatedLog(r.ref.module, r.ref.entityType, r.ref.entityId);
    for (const fn of writeObservers) {
      try {
        runOutsideRequestScope(() => fn(p.orgId, r.ref));
      } catch (err) {
        console.error("[activity] observer failed:", err);
      }
    }
  }
}

/** Actions that record what the OPERATOR did to a workspace, kept for the
 *  operator's own audit and never shown to the workspace's members. The owner
 *  decided (2026-09-08) that a member should not see "support looked here" in
 *  their feed; the record still exists, on the operator side only. Anything
 *  listed here is filtered out of every member-facing list BY DEFAULT, so a
 *  new tenant-facing route cannot leak it by forgetting a flag. */
export const OPERATOR_ONLY_ACTIONS: ReadonlySet<string> = new Set(["impersonation_started"]);

export function isOperatorOnlyAction(action: string): boolean {
  return OPERATOR_ONLY_ACTIONS.has(action) || action.startsWith("impersonation_");
}

export interface ListParams {
  orgId: string;
  /** Operator surfaces only. Member-facing lists leave this unset and never see
   *  OPERATOR_ONLY_ACTIONS. */
  includeOperatorOnly?: boolean;
  limit?: number;
  cursorBeforeId?: number;
  /** Restrict to actions matching this list. */
  actions?: string[];
  /** Filter by auth method. */
  authMethods?: AuthMethod[];
  /** Filter by a specific API token id. */
  apiTokenId?: string;
  /** Filter by entity type. */
  entityType?: string;
  /** With entityType: one thing logged with no module of its own, like a
   *  wire's firings (entity_type "binding", its id), #6129. */
  entityId?: string;
  /** One record's history: the module, type and id it was logged under (the
   *  shape of activity_log_entity_idx). */
  entity?: { module: string; type: string; id: string };
}

export interface ActivityEntry {
  id: number;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown | null;
  auth_method: AuthMethod;
  api_token_id: string | null;
  via_kind: string | null;
  via_label: string | null;
  occurred_at: Date;
}

/** The log rows these filters select, before any window. One definition, so
 *  a page and its count can never select different rows. */
function selected(p: ListParams) {
  let q = meta.selectFrom("activity_log").where("org_id", "=", p.orgId);
  if (!p.includeOperatorOnly) {
    q = q.where("action", "not in", [...OPERATOR_ONLY_ACTIONS]).where("action", "not like", "impersonation\\_%");
  }
  if (p.actions && p.actions.length > 0) q = q.where("action", "in", p.actions);
  if (p.authMethods && p.authMethods.length > 0) q = q.where("auth_method", "in", p.authMethods);
  if (p.apiTokenId) q = q.where("api_token_id", "=", p.apiTokenId);
  if (p.entityType) q = q.where("entity_type", "=", p.entityType);
  if (p.entityType && p.entityId) q = q.where("entity_id", "=", p.entityId);
  if (p.entity) {
    q = q.where("module_name", "=", p.entity.module).where("entity_type", "=", p.entity.type).where("entity_id", "=", p.entity.id);
  } else {
    // A feed reads a bulk write as its one summary line, never its rows.
    q = q.where(sql<boolean>`coalesce(diff->>${IMPORT_ROW}, '') <> 'true'`);
  }
  return q;
}

export async function list(p: ListParams): Promise<ActivityEntry[]> {
  const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
  let q = selected(p)
    .select([
      "id",
      "user_id",
      "module_name",
      "action",
      "entity_type",
      "entity_id",
      "diff",
      "auth_method",
      "api_token_id",
      "via_kind",
      "via_label",
      "occurred_at",
    ])
    .orderBy("id", "desc")
    .limit(limit);
  if (typeof p.cursorBeforeId === "number") q = q.where("id", "<", p.cursorBeforeId);
  return q.execute();
}

/** How many entries the same filters select in all, whatever page is shown. */
export async function count(p: ListParams): Promise<number> {
  const r = await selected(p).select(({ fn }) => fn.countAll<number>().as("n")).executeTakeFirst();
  return Number(r?.n ?? 0);
}
