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
  /** The substance behind the one-line message, when there is any, for a
   *  channel that can render more than a sentence.
   *
   *  A mention DM that says only "X mentioned you in Y" makes the reader open
   *  the app to find out what was actually said - which is the opposite of what
   *  a notification is for. A channel that cannot render this MUST still
   *  deliver: `message` stands alone and `link_url` reaches the same place. */
  card?: NotificationCard | null;
  /** The message and card carry a person's private content (a personal
   *  document, a secret field). A channel whose message leaves Cobblr and can
   *  be read off a lock screen (browser push) shows a generic line and the
   *  link instead. */
  private?: boolean;
}

/** Deliberately not Discord's embed shape. Channels own their own rendering,
 *  and a contract that spoke embeds would make every other channel translate
 *  out of a vocabulary it does not share. */
export interface NotificationCard {
  /** The thing being reported, e.g. a record or workspace name. */
  heading?: string;
  /** What was said or changed. Rendered as the body. */
  body?: string;
  /** Small print - who, where, when. */
  context?: string;
  /** The body as lines with the actions that are about each (see the
   *  contract's NotificationCardRow); `body` stands alone without it. */
  rows?: Array<{ text: string; actions?: string[]; settled?: { label: string; at: string | null } }>;
}

export interface Channel {
  readonly name: ChannelName;
  /** Set when nothing sent through this channel would arrive (it is not
   *  built yet): the reason, and the channel is then not offered to bind.
   *  A channel a person can pick must be one that delivers. */
  readonly notOffered?: string;
  /** What one digest gathers when this channel's window flushes (#6907).
   *  "person" (the default): one message across every workspace, right for
   *  email, which a person reads as one inbox. "workspace": one message per
   *  workspace, naming it and linking into it, right for a chat card that can
   *  only open one place. Declared here, never branched in the sweeper. */
  readonly digestScope?: "person" | "workspace";
  /** Deliver. Resolves true on success — caller logs which channels
   *  succeeded in `notifications.delivered_via`. */
  deliver(event: ChannelEvent): Promise<boolean>;
}
