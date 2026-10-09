// A person's Web Push devices and settings (#5267): the account's
// Notifications page, the API and the assistant all go through these.
//
// AI-REACH: exempt for the writes below — a person's own devices and when they
// may be interrupted; the assistant reads them (GET /me/push) to answer "why
// didn't I get a notification?" and leaves the choices to the person.
import { Router } from "express";
import { z } from "zod";
import { decodeBase64urlExact } from "@cobblr/platform-contract/base64url-exact";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { isPushServiceEndpoint } from "../platform/push-endpoints.js";
import { vapidKeys } from "../platform/push-keys.js";
import { pushSettingsFor, pushToDevice, unreadCountFor } from "../platform/push-delivery.js";
import { buildPushPayload, inQuietHours, worthAPush } from "../platform/push-policy.js";
import type { NotificationPriority } from "../db/schema.js";

export const mePushRouter = Router();

const Priority = z.enum(["low", "normal", "high", "urgent"]);
const b64urlBytes = (n: number) =>
  z.string().refine((s) => decodeBase64urlExact(s)?.length === n, `must be ${n} bytes, base64url`);

const Subscribe = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: b64urlBytes(65), auth: b64urlBytes(16) }),
  label: z.string().trim().min(1).max(80).optional(),
  user_agent: z.string().max(400).optional(),
  /** Only this workspace; omitted, every workspace the person is in. */
  org_id: z.string().uuid().nullable().optional(),
});

