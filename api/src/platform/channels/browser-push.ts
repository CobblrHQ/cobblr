// Browser push (#5267): Web Push to each device a person turned notifications
// on for, the iPhone and iPad Home Screen app included. A device is found by
// the person, never by a subscription's config: the delivery sweeper flushes
// a held push with no config at all.
//
// What a push carries is decided in push-policy.ts (a title, one line, the
// link, the badge; never a card or a private notification's words); how it is
// sent, retried and written down is push-delivery.ts.
import { meta } from "../../db/meta.js";
import { buildPushPayload } from "../push-policy.js";
import { pushDevicesFor, pushToDevices, unreadCountFor } from "../push-delivery.js";
import type { Channel, ChannelEvent } from "./types.js";
import { productName } from "../product-name.js";

async function workspaceName(orgId: string): Promise<string> {
  if (!orgId) return productName();
  const row = await meta.selectFrom("orgs").select("name").where("id", "=", orgId).executeTakeFirst();
  return row?.name ?? productName();
}

export const browserPushChannel: Channel = {
  name: "browser_push",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const devices = await pushDevicesFor(event.userId, event.orgId || null);
    if (devices.length === 0) return false;
    const digestCount = (event.payload as { digest_count?: number } | null | undefined)?.digest_count;
    const payload = buildPushPayload({
      notificationId: event.notificationId,
      eventType: event.eventType,
      message: event.message,
      link_url: event.link_url,
      priority: event.priority,
      private: event.private === true,
      title: await workspaceName(event.orgId),
      unread: await unreadCountFor(event.userId),
      digestCount,
    });
    const outcomes = await pushToDevices(devices, payload, event.priority);
    return outcomes.some((o) => o.outcome === "sent");
  },
};
