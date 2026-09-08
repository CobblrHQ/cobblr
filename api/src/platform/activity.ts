// ActivityLog primitive. Every CRUD that matters routes through
// here; modules will call `activity.log(...)` from their handlers.
// Append-only — no updates, no deletes by hand.
//
// Retention (audit F8): the table grows forever by default — fine for a
// personal box, a liability on a public host. Setting
// ACTIVITY_LOG_RETENTION_DAYS enables a probabilistic sweep (~1% of writes
// prune rows past the window; best-effort, never blocks the write) — same
// pattern as product_events. Unset (default) = keep everything.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { currentActor } from "../lib/request-context.js";
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
  /** Override the auth method. Default: pull from request context if
   *  one is set, else 'system'. */
  authMethod?: AuthMethod;
  /** Override the API token id. Default: pull from request context. */
  apiTokenId?: string | null;
}

export async function log(p: LogParams): Promise<void> {
  // Auto-resolve actor from the current request's AsyncLocalStorage
  // context when caller didn't override.
  const actor = currentActor();
  const userId = p.userId !== undefined ? p.userId : (actor?.userId ?? null);
  const authMethod: AuthMethod =
    p.authMethod ?? (actor ? actor.authMethod : "system");
  const apiTokenId =
    p.apiTokenId !== undefined ? p.apiTokenId : (actor?.apiTokenId ?? null);

  await meta
    .insertInto("activity_log")
    .values({
      org_id: p.orgId,
      user_id: userId,
      module_name: p.ref.module,
      action: p.action,
      entity_type: p.ref.entityType,
      entity_id: p.ref.entityId,
      diff: p.diff === undefined ? null : (p.diff as object),
      auth_method: authMethod,
      api_token_id: apiTokenId,
    })
    .execute();

  const days = env.ACTIVITY_LOG_RETENTION_DAYS;
  if (days && Math.random() < 0.01) {
    void meta
      .deleteFrom("activity_log")
      .where("occurred_at", "<", sql<Date>`now() - interval '${sql.raw(String(days))} days'`)
      .execute()
      .catch((err) => console.error("[activity] retention sweep failed:", (err as Error).message));
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
  occurred_at: Date;
}

export async function list(p: ListParams): Promise<ActivityEntry[]> {
  const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
  let q = meta
    .selectFrom("activity_log")
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
      "occurred_at",
    ])
    .where("org_id", "=", p.orgId)
    .orderBy("id", "desc")
    .limit(limit);
  if (!p.includeOperatorOnly) {
    q = q.where("action", "not in", [...OPERATOR_ONLY_ACTIONS]).where("action", "not like", "impersonation\\_%");
  }
  if (typeof p.cursorBeforeId === "number") {
    q = q.where("id", "<", p.cursorBeforeId);
  }
  if (p.actions && p.actions.length > 0) {
    q = q.where("action", "in", p.actions);
  }
  if (p.authMethods && p.authMethods.length > 0) {
    q = q.where("auth_method", "in", p.authMethods);
  }
  if (p.apiTokenId) {
    q = q.where("api_token_id", "=", p.apiTokenId);
  }
  if (p.entityType) {
    q = q.where("entity_type", "=", p.entityType);
  }
  return q.execute();
}
