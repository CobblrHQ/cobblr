// Cobblr offline (#4226): the service worker's registration, and forgetting
// what it kept. The worker itself is src/sw/service-worker.js; what it keeps
// and how an offline copy is marked is src/sw/sw-logic.js.

/** The cache the worker keeps API reads in (sw/service-worker.js API). */
export const KEPT_READS = "cobblr-api-v2";

/** Register the worker, in a built app only: a dev server has no dist/sw.js,
 *  and a worker left over from a build would serve stale chunks to it. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No worker is only no offline: the app works as it did before it.
    });
  });
}

/** Forget every read kept for offline, on this device. Signing out, or someone
 *  else signing in here, must not leave the last person's records readable
 *  offline. */
export async function forgetKeptReads(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "cobblr:forget-reads" });
    if (typeof caches !== "undefined") await caches.delete(KEPT_READS);
  } catch {
    // Nothing kept, or no Cache API: nothing to forget.
  }
}

/** "14:02", or "Tue 14:02" when it was not today: when an offline copy was fetched. */
export function asOfWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "earlier";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}
