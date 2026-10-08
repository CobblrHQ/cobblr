// What Web Push sends, and when (#5267). Pure: every rule a person would
// notice is here, so a test can hold it without a database.
//
// A push leaves the instance: it crosses a browser vendor's push service and
// lands on a lock screen anyone near the phone can read. So a push carries a
// short title and one line, from a fixed list of fields (PUSH_PAYLOAD_FIELDS),
// and a notification marked private (a personal document, a secret field,
// #5243) carries a generic line and the link, never its words.
import type { NotificationPriority } from "../db/schema.js";
import type { PushUrgency } from "./web-push.js";
import { localMinuteOfDay } from "./delivery-windows.js";

import { countOf } from "@cobblr/platform-contract/plural";
const RANK: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** A new device's threshold: the phone buzzes for what is actionable, and the
 *  bell keeps the rest (the owner's standing rule). */
export const DEFAULT_PUSH_MIN_PRIORITY: NotificationPriority = "high";

export interface PushSettings {
  min_priority: NotificationPriority;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  timezone: string;
}

export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  min_priority: DEFAULT_PUSH_MIN_PRIORITY,
  quiet_start_minute: null,
  quiet_end_minute: null,
  timezone: "UTC",
};

/** Is this notification worth a push, for this person? */
export function worthAPush(priority: NotificationPriority, settings: Pick<PushSettings, "min_priority">): boolean {
  return RANK[priority] >= RANK[settings.min_priority];
}

/** Is it quiet hours for this person right now? A range may cross midnight
 *  (22:00 to 07:00); equal ends, or either unset, means no quiet hours. */
export function inQuietHours(settings: PushSettings, now: Date): boolean {
  const { quiet_start_minute: start, quiet_end_minute: end } = settings;
  if (start == null || end == null || start === end) return false;
  const m = localMinuteOfDay(now, settings.timezone);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** Quiet hours hold everything but urgent until they end. */
export function heldForQuietHours(priority: NotificationPriority, settings: PushSettings, now: Date): boolean {
  return priority !== "urgent" && inQuietHours(settings, now);
}

/** RFC 8030 Urgency from the notification's priority: how hard the push
 *  service may try to wake a sleeping phone. */
export function pushUrgency(priority: NotificationPriority): PushUrgency {
  return priority === "urgent" ? "high" : priority === "high" ? "normal" : "low";
}

/** How long a push service keeps trying a device that is off: an urgent one
 *  is worth a day, an ordinary one is stale by the evening. */
export function pushTtlSec(priority: NotificationPriority): number {
  return priority === "urgent" || priority === "high" ? 24 * 60 * 60 : 4 * 60 * 60;
}

/** The fields a push carries, and no others. A test holds the builder to it. */
export const PUSH_PAYLOAD_FIELDS = ["id", "title", "body", "url", "tag", "badge", "priority"] as const;
export type PushPayload = { [K in (typeof PUSH_PAYLOAD_FIELDS)[number]]: K extends "badge" ? number | null : string };

/** The line a private notification shows instead of its own words. */
export function privatePushLine(eventType: string): string {
  return /document|vault/i.test(eventType) ? "A document needs your review" : "Something needs your attention in Cobblr";
}

const BODY_MAX = 180;
const oneLine = (s: string): string => {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line;
};

/** A relative link inside the app, or the app's home: a push never opens
 *  another site. */
function inAppLink(link: string | null): string {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : "/";
}

export interface PushSource {
  notificationId: string;
  eventType: string;
  message: string;
  link_url: string | null;
  priority: NotificationPriority;
  /** The notification carries a person's private content. */
  private?: boolean;
  /** Who it is from, shown as the title: the workspace's name. */
  title: string;
  /** The person's unread count, for the Home Screen badge. */
  unread: number | null;
  /** A digest of several: one push, no single link. */
  digestCount?: number;
}

/** The push a device shows: built only from the fields above, whatever the
 *  notification also carries (a card, a payload, actions stay home). */
export function buildPushPayload(src: PushSource): PushPayload {
  const digest = (src.digestCount ?? 1) > 1;
  return {
    id: src.notificationId,
    title: src.title || "Cobblr",
    body: src.private ? privatePushLine(src.eventType) : digest ? oneLine(`${countOf(src.digestCount ?? 0, "update")} while you were away`) : oneLine(src.message),
    url: digest ? "/" : inAppLink(src.link_url),
    // Collapses a repeat of the same notification into one on the device.
    tag: digest ? "cobblr-digest" : `cobblr-${src.notificationId}`,
    badge: src.unread,
    priority: src.priority,
  };
}
