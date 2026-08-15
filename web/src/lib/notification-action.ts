// What clicking a notification should do.
//
// One decision, in one place, because the two surfaces that show notifications
// had drifted into different answers for the same row: the bell suppressed
// navigation for a feedback reply, the notifications page did not; the bell
// resolved a stored link, the page handed it raw to the router. The same
// notification behaved differently depending on where you clicked it.
//
// Three rules, and the first is the one that was missing:
//
//   1. A click with nowhere to go does not MOVE you. It marks the row read and
//      stops. Today a link-less notification still switches workspace, which is
//      a full page load into somewhere you did not ask for, and then navigates
//      nowhere once it arrives.
//   2. The panel closes only when you are LEAVING through it. Closing after a
//      no-op costs a re-open, and nobody reads one notification at a time.
//   3. Some rows carry a link that the ROW should not chase. A reply to your
//      feedback is the message itself, so it keeps a quiet "view thread" button
//      instead of hijacking the click.
//
// See web/src/lib/deep-path.ts for why a stored link cannot be used as a route
// without being rewritten first.

import { notificationRoute } from "./deep-path";

/** Rows whose MESSAGE is the whole point: they have somewhere to go, and the
 *  row click deliberately does not take you there.
 *
 *  Hand-maintained, and it has to be: this cannot be read off the data, because
 *  the distinction is editorial rather than structural. Rule 1 covers the much
 *  larger "no destination" case without anyone remembering anything, so this
 *  stays small. */
const ROW_CLICK_STAYS_PUT = new Set(["platform.feedback.replied"]);

/** An invite is about a workspace you are not in YET. It is attached to one of
 *  your own only so it surfaces, so switching to that scope would take you
 *  somewhere unrelated to the invite. Follow the link, do not switch. */
const NEVER_SWITCHES = new Set(["workspace.invited"]);

export interface NotificationLike {
  event_type: string;
  org_slug: string;
  link_url?: string | null;
}

export interface NotificationAction {
  /** In-app path to go to. Absent when the click stays put. */
  path?: string;
  /** A foreign origin, for a new tab. */
  external?: string;
  /** Workspace to switch to on the way. Null when nothing should move. */
  switchTo: string | null;
  /** Whether the panel should close: only when the click takes you away. */
  close: boolean;
  /** For the row's affordance. A row that goes nowhere should not be styled
   *  like a link, which is the difference between "nothing happened" reading as
   *  calm or as broken. */
  goesSomewhere: boolean;
}

const STAY: NotificationAction = { switchTo: null, close: false, goesSomewhere: false };

export function notificationAction(
  n: NotificationLike,
  origin?: string,
): NotificationAction {
  if (ROW_CLICK_STAYS_PUT.has(n.event_type)) return STAY;

  const { path, external } = notificationRoute(n.link_url, origin);
  // Nowhere to go: mark it read and leave everything else alone. In particular
  // do not switch workspace, which used to happen on the way to nowhere.
  if (!path && !external) return STAY;

  return {
    ...(path ? { path } : {}),
    ...(external ? { external } : {}),
    // An external link opens in a tab, so this page is not going anywhere and
    // switching workspace under it would be a surprise.
    switchTo: path && !NEVER_SWITCHES.has(n.event_type) ? n.org_slug : null,
    close: true,
    goesSomewhere: true,
  };
}
