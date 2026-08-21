// NotificationChannel interface. Each channel implementation handles
// delivery for one transport (in-app, browser push, email, Discord,
// etc.). The dispatcher fans out to enabled channels per user.

import type {
  NotificationAction,
  NotificationChannel as ChannelName,
  NotificationPriority,
} from "../../db/schema.js";

export interface ChannelEvent {
  notificationId: string;
  orgId: string;
  userId: string;
  eventType: string;
  message: string;
  link_url: string | null;
  priority: NotificationPriority;
  /** The subscription row's `config` JSONB — channel-specific
   *  settings (Discord webhook URL, SMTP creds, Twilio SID, etc.).
   *  Drivers read what they need + log + return false if a required
   *  field is missing rather than throwing. */
  subscriptionConfig: unknown;
  // Optional structured payload — channel implementations decide
  // whether to use it (in-app stores it, email might format it).
  payload?: unknown;
  /** What the reader can DO about this, if the channel can render it. A
   *  channel that cannot MUST still deliver: the message stands alone and the
   *  link_url is the fallback route to the same place. */
  actions?: NotificationAction[] | null;
}

export interface Channel {
  readonly name: ChannelName;
  /** Deliver. Resolves true on success — caller logs which channels
   *  succeeded in `notifications.delivered_via`. */
  deliver(event: ChannelEvent): Promise<boolean>;
}
