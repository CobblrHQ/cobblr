// The assistant's (and any action caller's) door to a person's own push
// devices (#5267): send a test, or remove one. Each finds the device by the
// caller, so nobody reaches another person's devices. The person's settings
// page does the same through /me/push.
import type { ActionInvokeContext } from "@cobblr/platform-contract";
import { registerHandler } from "./actions.js";
import { meta } from "../db/meta.js";
import { buildPushPayload } from "./push-policy.js";
import { pushToDevice, unreadCountFor } from "./push-delivery.js";
import { productName } from "./product-name.js";

const deviceIdOf = (ctx: ActionInvokeContext): string => String(((ctx.args ?? {}) as { device_id?: unknown }).device_id ?? "").trim();

async function ownDevice(ctx: ActionInvokeContext) {
  const id = deviceIdOf(ctx);
  if (!ctx.userId) return { error: "a device is a person's own; this ran as nobody" } as const;
  if (!id) return { error: "device_id is required" } as const;
  const device = await meta
    .selectFrom("push_subscriptions")
    .select(["id", "user_id", "org_id", "endpoint", "p256dh", "auth", "label"])
    .where("id", "=", id)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  return device ? ({ device } as const) : ({ error: "No such device of yours" } as const);
}

export function registerPushDeviceHandlers(): void {
  registerHandler("platform.test-push-device", async (ctx: ActionInvokeContext) => {
    const found = await ownDevice(ctx);
    if ("error" in found) return { ok: false, error: found.error };
    const { device } = found;
    const org = await meta.selectFrom("orgs").select("name").where("id", "=", ctx.orgId).executeTakeFirst();
    const payload = buildPushPayload({
      notificationId: `test-${Date.now()}`,
      eventType: "test.notification",
      message: `A test from ${productName()} to ${device.label}. Notifications reach this device.`,
      // PAGE-LINK: a test push is about the device, not a record; it opens the page that lists it
      link_url: "/me/communication",
      priority: "high",
      title: org?.name ?? productName(),
      unread: await unreadCountFor(device.user_id),
    });
    const outcome = await pushToDevice(device, payload, "high");
    if (outcome.outcome === "sent") return { ok: true, summary: `Sent a test to ${device.label}.`, data: outcome };
    if (outcome.outcome === "gone") return { ok: false, error: `${device.label} is no longer subscribed, so it was removed. Turn notifications on there again.` };
    return { ok: false, error: `${device.label}: ${outcome.reason ?? "not delivered"}` };
  });

  registerHandler("platform.remove-push-device", async (ctx: ActionInvokeContext) => {
    const found = await ownDevice(ctx);
    if ("error" in found) return { ok: false, error: found.error };
    await meta.deleteFrom("push_subscriptions").where("id", "=", found.device.id).where("user_id", "=", found.device.user_id).execute();
    return { ok: true, summary: `${found.device.label} no longer gets notifications from ${productName()}.` };
  });
}
