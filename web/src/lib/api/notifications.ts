import { browserTimeZone, request } from "./client";

/** When a channel's messages arrive, per person.
 *
 *  Two cadences, because chat and "expires today" are both priority `normal`
 *  and people want them on different rhythms: conversation as it happens,
 *  everything due today as one morning list. `schedule_mode: "inherit"` means
 *  one cadence for both, which is what a window meant before the split. */
export interface DeliveryWindowRow {
  channel: string;
  mode: "immediate" | "daily";
  deliver_at_minute: number;
  timezone: string;
  last_delivered_at: string | null;
  schedule_mode: "inherit" | "immediate" | "daily";
  schedule_deliver_at_minute: number;
  schedule_last_delivered_at: string | null;
  pending_count: number;
  pending_activity: number;
  pending_schedule: number;
}

export type NotificationDefaultChannel = "email" | "discord_dm" | "browser_push";
export interface NotificationDefaults {
  urgent: NotificationDefaultChannel | null;
  high: NotificationDefaultChannel | null;
  channels?: Record<NotificationDefaultChannel, string>;
}

export interface NotificationEntry {
  id: string;
  event_type: string;
  module_name: string | null;
  message: string;
  link_url: string | null;
  /** The substance behind the one-liner, when there is any — the same card a
   *  Discord DM renders as an embed. Absent for most notifications. */
  card?: { heading?: string; body?: string; context?: string; rows?: Array<{ text: string; actions?: string[] }> } | null;
  /** Pressable things this notification offers — "Mark done", "Accept", "Move
   *  it". Declared at dispatch; what a press DOES is a platform action, so the
   *  bell needs no per-notification code to render one. */
  actions?: Array<{ id: string; label: string; short?: string; style?: "primary" | "secondary" | "danger" }> | null;
  /** The thing the buttons decide has been decided, read from ITS record on
   *  every inbox read: how, and when. The buttons are gone. */
  settled?: { label: string; at: string | null } | null;
  read_at: string | null;
  created_at: string;
}

export interface CrossOrgNotificationEntry extends NotificationEntry {
  org_id: string;
  org_name: string;
  org_slug: string;
  /** Its kind in words ("Print failed"), or null when nobody named it. */
  label?: string | null;
}

/** A kind of notification a workspace can send, by name. */
export interface NotificationKindEntry {
  event_type: string;
  label: string;
  description: string | null;
  module: string;
  /** What a picker titles its set with: the module's name, never its id. */
  group: string;
}

export type NotificationPriority = "low" | "normal" | "high" | "urgent";

export type NotificationChannelName =
  | "in_app"
  | "browser_push"
  | "email"
  | "discord"
  /** A DM to your own verified Discord account, as opposed to `discord`, which
   *  posts to a server channel via a webhook. No config: the destination is
   *  your linked identity. */
  | "discord_dm"
  | "webhook"
  | "slack"
  | "sms";

/** A row from notification_subscriptions, as returned by GET
 *  /me/notification-channels. `config` may contain `<set>` strings
 *  in place of secret values (webhook URLs, SMTP passwords, Twilio
 *  auth tokens) — the API redacts those on read. */
export interface NotificationChannelBinding {
  id: string;
  event_type: string;
  channel: NotificationChannelName;
  enabled: boolean;
  min_priority: NotificationPriority;
  config: Record<string, unknown> | null;
}

export interface NotificationChannelUpsert {
  org_id: string;
  event_type: string;
  channel: NotificationChannelName;
  enabled?: boolean;
  min_priority?: NotificationPriority;
  config?: Record<string, unknown>;
}

/** The account-level Communication Preferences matrix (Feature 1), as returned
 *  by GET /me/communication-prefs. `prefs[type][channel]` is the effective
 *  enablement (defaults already applied). Tier-1 types are shown locked. */
export interface CommunicationPrefs {
  channels: Array<"in_app" | "discord_dm" | "email">;
  discord_verified: boolean;
  types: Array<{ key: string; label: string; description: string; tier: 1 | 2 }>;
  prefs: Record<string, Record<string, boolean>>;
}

export type NotificationAudienceMode = "all" | "owners" | "custom";
/** One kind of workspace notification and who it is for. */
export interface NotificationAudienceKind {
  event_type: string;
  label: string;
  description: string | null;
  module: string;
  mode: NotificationAudienceMode;
  user_ids: string[];
}

/** A person's push settings across their devices (#5267). */
export interface MePushSettings {
  min_priority: NotificationPriority;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  timezone: string;
}

/** One device that takes Web Push for this person. */
export interface MePushDevice {
  id: string;
  org_id: string | null;
  label: string;
  created_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
  failures_in_a_row: number;
  /** Nothing has ever been delivered to it: "on" is not yet "working". */
  never_delivered?: boolean;
}

