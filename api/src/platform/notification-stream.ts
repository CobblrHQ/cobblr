// "Your notifications changed", told to a person's open tabs the moment it
// happens: a new one arrived, or one was read, deleted or cleared elsewhere.
// The bell and the notifications page refetch on it instead of waiting for
// their next poll (a notification took up to 15 s to show, and the bell's open
// list never refreshed). In-process: the tabs are subscribed on the api that
// serves them; the polls stay as the fallback.
import type { NotificationStreamChange } from "@cobblr/platform-contract/notification-stream";

export type NotificationChange = NotificationStreamChange;
type Listener = (change: NotificationChange) => void;

const listeners = new Map<string, Set<Listener>>();

export function onNotificationChange(userId: string, fn: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(userId);
  };
}

export function announceNotificationChange(userId: string, change: NotificationChange): void {
  for (const fn of listeners.get(userId) ?? []) {
    try {
      fn(change);
    } catch {
      // One closed tab must not stop the others hearing it.
    }
  }
}
