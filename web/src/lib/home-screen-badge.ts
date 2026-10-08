// The Home Screen icon's badge (#5267): the unread count where the device
// shows one (the installed app on iOS 16.4 and later, Chrome and Edge),
// cleared as things are read. Its own file because the bell loads it on every
// page, and the rest of push (lib/push-device.ts) is only needed on the
// settings page.
export function setHomeScreenBadge(unread: number): void {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> });
  if (!nav?.setAppBadge || !nav.clearAppBadge) return;
  void (unread > 0 ? nav.setAppBadge(unread) : nav.clearAppBadge()).catch(() => undefined);
}
