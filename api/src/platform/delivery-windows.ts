// Delivery windows — when a message arrives, as opposed to whether it is sent.
//
// Design: docs/design-decisions/notification-delivery-windows.md
//
// The priority ladder already answers "should this channel hear about it". This
// answers "now, or with the rest". The two are deliberately separate dials:
// min_priority is per (user, event, channel) and is about relevance; a window is
// per (user, channel) and is about volume.
//
// The rule, stated once, so no module ever names a use case:
//
//     On a channel with a window, a notification at or below `normal`
//     accumulates. `high` and `urgent` interrupt immediately.
//
// A module with something genuinely time-sensitive raises its own priority — a
// knob it already has. Nothing here knows what a grocery is.
//
// TWO CADENCES, ONE CHANNEL
//
// Priority cannot separate everything people want separated. Chat and "this
// expires today" are both `normal`, so any bar that lets a reply through lets
// the expiry through with it — and the shape people ask for is Discord live all
// day for conversation AND one quiet morning list of what is due. What tells
// those apart is not urgency but what CAUSED the notification:
//
//     activity  — somebody did something. A reply, a mention, a parcel landing.
//     schedule  — a date arrived. Expiring today, service due, running low.
//
// So a window is per (person, channel, class), and `schedule` defaults to
// `inherit`: unchanged behaviour until somebody asks for the split. This is
// still not a use case — "a date arrived" is a property of the notification in
// the same way priority is.

import { Kysely, sql, type Generated } from "kysely";

/** low < normal < high < urgent. Mirrors notifications.ts; kept local so the
 *  pure half of this file has no imports to stub in a test. */
const RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Above this, a notification interrupts even a windowed channel. */
const INTERRUPT_ABOVE = RANK.normal!;

/** Channels a window may never hold back. See shouldDefer. */
const NEVER_DEFERRED = new Set(["in_app"]);

/** What caused a notification, and therefore which cadence governs it. */
export type TriggeredBy = "activity" | "schedule";

export interface DeliveryWindow {
  mode: "immediate" | "daily";
  /** Minutes past local midnight. */
  deliver_at_minute: number;
  /** IANA zone name. Shared: a person is in one place. */
  timezone: string;
  last_delivered_at: Date | null;

  /** `inherit` means dated things follow the activity cadence above, which is
   *  what every window meant before there were two. */
  schedule_mode: "inherit" | "immediate" | "daily";
  schedule_deliver_at_minute: number;
  schedule_last_delivered_at: Date | null;
}

/** One class's view of a window: the four fields the rest of this file reads.
 *
 *  Resolving `inherit` HERE, once, is the point. Every caller that asked
 *  "is it daily?" or "when did it last fire?" would otherwise have to remember
 *  which of two column sets applies, and the one that forgot would silently
 *  deliver somebody's morning brief on their chat cadence. */
export function windowFor(window: DeliveryWindow, triggeredBy: TriggeredBy): DeliveryWindow {
  if (triggeredBy === "activity" || window.schedule_mode === "inherit") return window;
  return {
    ...window,
    mode: window.schedule_mode,
    deliver_at_minute: window.schedule_deliver_at_minute,
    last_delivered_at: window.schedule_last_delivered_at,
  };
}

/**
 * Should this notification wait for the window?
 *
 * Pure, and the whole policy lives here: no window, or an urgent-enough
 * notification, goes now. Everything else accumulates.
 */
export function shouldDefer(
  window: DeliveryWindow | null | undefined,
  priority: string,
  channel?: string,
  triggeredBy: TriggeredBy = "activity",
): boolean {
  // The bell is never delayed, whatever anyone has set. A delivery window is
  // for channels that PUSH into someone's attention; in_app is a place you
  // look, and holding it back would make the product feel broken — you would
  // act on something in Discord and find the app had not heard of it.
  //
  // The design doc said this from the start ("in_app: always, unconditional")
  // and the first cut of this function did not enforce it: it deferred whatever
  // had a window row, in_app included. Worse, the e2e written against it USED
  // in_app as its windowed channel, so the test would have passed while the
  // code contradicted the design it cites.
  if (channel && NEVER_DEFERRED.has(channel)) return false;
  if (!window) return false;
  const w = windowFor(window, triggeredBy);
  if (w.mode === "immediate") return false;
  return (RANK[priority] ?? RANK.normal!) <= INTERRUPT_ABOVE;
}

/** Local minutes-past-midnight for an instant in a zone, via Intl so DST is
 *  the platform's problem rather than ours. Falls back to UTC on a bad zone
 *  name — a typo in a preference must not stop someone's mail forever. */
