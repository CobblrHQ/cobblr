// Getting a stale installed app onto the current build (#4813).
//
// A deploy replaces the chunk files; an installed app whose service worker
// still holds the old shell asks for chunks that no longer exist, and a plain
// reload is answered by the same worker. So before reloading, the page drops
// what the worker kept of the app (the shell and the hashed chunks) and
// unregisters the worker; the next load registers the current one. Kept API
// reads (offline records) and a pending share are not the app and stay.

const APP_CACHE = /^cobblr-(shell-|static-)/;

/** Forget the cached copy of the app and the worker serving it. Never throws:
 *  a browser with no worker or no Cache API has nothing stale to drop. */
export async function dropStaleBuild(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = (await navigator.serviceWorker.getRegistrations?.()) ?? [];
      await Promise.all(
        regs.map(async (r) => {
          try {
            r.waiting?.postMessage({ type: "cobblr:skip-waiting" });
            await r.unregister();
          } catch {
            /* a worker that will not unregister is dropped from the cache side */
          }
        }),
      );
    }
  } catch {
    /* no worker to drop */
  }
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => APP_CACHE.test(n)).map((n) => caches.delete(n)));
    }
  } catch {
    /* no Cache API */
  }
}
