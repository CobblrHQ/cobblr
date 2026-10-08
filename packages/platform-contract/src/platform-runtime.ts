// The running platform, as modules reach it: set once at api boot, read by
// every module. Apart from the index so code that merely mentions it (a helper
// shared with the browser, which never calls it) does not pull the whole
// contract and its schemas into a page (#4945). The index re-exports both.
import type { Platform } from "@cobblr/platform-contract";

let _platform: Platform | null = null;

/** Called once during api boot. Throws if called twice. */
export function setPlatform(p: Platform): void {
  if (_platform) {
    throw new Error("Platform already initialised");
  }
  _platform = p;
}

/** Whether the api has set the platform yet: false in a unit test or a CLI
 *  that never booted it. For a caller with a plain fallback (apiFetch). */
export function isPlatformSet(): boolean {
  return _platform !== null;
}

/** Called by modules. Throws if setPlatform hasn't run yet. */
export function platform(): Platform {
  if (!_platform) {
    throw new Error("Platform not initialised — setPlatform() must run during boot");
  }
  return _platform;
}
