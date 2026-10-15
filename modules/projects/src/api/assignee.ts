// Whose job a task is. The `assignee` field (contributed by this module, a
// `person`) names anyone on the workspace's People list; a member hears about
// it when a task is given to them, and nobody is told about their own doing.

import { platform } from "@cobblr/platform-contract";

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
  const link = await platform().entities.recordAddressForEntity(orgId, "projects:task", task.id).catch(() => undefined);
  await platform().notifications.dispatch({
    orgId,
    userId,
    eventType: "projects.task.assigned",
    // Addressed to one person about their own job, and stale if it waits: it
    // must reach a phone set to "only what needs me" (the default push level).
    priority: "high",
    message: `${by ?? "Someone"} gave you "${task.title}"${task.project_name ? ` in ${task.project_name}` : ""}.`,
    card: { heading: task.title, ...(task.project_name ? { context: task.project_name } : {}) },
    module: "projects",
    entityType: "task",
    entityId: task.id,
    ...(link
      ? { link_url: link }
      : { no_link_reason: "the task has no detail page" }),
  });
  platform().events.emit("projects.task.assigned", { orgId, taskId: task.id, personId, userId });
  return true;
}

/** What waited for a task given to someone is done: it is their turn. "own"
 *  when they finished it themselves (nobody is told about their own doing),
 *  "no-account" when the person has no account to tell. */
export async function tellTurn(
  orgId: string,
  task: { id: string; title: string; project_name?: string | null },
  personId: string,
  blockerTitle: string | null,
  byUserId: string | null,
): Promise<"told" | "own" | "no-account"> {
  const userId = await platform().accounts.userForPerson(orgId, personId).catch(() => null);
  if (!userId) return "no-account";
  if (userId === byUserId) return "own";
  const link = await platform().entities.recordAddressForEntity(orgId, "projects:task", task.id).catch(() => undefined);
  const where = task.project_name ? ` in ${task.project_name}` : "";
  await platform().notifications.dispatch({
    orgId,
    userId,
    eventType: "projects.task.your-turn",
    priority: "high",
    message: blockerTitle
      ? `"${blockerTitle}" is done, so "${task.title}"${where} is yours to start.`
      : `What "${task.title}"${where} waited on is done, so it is yours to start.`,
    card: { heading: task.title, ...(task.project_name ? { context: task.project_name } : {}) },
    module: "projects",
    entityType: "task",
    entityId: task.id,
    ...(link ? { link_url: link } : { no_link_reason: "the task has no detail page" }),
  });
  return "told";
}