export function localMinuteOfDay(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

/** The local calendar day for an instant in a zone, as YYYY-MM-DD. */
export function localDay(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Is this bucket due to be flushed right now?
 *
 * Two conditions, and the second is what makes the sweeper safe to run as often
 * as we like: the window must have opened today, and we must not already have
 * delivered inside today. A tick that runs twice, or a restart mid-sweep, then
 * cannot send a second digest — which would be the exact noise this feature
 * exists to prevent, delivered by the fix for it.
 */
export function isWindowDue(
  window: DeliveryWindow,
  now: Date,
  triggeredBy: TriggeredBy = "activity",
): boolean {
  const w = windowFor(window, triggeredBy);
  // Immediate mode never DEFERS a new notification (shouldDefer returns false),
  // so a bucket is only ever "immediate + non-empty" as a leftover backlog from
  // a window that was daily when the mail queued and was then switched to
  // immediate. That backlog must go out NOW, not sit forever — the sweeper only
  // asks this for buckets that already have rows, so "immediate ⇒ due" flushes
  // the backlog and nothing else (audit M-WINDOW: daily→immediate stranded it).
  if (w.mode !== "daily") return w.mode === "immediate";
  if (localMinuteOfDay(now, w.timezone) < w.deliver_at_minute) return false;
  if (!w.last_delivered_at) return true;
  return localDay(w.last_delivered_at, w.timezone) !== localDay(now, w.timezone);
}

/** The column the sweeper stamps after flushing this class's bucket.
 *
 *  Two stamps, because the two windows open at different times: one shared
 *  stamp would let whichever fired first suppress the other for the rest of
 *  the day, and the symptom would be a morning brief that silently stops
 *  arriving for anyone who also chats. */
export function stampColumn(
  window: DeliveryWindow,
  triggeredBy: TriggeredBy,
): "last_delivered_at" | "schedule_last_delivered_at" {
  return triggeredBy === "schedule" && window.schedule_mode !== "inherit"
    ? "schedule_last_delivered_at"
    : "last_delivered_at";
}

/** One flush the sweeper should perform for a (user, channel): the deferred
 *  classes to combine into a single digest, the one column to stamp after, and
 *  whether it is due now. */
export interface FlushGroup {
  triggeredBys: TriggeredBy[];
  stampColumn: "last_delivered_at" | "schedule_last_delivered_at";
  due: boolean;
}

/**
 * Plan the flushes for a (user, channel) given which deferred classes are
 * present, grouping classes that share a window COLUMN so they flush together
 * and stamp once.
 *
 * Why grouping and not per-class: under `schedule_mode: "inherit"` (the default,
 * and what a window meant before there were two cadences) BOTH activity and
 * schedule read and stamp `last_delivered_at`. Flushing them as two independent
 * buckets let the first flush stamp the column and the second then read "already
 * delivered today" and hold until tomorrow, where the same race repeats — so one
 * class's mail, most visibly the morning brief, silently stopped arriving for
 * anyone who also chats (audit B4b). Merging inherit's classes into one flush is
 * both the fix and the faithful behaviour: inherit is one cadence, so it is one
 * message. A non-inherit schedule keeps its own column and stays a separate
 * group. A null window (no row) means everything is due now.
 */
export function planDeliveryGroups(
  window: DeliveryWindow | null,
  present: readonly TriggeredBy[],
  now: Date,
): FlushGroup[] {
  const byColumn = new Map<FlushGroup["stampColumn"], TriggeredBy[]>();
  for (const tb of present) {
    const col = window ? stampColumn(window, tb) : "last_delivered_at";
    const list = byColumn.get(col) ?? [];
    list.push(tb);
    byColumn.set(col, list);
  }
  return [...byColumn].map(([col, tbs]) => ({
    triggeredBys: tbs,
    stampColumn: col,
    // Every class in a column group resolves to the same window VIEW (that is
    // why they share a column), so any member decides dueness for the group.
    due: window ? isWindowDue(window, now, tbs[0]!) : true,
  }));
}

export interface DeferredItem {
  event_type: string;
  message: string;
  link_url: string | null;
}

/**
 * One message from a bucket.
 *
 * Deliberately plain: a count, then the lines, oldest first. A digest that tries
 * to be clever about grouping is a second place for a use case to leak in, and
 * the caller already knows nothing about what these events mean.
 */
export function composeDigest(items: DeferredItem[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!.message;
  const lines = items.map((i) => `• ${i.message}`);
  return `${items.length} updates from your workspace:\n${lines.join("\n")}`;
}

// ── storage ────────────────────────────────────────────────────────────────

interface WindowDB {
  notification_delivery_windows: {
    user_id: string;
    channel: string;
    mode: "immediate" | "daily";
    deliver_at_minute: number;
    timezone: string;
    last_delivered_at: Date | null;
    schedule_mode: "inherit" | "immediate" | "daily";
    schedule_deliver_at_minute: number;
    schedule_last_delivered_at: Date | null;
  };
  notification_deferred: {
    // Generated so an insert may omit them (the column defaults supply both).
    id: Generated<string>;
    user_id: string;
    channel: string;
    notification_id: string;
    org_id: string | null;
    event_type: string;
    message: string;
    link_url: string | null;
    priority: string;
    triggered_by: Generated<TriggeredBy>;
    queued_at: Generated<Date>;
  };
}

/** Every window this person has set, by channel. One query per dispatch, and
 *  the common case (nobody has set one) returns an empty map. */
export async function windowsFor(
  db: Kysely<WindowDB>,
  userId: string,
): Promise<Map<string, DeliveryWindow>> {
  const rows = await db
    .selectFrom("notification_delivery_windows")
    .select([
      "channel",
      "mode",
      "deliver_at_minute",
      "timezone",
      "last_delivered_at",
      "schedule_mode",
      "schedule_deliver_at_minute",
      "schedule_last_delivered_at",
    ])
    .where("user_id", "=", userId)
    .execute();
  return new Map(rows.map((r) => [r.channel, r as DeliveryWindow]));
}

export async function enqueueDeferred(
  db: Kysely<WindowDB>,
  row: Omit<WindowDB["notification_deferred"], "id" | "queued_at" | "triggered_by"> & {
    triggered_by?: TriggeredBy;
  },
): Promise<void> {
  await db.insertInto("notification_deferred").values(row).execute();
}

export { sql };
