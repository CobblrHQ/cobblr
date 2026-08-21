// A notification's actions, as a Discord card.
//
// Its own module because it is PURE and the channel beside it is not: importing
// discord-dm pulls the meta database and therefore env validation, which exits
// the process when the environment is incomplete. The decisions worth testing
// are all here, and they are testable with nothing running.

import type { NotificationAction } from "../../db/schema.js";

/** Discord's own cap. A longer label is silently rejected for the whole
 *  message, so it is trimmed here rather than losing the notification. */
const LABEL_MAX = 80;

const STYLE: Record<string, number> = { primary: 1, secondary: 2, danger: 4 };

/** The id a press comes back with.
 *
 *  Deliberately just two identifiers: the notification and which of its actions.
 *  Everything else — the org, the action to run, its arguments — is read from
 *  the stored row, because a custom_id arrives from a client and is not
 *  evidence of anything. It also sidesteps Discord's 100-character limit,
 *  which arguments would blow through.  */
export function customIdFor(notificationId: string, actionId: string): string {
  return `cbl:${notificationId}:${actionId}`;
}

export function parseCustomId(raw: string): { notificationId: string; actionId: string } | null {
  const m = /^cbl:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,32})$/.exec(raw);
  return m ? { notificationId: m[1]!, actionId: m[2]! } : null;
}

/** Discord message components for a notification's actions, or undefined.
 *
 *  Five per row is Discord's limit; more than that in a notification is a
 *  design problem rather than something to paginate, so the rest are dropped
 *  and the message still carries its link. */
export function componentsFor(
  notificationId: string,
  actions: NotificationAction[] | null | undefined,
): unknown[] | undefined {
  if (!actions?.length) return undefined;
  return [
    {
      type: 1, // action row
      components: actions.slice(0, 5).map((a) => ({
        type: 2, // button
        style: STYLE[a.style ?? "secondary"] ?? 2,
        label: a.label.slice(0, LABEL_MAX),
        custom_id: customIdFor(notificationId, a.id),
      })),
    },
  ];
}