const Settings = z
  .object({
    min_priority: Priority.optional(),
    quiet_start_minute: z.number().int().min(0).max(1439).nullable().optional(),
    quiet_end_minute: z.number().int().min(0).max(1439).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

const bad = (res: import("express").Response, status: number, code: string, message: string) =>
  void res.status(status).json({ error: { code, message } });

/** A device name a person recognises, from the browser's own description. */
export function deviceLabelFrom(userAgent: string | undefined, standalone: boolean): string {
  const ua = userAgent ?? "";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "This device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  if (standalone && (device === "iPhone" || device === "iPad")) return `${device}, Home Screen app`;
  return browser ? `${device}, ${browser}` : device;
}

// What a person's push looks like: the key a browser subscribes with, their
// devices and how each last fared, their settings, and what is held for quiet
// hours. Also the assistant's answer to "why didn't I get a notification?".
mePushRouter.get("/me/push", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const [keys, devices, settings, held] = await Promise.all([
      vapidKeys(),
      meta
        .selectFrom("push_subscriptions")
        .select(["id", "org_id", "label", "created_at", "last_success_at", "last_failure_at", "last_failure", "failures_in_a_row"])
        .where("user_id", "=", userId)
        .orderBy("created_at", "asc")
        .execute(),
      pushSettingsFor(userId),
      meta
        .selectFrom("notification_deferred")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("user_id", "=", userId)
        .where("channel", "=", "browser_push")
        .executeTakeFirst(),
    ]);
    res.json({
      public_key: keys?.publicKey ?? null,
      devices,
      settings,
      quiet_now: inQuietHours(settings, new Date()),
      held: Number(held?.n ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — a browser subscribing itself; only the device can.
mePushRouter.post("/me/push/devices", requireAuth, async (req, res, next) => {
  try {
    const parsed = Subscribe.safeParse(req.body);
    if (!parsed.success) return bad(res, 400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    if (!isPushServiceEndpoint(b.endpoint)) {
      return bad(res, 400, "not_a_push_service", "That address is not a browser's push service, so nothing sent there would reach a device.");
    }
    const userId = req.session!.id;
    if (b.org_id) {
      const member = await meta.selectFrom("org_memberships").select("org_id").where("org_id", "=", b.org_id).where("user_id", "=", userId).executeTakeFirst();
      if (!member) return bad(res, 404, "not_found", "No such workspace");
    }
    const label = b.label ?? deviceLabelFrom(b.user_agent ?? req.get("user-agent"), false);
    // One row per endpoint: a browser that subscribes again (a new key, a new
    // person signed in on it) takes its row over rather than doubling pushes.
    const row = await meta
      .insertInto("push_subscriptions")
      .values({ user_id: userId, org_id: b.org_id ?? null, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, label, user_agent: b.user_agent ?? null })
      .onConflict((oc) =>
        oc.column("endpoint").doUpdateSet({
          user_id: userId,
          org_id: b.org_id ?? null,
          p256dh: b.keys.p256dh,
          auth: b.keys.auth,
          label,
          user_agent: b.user_agent ?? null,
          failures_in_a_row: 0,
          last_failure: null,
        }),
      )
      .returning(["id", "label"])
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — removing one of a person's own devices.
mePushRouter.delete("/me/push/devices/:id", requireAuth, async (req, res, next) => {
  try {
    const gone = await meta
      .deleteFrom("push_subscriptions")
      .where("id", "=", String(req.params.id))
      .where("user_id", "=", req.session!.id)
      .executeTakeFirst();
    if (!Number(gone.numDeletedRows)) return bad(res, 404, "not_found", "No such device");
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — a test push to the person's own device, which proves the
// whole path: the key, the push service, the device and its permission.
mePushRouter.post("/me/push/devices/:id/test", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const device = await meta
      .selectFrom("push_subscriptions")
      .select(["id", "user_id", "org_id", "endpoint", "p256dh", "auth", "label"])
      .where("id", "=", String(req.params.id))
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!device) return bad(res, 404, "not_found", "No such device");
    const payload = buildPushPayload({
      notificationId: `test-${Date.now()}`,
      eventType: "test.notification",
      message: `A test from Cobblr to ${device.label}. Notifications reach this device.`,
      // PAGE-LINK: a test push is about the device, not a record; it opens the page that lists it
      link_url: "/me/communication",
      priority: "high",
      title: "Cobblr",
      unread: await unreadCountFor(userId),
    });
    // The outcome is the answer, whichever it is: "failed" with its reason is
    // what the person (or the assistant) needs to read, not an error.
    res.json(await pushToDevice(device, payload, "high"));
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — a personal delivery preference. An agent has no business
// deciding when someone may be interrupted.
mePushRouter.put("/me/push/settings", requireAuth, async (req, res, next) => {
  try {
    const parsed = Settings.safeParse(req.body);
    if (!parsed.success) return bad(res, 400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = parsed.data;
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: b.timezone });
      } catch {
        return bad(res, 400, "bad_timezone", `Unknown timezone: ${b.timezone}`);
      }
    }
    const userId = req.session!.id;
    const current = await pushSettingsFor(userId);
    const next_ = { ...current, ...b, user_id: userId };
    await meta
      .insertInto("push_settings")
      .values({ ...next_, updated_at: new Date() })
      .onConflict((oc) => oc.column("user_id").doUpdateSet({ ...b, updated_at: new Date() }))
      .execute();
    res.json({ ...current, ...b });
  } catch (err) {
    next(err);
  }
});

/** For a person's settings page: would this priority buzz their phone now? */
export function pushVerdict(priority: NotificationPriority, settings: Awaited<ReturnType<typeof pushSettingsFor>>, now: Date): "pushed" | "held" | "bell only" {
  if (!worthAPush(priority, settings)) return "bell only";
  return priority !== "urgent" && inQuietHours(settings, now) ? "held" : "pushed";
}

// The same, from inside a workspace: the assistant's door (it reaches only
// workspace routes). It adds what a "why didn't I get a notification?" needs
// that is about this workspace: whether this workspace sets its own push
// threshold for the person, and what its latest notifications to them were
// sent by.
export const mePushOrgRouter = Router();

mePushOrgRouter.get("/:slug/my-push", requireAuth, withTenant, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const orgId = req.tenant!.org.id;
    const [keys, devices, settings, held, binding, recent] = await Promise.all([
      vapidKeys(),
      meta
        .selectFrom("push_subscriptions")
        .select(["id", "org_id", "label", "created_at", "last_success_at", "last_failure_at", "last_failure", "failures_in_a_row"])
        .where("user_id", "=", userId)
        .where((eb) => eb.or([eb("org_id", "is", null), eb("org_id", "=", orgId)]))
        .orderBy("created_at", "asc")
        .execute(),
      pushSettingsFor(userId),
      meta
        .selectFrom("notification_deferred")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("user_id", "=", userId)
        .where("channel", "=", "browser_push")
        .executeTakeFirst(),
      meta
        .selectFrom("notification_subscriptions")
        .select(["event_type", "enabled", "min_priority"])
        .where("user_id", "=", userId)
        .where("org_id", "=", orgId)
        .where("channel", "=", "browser_push")
        .execute(),
      meta
        .selectFrom("notifications")
        .select(["created_at", "event_type", "priority", "delivered_via"])
        .where("user_id", "=", userId)
        .where("org_id", "=", orgId)
        .orderBy("created_at", "desc")
        .limit(10)
        .execute(),
    ]);
    res.json({
      push_ready_on_server: !!keys,
      devices,
      settings,
      quiet_now: inQuietHours(settings, new Date()),
      held: Number(held?.n ?? 0),
      // A binding here decides for this workspace instead of the account's threshold.
      workspace_bindings: binding,
      recent: recent.map((n) => ({
        when: n.created_at,
        kind: n.event_type,
        priority: n.priority,
        sent_by: n.delivered_via ?? [],
        // What the push rules would do with it now, for the answer's "because".
        push_now: pushVerdict(n.priority, settings, new Date()),
      })),
    });
  } catch (err) {
    next(err);
  }
});
