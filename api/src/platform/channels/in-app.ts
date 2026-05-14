// In-app channel — the always-on one. The row is already in the
// notifications table by the time deliver() runs (the dispatcher
// inserts it before fanning out), so this channel's job is just to
// confirm the row is visible. For now it's a trivial success;
// real-time push to the web (SSE/WebSocket) gets layered on later.

import type { Channel, ChannelEvent } from "./types.js";

export const inAppChannel: Channel = {
  name: "in_app",
  async deliver(_event: ChannelEvent): Promise<boolean> {
    return true;
  },
};
