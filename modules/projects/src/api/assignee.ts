// Whose job a task is. The `assignee` field (contributed by this module, a
// `person`) names anyone on the workspace's People list; a member hears about
// it when a task is given to them, and nobody is told about their own doing.

import { platform } from "@cobblr/platform-contract";
import { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";

export function assigneeOf(metadata: unknown): string | null {
  const v = (metadata as Record<string, unknown> | null)?.assignee;
  return typeof v === "string" && v ? v : null;
}

/** A task was given to someone (or to someone else): tell them, when they
 *  have an account and are not the one who did it. */
export async function tellAssignee(
  orgId: string,
  task: { id: string; title: string; project_name?: string | null },
  personId: string,
  byUserId: string | null,
): Promise<boolean> {
  const userId = await platform().accounts.userForPerson(orgId, personId).catch(() => null);
  if (!userId || userId === byUserId) return false;
  const by = byUserId ? (await platform().accounts.displayNames(orgId, [byUserId]))[byUserId] : undefined;
  await platform().notifications.dispatch({
    orgId,
    userId,
    eventType: "projects.task.assigned",
    message: `${by ?? "Someone"} gave you "${task.title}"${task.project_name ? ` in ${task.project_name}` : ""}.`,
    card: { heading: task.title, ...(task.project_name ? { context: task.project_name } : {}) },
    module: "projects",
    entityType: "task",
    entityId: task.id,
    link_url: resolveDetailPath({ kind: "projects:task", id: task.id, instance: null, detailUrl: null, baseDetailRoute: "/projects/tasks/{id}" })!,
  });
  platform().events.emit("projects.task.assigned", { orgId, taskId: task.id, personId, userId });
  return true;
}
