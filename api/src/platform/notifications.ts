// Notification dispatcher. Modules call dispatch(); this writes the
// notification row, looks up the user's enabled channels for the
// event type, fans out, and updates delivered_via on success.
//
// Channel registry is process-static — channels can't be added at
// runtime (and don't need to be in Phase 0).

import { meta } from "../db/meta.js";
import { inAppChannel } from "./channels/in-app.js";
import { browserPushChannel } from "./channels/browser-push.js";
import type { Channel } from "./channels/types.js";
import type { NotificationChannel } from "../db/schema.js";

const REGISTRY: Record<NotificationChannel, Channel | undefined> = {
  in_app: inAppChannel,
  browser_push: browserPushChannel,
  email: undefined,
  discord: undefined,
  webhook: undefined,
  slack: undefined,
};

export interface DispatchParams {
  orgId: string;
  userId: string;
  eventType: string;
  message: string;
  link_url?: string;
  module?: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}

export interface DispatchResult {
  notificationId: string;
  deliveredVia: NotificationChannel[];
}

export async function dispatch(p: DispatchParams): Promise<DispatchResult> {
  // 1. Insert the notification row first so it exists in the DB even
  //    if every channel fails. delivered_via starts empty.
  const inserted = await meta
    .insertInto("notifications")
    .values({
      org_id: p.orgId,
      user_id: p.userId,
      event_type: p.eventType,
      module_name: p.module ?? null,
      entity_type: p.entityType ?? null,
      entity_id: p.entityId ?? null,
      message: p.message,
      link_url: p.link_url ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // 2. Resolve which channels are enabled. No subscriptions → default
  //    to in_app only. Explicit row with enabled=false suppresses a
  //    channel that would otherwise default-on.
  const subs = await meta
    .selectFrom("notification_subscriptions")
    .select(["channel", "enabled"])
    .where("user_id", "=", p.userId)
    .where("org_id", "=", p.orgId)
    .where("event_type", "=", p.eventType)
    .execute();

  const channelNames: NotificationChannel[] =
    subs.length === 0
      ? ["in_app"]
      : (subs.filter((s) => s.enabled).map((s) => s.channel) as NotificationChannel[]);

  // 3. Fan out in parallel. A failing channel doesn't take the others
  //    down with it. Channels not in the registry (or stubbed out)
  //    won't appear in delivered_via.
  const results = await Promise.all(
    channelNames.map(async (name) => {
      const channel = REGISTRY[name];
      if (!channel) return { name, ok: false };
      try {
        const ok = await channel.deliver({
          notificationId: inserted.id,
          orgId: p.orgId,
          userId: p.userId,
          eventType: p.eventType,
          message: p.message,
          link_url: p.link_url ?? null,
          payload: p.payload,
        });
        return { name, ok };
      } catch (err) {
        console.error(`[notify] channel ${name} threw:`, err);
        return { name, ok: false };
      }
    }),
  );

  const deliveredVia = results.filter((r) => r.ok).map((r) => r.name);
  if (deliveredVia.length > 0) {
    await meta
      .updateTable("notifications")
      .set({ delivered_via: deliveredVia })
      .where("id", "=", inserted.id)
      .execute();
  }
  return { notificationId: inserted.id, deliveredVia };
}

export interface NotificationListItem {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  read_at: Date | null;
  created_at: Date;
}

export async function listForUser(
  userId: string,
  orgId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let q = meta
    .selectFrom("notifications")
    .select([
      "id",
      "event_type",
      "module_name",
      "message",
      "link_url",
      "read_at",
      "created_at",
    ])
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .orderBy("created_at", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("read_at", "is", null);
  return q.execute();
}

export async function markRead(notificationId: string, userId: string): Promise<void> {
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("id", "=", notificationId)
    .where("user_id", "=", userId)
    .execute();
}

export async function markAllRead(userId: string, orgId: string): Promise<number> {
  const updated = await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .where("read_at", "is", null)
    .returning("id")
    .execute();
  return updated.length;
}

export async function unreadCount(userId: string, orgId: string): Promise<number> {
  const row = await meta
    .selectFrom("notifications")
    .select(({ fn }) => fn.countAll<string>().as("c"))
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .where("read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

// ─────── Cross-workspace variants for /me/notifications ─────────────
// The header bell wants "everything for this user, no matter which
// workspace they're currently viewing". These variants join through
// org_memberships so we only return notifications for orgs the user
// still belongs to (handles the "you were removed from a workspace"
// case implicitly).

export interface CrossOrgNotificationListItem extends NotificationListItem {
  org_id: string;
  org_name: string;
  org_slug: string;
}

export async function listForUserAcrossOrgs(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<CrossOrgNotificationListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let q = meta
    .selectFrom("notifications as n")
    .innerJoin("org_memberships as m", (j) =>
      j.onRef("m.org_id", "=", "n.org_id").on("m.user_id", "=", userId),
    )
    .innerJoin("orgs as o", "o.id", "n.org_id")
    .select([
      "n.id as id",
      "n.event_type as event_type",
      "n.module_name as module_name",
      "n.message as message",
      "n.link_url as link_url",
      "n.read_at as read_at",
      "n.created_at as created_at",
      "n.org_id as org_id",
      "o.name as org_name",
      "o.slug as org_slug",
    ])
    .where("n.user_id", "=", userId)
    .orderBy("n.created_at", "desc")
    .limit(limit);
  if (opts.unreadOnly) q = q.where("n.read_at", "is", null);
  return q.execute();
}

export async function unreadCountAcrossOrgs(userId: string): Promise<number> {
  const row = await meta
    .selectFrom("notifications as n")
    .innerJoin("org_memberships as m", (j) =>
      j.onRef("m.org_id", "=", "n.org_id").on("m.user_id", "=", userId),
    )
    .select(({ fn }) => fn.countAll<string>().as("c"))
    .where("n.user_id", "=", userId)
    .where("n.read_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

export async function markAllReadAcrossOrgs(userId: string): Promise<number> {
  const updated = await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", userId)
    .where("read_at", "is", null)
    .returning("id")
    .execute();
  return updated.length;
}
