// Sending Web Push to a person's devices (#5267): the store of their
// subscriptions and settings, the send with its retries, and the bookkeeping a
// person (or Cobb, asked "why didn't I get a notification?") reads back.
import { meta } from "../db/meta.js";
import type { NotificationPriority } from "../db/schema.js";
import { isPushServiceEndpoint, isTestPushService } from "./push-endpoints.js";
import { selfFetch } from "./self-fetch.js";
import { vapidKeyState, vapidSubject } from "./push-keys.js";
import { DEFAULT_PUSH_SETTINGS, pushTtlSec, pushUrgency, type PushPayload, type PushSettings } from "./push-policy.js";
import { sendPush, type PushSendResult } from "./web-push.js";

export interface PushDevice {
  id: string;
  user_id: string;
  org_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
}

/** A person's push settings, or the defaults when they never changed them. */
export async function pushSettingsFor(userId: string): Promise<PushSettings> {
  const row = await meta
    .selectFrom("push_settings")
    .select(["min_priority", "quiet_start_minute", "quiet_end_minute", "timezone"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row ?? DEFAULT_PUSH_SETTINGS;
}

/** The devices that take pushes for this person about this workspace (a
 *  device turned on for every workspace, or for this one). */
export async function pushDevicesFor(userId: string, orgId?: string | null): Promise<PushDevice[]> {
  let q = meta
    .selectFrom("push_subscriptions")
    .select(["id", "user_id", "org_id", "endpoint", "p256dh", "auth", "label"])
    .where("user_id", "=", userId);
  if (orgId) q = q.where((eb) => eb.or([eb("org_id", "is", null), eb("org_id", "=", orgId)]));
  return q.execute();
}

/** Why a device did not get a push, in a person's words. */
function failureReason(r: PushSendResult | null, err: unknown): string {
  if (err) return `could not reach the push service (${(err as Error).message ?? String(err)})`.slice(0, 200);
  if (!r) return "not sent";
  if (r.status === 401 || r.status === 403) return "the push service refused this server's signature";
  if (r.status === 413) return "the message was too large for the push service";
  if (r.status === 429) return "the push service asked to slow down";
  return `the push service answered ${r.status}${r.detail ? `: ${r.detail}` : ""}`.slice(0, 200);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeviceOutcome {
  deviceId: string;
  label: string;
  outcome: "sent" | "gone" | "failed";
  reason?: string;
}

/** Send one push to one device: retried with backoff when the push service is
 *  busy (429, 5xx), deleted when it says the subscription is gone (404, 410),
 *  and the outcome written on the device either way. */
export async function pushToDevice(
  device: PushDevice,
  payload: PushPayload,
  priority: NotificationPriority,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<DeviceOutcome> {
  const { keys: vapid, unavailable } = await vapidKeyState();
  const base = { deviceId: device.id, label: device.label };
  if (!vapid) return { ...base, outcome: "failed", reason: unavailable };
  if (!isPushServiceEndpoint(device.endpoint)) {
    await meta.deleteFrom("push_subscriptions").where("id", "=", device.id).execute();
    return { ...base, outcome: "gone", reason: "its address is not a push service" };
  }
  const retries = opts.retries ?? 2;
  let last: PushSendResult | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    lastErr = null;
    try {
      last = await sendPush(device, payload, {
        vapid,
        subject: vapidSubject(),
        ttlSec: pushTtlSec(priority),
        urgency: pushUrgency(priority),
        // The CI push service is this api: in-process, as every call to itself is.
        ...(isTestPushService(device.endpoint) ? { fetchImpl: selfFetch as typeof fetch } : {}),
      });
    } catch (err) {
      last = null;
      lastErr = err;
    }
    if (last && last.status >= 200 && last.status < 300) {
      await meta
        .updateTable("push_subscriptions")
        .set({ last_success_at: new Date(), failures_in_a_row: 0 })
        .where("id", "=", device.id)
        .execute();
      return { ...base, outcome: "sent" };
    }
    if (last && (last.status === 404 || last.status === 410)) {
      // The browser unsubscribed, the app was removed, or the subscription
      // expired: it will never take a push again.
      await meta.deleteFrom("push_subscriptions").where("id", "=", device.id).execute();
      return { ...base, outcome: "gone", reason: "the device is no longer subscribed" };
    }
    const busy = lastErr != null || (last != null && (last.status === 429 || last.status >= 500));
    if (!busy || attempt === retries) break;
    const backoff = (opts.backoffMs ?? 1000) * 2 ** attempt;
    await wait(Math.min(last?.retryAfterSec != null ? last.retryAfterSec * 1000 : backoff, 30_000));
  }
  const reason = failureReason(last, lastErr);
  await meta
    .updateTable("push_subscriptions")
    .set((eb) => ({ last_failure_at: new Date(), last_failure: reason, failures_in_a_row: eb("failures_in_a_row", "+", 1) }))
    .where("id", "=", device.id)
    .execute();
  return { ...base, outcome: "failed", reason };
}

/** Send one push to each of these devices, once each. */
export async function pushToDevices(devices: PushDevice[], payload: PushPayload, priority: NotificationPriority): Promise<DeviceOutcome[]> {
  return Promise.all(devices.map((d) => pushToDevice(d, payload, priority)));
}

/** The person's unread count across every workspace, for the Home Screen
 *  badge. Null when it cannot be read: a push without a badge beats none. */
export async function unreadCountFor(userId: string): Promise<number | null> {
  try {
    const row = await meta
      .selectFrom("notifications")
      .innerJoin("org_memberships", (j) => j.onRef("org_memberships.org_id", "=", "notifications.org_id").onRef("org_memberships.user_id", "=", "notifications.user_id"))
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("notifications.user_id", "=", userId)
      .where("notifications.read_at", "is", null)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}
