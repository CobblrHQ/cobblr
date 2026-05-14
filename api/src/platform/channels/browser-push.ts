// Browser push channel — stub. Architecture is in place so a real
// web-push implementation can drop in without dispatcher changes.
// Full impl needs:
//   - VAPID keys in env
//   - PushSubscription rows on the user (endpoint, p256dh, auth)
//   - web-push npm package + signed JWT to the push service
//
// For Phase 0 we log and return false (not delivered) so it doesn't
// silently lie about success.

import type { Channel, ChannelEvent } from "./types.js";

export const browserPushChannel: Channel = {
  name: "browser_push",
  async deliver(event: ChannelEvent): Promise<boolean> {
    console.log(`[browser-push] would push notification ${event.notificationId} (not implemented)`);
    return false;
  },
};
