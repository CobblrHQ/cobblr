// The notification stream's one event name, written by the api and listened
// for by the web. Both import it: two copies of the string drift apart
// silently (an EventSource listening for a name the server never sends just
// hears nothing, and the bell goes back to waiting for its poll).
export const NOTIFICATION_STREAM_EVENT = "notifications";

/** What the stream says with it: a new notification, or one read, deleted
 *  or cleared somewhere else. */
export interface NotificationStreamChange {
  kind: "new" | "changed";
  id?: string;
}
