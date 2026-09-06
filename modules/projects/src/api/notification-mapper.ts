// projects-side notification mappers — translate semantic events the
// projects module emits into user-facing notifications.
//
// The kernel used to own this subscriber (api/src/platform/notification-subscribers.ts)
// but that put module-shape knowledge (what a Task is, what link to
// build) inside platform code. Per module-layers.md the kernel can't
// know about specific modules — so the mapper lives here now and
// registers itself when the projects module loads.

import { NotificationBatcher, platform, type ComposedBurst } from "@cobblr/platform-contract";

interface TaskUnblockedPayload {
  orgId: string;
  taskId: string;
  via?: { kind: string; id: string };
}

/** One unblocked task, held back to be said together with the rest of its burst. */
export interface Unblocked {
  title: string;
  taskId: string;
  projectId: string;
  causeText: string;
}

/**
 * How several unblocked tasks become one sentence.
 *
 * Exported so a test can ask what somebody actually reads without standing up
 * the platform.
 */
export function composeUnblocked(items: readonly Unblocked[]): ComposedBurst | null {
  if (items.length === 0) return null;
  if (items.length === 1) {
    const u = items[0]!;
    return {
      message: `Task "${u.title}" is unblocked (${u.causeText} is now satisfied)`,
      count: 1,
      link_url: `/projects/${u.projectId}`,
      entityType: "task",
      entityId: u.taskId,
    };
  }
  // Three names then a count: this exists to get somebody to go and look, and a
  // phone notification truncates a longer list anyway.
  const shown = items.slice(0, 3).map((u) => `"${u.title}"`).join(", ");
  const rest = items.length > 3 ? ` and ${items.length - 3} more` : "";
  const projects = new Set(items.map((u) => u.projectId));
  return {
    message: `${items.length} tasks are unblocked: ${shown}${rest}`,
    count: items.length,
    // All in one project is still somewhere honest to point.
    // One project → that project. Several → the list of them, which is where
    // the unblocked tasks are; `undefined` here used to mean the burst version
    // of this notification went nowhere at all.
    // PAGE-LINK: the burst spans several projects; no single one is right.
    link_url: projects.size === 1 ? `/projects/${items[0]!.projectId}` : "/projects",
  };
}

/**
 * Finishing ONE task can unblock eight of them, and the handler below fires
 * once per task. Read on its own each message is good; eight arriving together
 * is a stream, and a handler cannot see the burst it is part of - it only ever
 * gets its own event. So something has to hold the beat, and that is the
 * platform's batcher. What stays in this module is the part only projects can
 * answer: the sentence, and where it points.
 */
export const unblockedBatcher = new NotificationBatcher<Unblocked>(
  composeUnblocked,
  async (orgId, burst) => {
    const userIds = await platform().notifications.orgMemberIds(orgId);
    for (const userId of userIds) {
      try {
        await platform().notifications.dispatch({
          orgId,
          userId,
          eventType: "projects.task.unblocked",
          message: burst.message,
          // composeUnblocked always names one (a project, or the list of
          // them); the burst type allows none, so the absence is spelled out
          // rather than silently dropped.
          ...(burst.link_url
            ? { link_url: burst.link_url }
            : { no_link_reason: "the burst named no project" }),
          module: "projects",
          entityType: burst.entityType,
          entityId: burst.entityId,
          payload: { count: burst.count },
        });
      } catch (err) {
        console.error("[projects.notify] dispatch failed:", err);
      }
    }
  },
  // Much shorter than the default. A dependency cascade is a MACHINE fan-out:
  // finishing one task unblocks the rest within the same request, so a beat
  // this short still collects the whole burst, and the notification still
  // arrives while the person is looking at the screen they caused it from.
  // The 20s default is sized for a HUMAN burst - a shop filed item by item.
  1_500,
);

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
        unblockedBatcher.add(p.orgId, {
          title: task.title ?? "Untitled",
          taskId: p.taskId,
          projectId: String((task.fields as Record<string, unknown>).project_id ?? ""),
          causeText,
        });
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
