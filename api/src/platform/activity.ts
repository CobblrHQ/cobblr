// ActivityLog primitive. Every CRUD that matters routes through
// here; modules will call `activity.log(...)` from their handlers.
// Append-only — no updates, no deletes.

import { meta } from "../db/meta.js";

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
  userId: string | null;
  action: string;
  ref: ActivityRef;
  diff?: unknown;
}

export async function log(p: LogParams): Promise<void> {
  await meta
    .insertInto("activity_log")
    .values({
      org_id: p.orgId,
      user_id: p.userId,
      module_name: p.ref.module,
      action: p.action,
      entity_type: p.ref.entityType,
      entity_id: p.ref.entityId,
      diff: p.diff === undefined ? null : (p.diff as object),
    })
    .execute();
}

export interface ListParams {
  orgId: string;
  limit?: number;
  cursorBeforeId?: number;
}

export interface ActivityEntry {
  id: number;
  user_id: string | null;
  module_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  diff: unknown | null;
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
      "occurred_at",
    ])
    .where("org_id", "=", p.orgId)
    .orderBy("id", "desc")
    .limit(limit);
  if (typeof p.cursorBeforeId === "number") {
    q = q.where("id", "<", p.cursorBeforeId);
  }
  return q.execute();
}
