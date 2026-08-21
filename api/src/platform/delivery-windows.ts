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

import { Kysely, sql, type Generated } from "kysely";

/** low < normal < high < urgent. Mirrors notifications.ts; kept local so the
 *  pure half of this file has no imports to stub in a test. */
const RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Above this, a notification interrupts even a windowed channel. */
const INTERRUPT_ABOVE = RANK.normal!;

/** Channels a window may never hold back. See shouldDefer. */
const NEVER_DEFERRED = new Set(["in_app"]);

export interface DeliveryWindow {
  mode: "immediate" | "daily";
  /** Minutes past local midnight. */
  deliver_at_minute: number;
  /** IANA zone name. */
  timezone: string;
  last_delivered_at: Date | null;
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
  if (!window || window.mode === "immediate") return false;
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
export function isWindowDue(window: DeliveryWindow, now: Date): boolean {
  if (window.mode !== "daily") return false;
  if (localMinuteOfDay(now, window.timezone) < window.deliver_at_minute) return false;
  if (!window.last_delivered_at) return true;
  return localDay(window.last_delivered_at, window.timezone) !== localDay(now, window.timezone);
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
    .select(["channel", "mode", "deliver_at_minute", "timezone", "last_delivered_at"])
    .where("user_id", "=", userId)
    .execute();
  return new Map(rows.map((r) => [r.channel, r as DeliveryWindow]));
}

export async function enqueueDeferred(
  db: Kysely<WindowDB>,
  row: Omit<WindowDB["notification_deferred"], "id" | "queued_at">,
): Promise<void> {
  await db.insertInto("notification_deferred").values(row).execute();
}

export { sql };
