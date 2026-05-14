// NotificationChannel interface. Each channel implementation handles
// delivery for one transport (in-app, browser push, email, Discord,
// etc.). The dispatcher fans out to enabled channels per user.

import type { NotificationChannel as ChannelName } from "../../db/schema.js";

export interface ChannelEvent {
  notificationId: string;
  orgId: string;
  userId: string;
  eventType: string;
  message: string;
  link_url: string | null;
  // Optional structured payload — channel implementations decide
  // whether to use it (in-app stores it, email might format it).
  payload?: unknown;
}

export interface Channel {
  readonly name: ChannelName;
  /** Deliver. Resolves true on success — caller logs which channels
   *  succeeded in `notifications.delivered_via`. */
  deliver(event: ChannelEvent): Promise<boolean>;
}
