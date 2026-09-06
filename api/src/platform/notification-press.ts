// Pressing a button on a notification — the rule, once, for every door.
//
// A notification can carry ACTIONS: pressable things a person can do about it
// without going anywhere ("Mark done", "Move it", "Accept"). The column has been
// there, dispatch writes it, and the Discord channel renders the buttons and
// runs them. Cobblr's own bell rendered none of it: the listers did not even
// select the column, and there was no endpoint to press one (found by audit,
// 2026-09-06). So the app was the one place a notification could not be acted
// on, which is the general form of "why doesn't this notification do anything?"
//
// The Discord route had grown four checks that are not about Discord at all:
// the press must belong to the presser, the presser must still be a member, an
// entity-scoped action needs the entity the notification names, and a floored
// action must clear its floor whichever door it came through. Adding a second
// door by copying those is how two doors start disagreeing about who may do
// what - and the one that drifts is the one nobody re-reads. So they live here
// and both doors call this.
//
// Refusals are deliberately ONE shape. Distinguishing "not yours" from "no such
// notification" tells a prober which ids exist, and that reasoning is inherited
// from the Discord route rather than reinvented.

import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { resolvePress, pressMayAct, type StoredNotification } from "./discord-interaction.js";
import { assertActingRoleClearsActionFloor, ActionRoleFloorError } from "./platform-actions.js";

export type PressOutcome =
  | { ok: true; label: string }
  | { ok: false; reason: "refused" | "failed" };

/**
 * Run one action off one notification, as one user.
 *
 * `actorName` and `authMethod` differ per door and nothing else does. The
 * caller has already authenticated the person; this decides whether that person
 * may press THIS button, and runs it if so.
 */
export async function pressNotificationAction(args: {
  notificationId: string;
  actionId: string;
  /** The Cobblr user doing it, established by the calling door. */
  userId: string;
  actorName?: string | null;
  /** How they proved who they are, for the activity trail. */
  authMethod?: "session" | "api_token";
  /** What the person typed, when the door collected any (the Discord reply
   *  modal). Merged over the action's stored args, never under them. */
  extraArgs?: Record<string, unknown>;
}): Promise<PressOutcome> {
  const row = await meta
    .selectFrom("notifications")
    .select([
      "id",
      "org_id",
      "user_id",
      "actions",
      "module_name",
      "entity_type",
      "entity_id",
    ])
    .where("id", "=", args.notificationId)
    .executeTakeFirst();

  const resolved = resolvePress(
    (row as StoredNotification | undefined) ?? null,
    args.userId,
    { notificationId: args.notificationId, actionId: args.actionId },
  );
  if (!resolved.ok) return { ok: false, reason: "refused" };

  // Membership NOW, not when the notification was written. A notification
  // outlives access: a guest may legitimately be told about something they may
  // not change, and a member's access can be revoked after the row was sent.
  const membership = await meta
    .selectFrom("org_memberships")
    .select("role")
    .where("org_id", "=", resolved.orgId)
    .where("user_id", "=", args.userId)
    .executeTakeFirst();
  if (!pressMayAct(membership?.role)) return { ok: false, reason: "refused" };

  try {
    assertActingRoleClearsActionFloor(resolved.action, membership?.role ?? null);
  } catch (err) {
    if (err instanceof ActionRoleFloorError) return { ok: false, reason: "refused" };
    throw err;
  }

  // The notification records what it is ABOUT, so an entity-scoped action can
  // run from a press. Without it, invoke() gets no entity and every action
  // reachable this way would have to be workspace-scoped - which rules out the
  // interesting ones, the ones about the record you were just told about.
  const entity =
    row?.module_name && row.entity_type && row.entity_id
      ? { kind: `${row.module_name}:${row.entity_type}`, id: row.entity_id, fields: {} }
      : undefined;

  try {
    await platform().actions.invoke(resolved.action, {
      orgId: resolved.orgId,
      userId: resolved.userId,
      ...(entity ? { scope: "entity" as const, entity } : {}),
      event: {
        name: "platform.notification.action",
        payload: { notificationId: args.notificationId, actionId: args.actionId },
        actor: {
          user_id: resolved.userId,
          display_name: args.actorName ?? null,
          auth_method: args.authMethod ?? "session",
        },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: args.extraArgs ? { ...resolved.args, ...args.extraArgs } : resolved.args,
    });
  } catch (err) {
    console.error("[notification-press]", (err as Error).message);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, label: resolved.label };
}
