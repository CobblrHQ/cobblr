// Every query that shows notifications lives under one key family,
// ["notifications", ...], so one invalidation refreshes the bell, the full
// page and every unread count together.
//
// They used to be siblings ("me-notifications-list", "me-notifications-full",
// "me-notifications-unread", "notifications-unread"), and the Approve/Deny
// buttons invalidated ["notifications"], which matched none of them: an owner
// declined a request, closed the bell, reopened it, and the card offered
// Approve and Deny again until a reload (#3594). A new notification query
// takes its key from here; lint:query-key-families refuses the literal in a
// query key anywhere else.

export const notificationKeys = {
  /** Everything below: what a press, a read or a dismissal invalidates. */
  all: () => ["notifications"] as const,
  /** The bell's list, across the person's workspaces. */
  bell: () => ["notifications", "me", "bell"] as const,
  /** The full notifications page. */
  page: (unreadOnly: boolean) => ["notifications", "me", "page", unreadOnly] as const,
  /** The person's unread count, across workspaces. */
  unread: () => ["notifications", "me", "unread"] as const,
  /** One workspace's unread count. */
  workspaceUnread: (slug: string) => ["notifications", "workspace", slug, "unread"] as const,
};