/** One of a person's other channels still carrying their workspace updates. */
export interface MePushOtherChannel {
  channel: string;
  label: string;
  from: NotificationPriority;
  daily: boolean;
}

/** The "turn the others off?" prompt after push is turned on (#7070). */
export interface MePushHandoff {
  due: boolean;
  channels: MePushOtherChannel[];
  normal_pushes: boolean;
}

export interface MePush {
  /** The key a browser subscribes with; null until the server has made it. */
  public_key: string | null;
  /** Why there is no key to subscribe with, in words to show; null when there is one. */
  unavailable?: string | null;
  devices: MePushDevice[];
  settings: MePushSettings;
  quiet_now: boolean;
  held: number;
  handoff?: MePushHandoff;
  /** Channels the person turned off for their workspace updates. */
  channels_off?: Array<{ channel: string; label: string }>;
  /** Per priority, where a workspace update goes now. */
  by_priority?: Array<{ priority: NotificationPriority; push: "pushed" | "held" | "bell only"; also: string[] }>;
}

export const notificationsApi = {
  /** How members who have not chosen hear the workspace's urgent and high events (#6909). */
  notificationDefaults: (slug: string) => request<NotificationDefaults>("GET", `/orgs/${slug}/notification-defaults`),
  setNotificationDefault: (slug: string, priority: "urgent" | "high", channel: NotificationDefaultChannel | null) =>
    request<NotificationDefaults>("PUT", `/orgs/${slug}/notification-defaults/${priority}`, { channel }),
  /** Who each kind of workspace notification is for (owner/admin). */
  listNotificationAudiences: (slug: string) =>
    request<{ items: NotificationAudienceKind[] }>("GET", `/orgs/${slug}/notification-audiences`),
  setNotificationAudience: (
    slug: string,
    eventType: string,
    body: { mode: NotificationAudienceMode; user_ids?: string[] },
  ) =>
    request<{ item: NotificationAudienceKind | null }>(
      "PUT",
      `/orgs/${slug}/notification-audiences/${encodeURIComponent(eventType)}`,
      body,
    ),
  /** Say no. The other half of acceptInvite: it records the answer instead of
   *  leaving the invite to expire in silence, and creates no membership. */
  /** Press a button a notification offered. One endpoint for every kind of
   *  notification: what the button does is declared at dispatch, not here. */
  pressNotificationAction: (id: string, actionId: string) =>
    request<{ ok: true; label: string }>(
      "POST",
      `/me/notifications/${id}/actions/${encodeURIComponent(actionId)}`,
    ),

  // Notifications — per-org variants (still used by some pages).
  notifications: (slug: string, limit = 25) =>
    request<{ items: NotificationEntry[] }>(
      "GET",
      `/orgs/${slug}/notifications?limit=${limit}`,
    ),
  notificationsUnreadCount: (slug: string) =>
    request<{ count: number }>("GET", `/orgs/${slug}/notifications/unread-count`),
  markNotificationRead: (slug: string, id: string) =>
    request<void>("POST", `/orgs/${slug}/notifications/${id}/read`),
  markAllNotificationsRead: (slug: string) =>
    request<{ marked: number }>("POST", `/orgs/${slug}/notifications/read-all`),

  meNotifications: (limit = 25, opts: { before?: string; org?: string; unread?: boolean } = {}) =>
    request<{ items: CrossOrgNotificationEntry[]; next_cursor?: string | null }>(
      "GET",
      `/me/notifications?${new URLSearchParams({
        limit: String(limit),
        ...(opts.before ? { before: opts.before } : {}),
        ...(opts.org ? { org: opts.org } : {}),
        ...(opts.unread ? { unread: "1" } : {}),
      }).toString()}`,
    ),
  meNotificationsUnreadCount: () =>
    request<{ count: number }>("GET", "/me/notifications/unread-count"),
  meMarkNotificationRead: (id: string) =>
    request<void>("POST", `/me/notifications/${id}/read`),
  meMarkAllNotificationsRead: () =>
    request<{ count: number }>("POST", "/me/notifications/read-all"),
  meNotificationStreamTicket: () => request<{ ticket: string }>("POST", "/me/notifications/stream-ticket"),
  meNotificationKinds: (orgId: string) =>
    request<{ items: NotificationKindEntry[] }>("GET", `/me/notification-kinds?org_id=${encodeURIComponent(orgId)}`),
  meMarkNotificationUnread: (id: string) =>
    request<void>("POST", `/me/notifications/${id}/unread`),
  meDeleteNotification: (id: string) =>
    request<void>("DELETE", `/me/notifications/${id}`),
  meClearReadNotifications: () =>
    request<{ count: number }>("POST", "/me/notifications/clear-read"),

  // ─── Notification channel bindings ────────────────────────────────
  meNotificationChannels: (orgId: string) =>
    request<{ items: NotificationChannelBinding[] }>(
      "GET",
      `/me/notification-channels?org_id=${encodeURIComponent(orgId)}`,
    ),
  upsertMeNotificationChannel: (body: NotificationChannelUpsert) =>
    request<NotificationChannelBinding>(
      "POST",
      `/me/notification-channels`,
      body,
    ),
  deleteMeNotificationChannel: (id: string) =>
    request<void>("DELETE", `/me/notification-channels/${id}`),
  selfTestNotification: (orgId: string) =>
    request<{ notificationId: string; deliveredVia: string[] }>("POST", "/me/notifications/self-test", { org_id: orgId }),
  testMeNotificationChannel: (body: { org_id: string; priority?: NotificationPriority }) =>
    request<{ notificationId: string; deliveredVia: string[] }>(
      "POST",
      `/me/notification-channels/test`,
      body,
    ),
  testOneMeNotificationChannel: (
    id: string,
    body: { priority?: NotificationPriority } = {},
  ) =>
    request<{ deliveredVia: string[] }>(
      "POST",
      `/me/notification-channels/${id}/test`,
      body,
    ),

  // ─── Discord connection (Feature 1) ───────────────────────────────
  meDiscordStatus: () =>
    request<{ configured: boolean; connected: boolean; verified: boolean; needs_reverify?: boolean; username: string | null; invite_url: string | null }>(
      "GET",
      "/me/discord",
    ),
  // The browser's zone rides along, so the morning digest the connection
  // starts with is at 08:00 where the person is (me.ts oauth-start).
  meDiscordOAuthStart: () =>
    request<{ url: string }>("POST", "/me/discord/oauth-start", { timezone: browserTimeZone() ?? undefined }),
  meDiscordRetryTest: () =>
    request<{ deliverable: boolean }>("POST", "/me/discord/retry-test"),
  meDiscordConfirm: () =>
    request<{ ok: boolean; verified: boolean }>("POST", "/me/discord/confirm"),
  meDiscordDisconnect: () =>
    request<void>("DELETE", "/me/discord"),
  meCommunicationPrefs: () =>
    request<CommunicationPrefs>("GET", "/me/communication-prefs"),
  setMeCommunicationPref: (body: { notification_type: string; channel: string; enabled: boolean }) =>
    request<{ ok: boolean }>("PUT", "/me/communication-prefs", body),

  // Web Push (#5267): this person's devices, their push settings, and what
  // quiet hours are holding.
  mePush: () => request<MePush>("GET", "/me/push"),
  addMePushDevice: (body: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string; user_agent?: string; org_id?: string | null; timezone?: string }) =>
    request<{ id: string; label: string }>("POST", "/me/push/devices", body),
  removeMePushDevice: (id: string) => request<void>("DELETE", `/me/push/devices/${encodeURIComponent(id)}`),
  /** Signing out: this browser lets go of the departing account's pushes
   *  (#7124). It carries that account's token itself, since sign-out clears
   *  the page's at once, and `keepalive` lets it finish while the page goes
   *  to a provider's sign-out. Never throws: offline, the local unsubscribe
   *  is what stops delivery, and the server drops the row at its next send. */
  forgetMePushDeviceAs: async (endpoint: string, token: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/v1/me/push/devices/forget", {
        method: "POST",
        keepalive: true,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  testMePushDevice: (id: string) =>
    request<{ deviceId: string; label: string; outcome: "sent" | "gone" | "failed"; reason?: string }>("POST", `/me/push/devices/${encodeURIComponent(id)}/test`, {}),
  setMePushSettings: (body: Partial<MePushSettings>) => request<MePushSettings>("PUT", "/me/push/settings", body),
  // Turning push on asks which other channels to turn off (#7070).
  answerPushHandoff: (body: { turn_off: string[]; normal_here: boolean; timezone?: string }) =>
    request<{ handoff: MePushHandoff; settings: MePushSettings }>("POST", "/me/push/handoff", body),
  skipPushHandoff: () => request<{ handoff: MePushHandoff }>("POST", "/me/push/handoff/skip", {}),
  setChannelOff: (channel: string, off: boolean) => request<{ channel: string; off: boolean }>("PUT", `/me/channels-off/${encodeURIComponent(channel)}`, { off }),
  meDeliveryWindows: () =>
    request<{ items: DeliveryWindowRow[]; orphaned: { channel: string; pending_count: number }[] }>(
      "GET",
      "/me/delivery-windows",
    ),
  setMeDeliveryWindow: (body: {
    channel: string;
    mode: "immediate" | "daily";
    deliver_at_minute?: number;
    timezone?: string;
    schedule_mode?: "inherit" | "immediate" | "daily";
    schedule_deliver_at_minute?: number;
  }) => request<{ ok: boolean }>("PUT", "/me/delivery-windows", body),
};
