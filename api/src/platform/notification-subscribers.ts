// Platform-level event → notification mappers. Keeps notification
// fan-out out of the modules themselves (modules emit semantic
// events; the platform decides what's notification-worthy).
//
// Registered at boot from index.ts via registerNotificationSubscribers().
//
// Each subscriber:
//   1. Listens for a specific cross-module event.
//   2. Looks up enough entity context to write a human message.
//   3. Fans the notification out to every member of the org.
//
// Failures are swallowed and logged — notifications are best-effort.

import { meta } from "../db/meta.js";
import * as events from "./events.js";
import * as entities from "./entities.js";
import * as notifications from "./notifications.js";

interface TaskUnblockedPayload {
  orgId: string;
  taskId: string;
  via?: { kind: string; id: string };
}

async function membersOf(orgId: string): Promise<string[]> {
  const rows = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .execute();
  return rows.map((r) => String(r.user_id));
}

export function registerNotificationSubscribers(): void {
  events.on("projects.task.unblocked", "platform.notify", async (raw: unknown) => {
    const p = raw as TaskUnblockedPayload;
    if (!p?.orgId || !p?.taskId) return;
    try {
      const task = await entities.lookup(p.orgId, "projects:task", p.taskId);
      if (!task) return;
      const causeText = p.via
        ? await viaText(p.orgId, p.via)
        : "a dependency";
      const message = `Task "${task.title}" is unblocked (${causeText} is now satisfied)`;
      const userIds = await membersOf(p.orgId);
      for (const userId of userIds) {
        try {
          await notifications.dispatch({
            orgId: p.orgId,
            userId,
            eventType: "projects.task.unblocked",
            message,
            link_url: `/projects/${(task.fields as Record<string, unknown>).project_id ?? ""}`,
            module: "projects",
            entityType: "task",
            entityId: p.taskId,
          });
        } catch (err) {
          console.error("[notify-sub] dispatch failed:", err);
        }
      }
    } catch (err) {
      console.error("[notify-sub] task.unblocked handler failed:", err);
    }
  });
}

async function viaText(
  orgId: string,
  via: { kind: string; id: string },
): Promise<string> {
  try {
    const ent = await entities.lookup(orgId, via.kind, via.id);
    if (ent) return `"${ent.title}"`;
  } catch {
    /* fall through */
  }
  return `${via.kind} ${via.id.slice(0, 8)}`;
}
