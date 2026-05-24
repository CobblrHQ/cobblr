// projects-side notification mappers — translate semantic events the
// projects module emits into user-facing notifications.
//
// The kernel used to own this subscriber (api/src/platform/notification-subscribers.ts)
// but that put module-shape knowledge (what a Task is, what link to
// build) inside platform code. Per module-layers.md the kernel can't
// know about specific modules — so the mapper lives here now and
// registers itself when the projects module loads.

import { platform } from "@cobblr/platform-contract";

interface TaskUnblockedPayload {
  orgId: string;
  taskId: string;
  via?: { kind: string; id: string };
}

export function registerProjectsNotificationMappers(): void {
  platform().events.on(
    "projects.task.unblocked",
    "projects.notify.task-unblocked",
    async (raw: unknown) => {
      const p = raw as TaskUnblockedPayload;
      if (!p?.orgId || !p?.taskId) return;
      try {
        const task = await platform().entities.lookup(
          p.orgId,
          "projects:task",
          p.taskId,
        );
        if (!task) return;
        const causeText = p.via
          ? await viaText(p.orgId, p.via)
          : "a dependency";
        const message = `Task "${task.title}" is unblocked (${causeText} is now satisfied)`;
        const userIds = await platform().notifications.orgMemberIds(p.orgId);
        for (const userId of userIds) {
          try {
            await platform().notifications.dispatch({
              orgId: p.orgId,
              userId,
              eventType: "projects.task.unblocked",
              message,
              link_url: `/projects/${
                (task.fields as Record<string, unknown>).project_id ?? ""
              }`,
              module: "projects",
              entityType: "task",
              entityId: p.taskId,
            });
          } catch (err) {
            console.error("[projects.notify] dispatch failed:", err);
          }
        }
      } catch (err) {
        console.error("[projects.notify] task.unblocked handler failed:", err);
      }
    },
  );
}

async function viaText(
  orgId: string,
  via: { kind: string; id: string },
): Promise<string> {
  try {
    const ent = await platform().entities.lookup(orgId, via.kind, via.id);
    if (ent) return `"${ent.title}"`;
  } catch {
    /* fall through */
  }
  return `${via.kind} ${via.id.slice(0, 8)}`;
}
