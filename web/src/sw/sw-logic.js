// What the service worker does with a request, as plain functions so a test
// can run them without a browser (a-kept-copy-is-never-shown-as-live.test.ts). vite.config.ts inlines this file into dist/sw.js, after the
// build's own constants; nothing here is sent to the page.
//
// The rules, and why:
//   - A page load (navigate) goes to the network first. Offline, the cached app
//     shell answers, so Cobblr itself boots and can say it is offline, instead
//     of the browser's "no internet" page.
//   - A built file under /static/ is content-hashed and never changes: cache
//     first, fetched once.
//   - Any other file of the app (prepaint.js, the icons, the manifest) has no
//     hash, so it goes to the network first and the kept copy answers only
//     offline: cache-first would pin an old prepaint.js forever. /sw.js itself
//     is the browser's business, never the worker's.
//   - An API read (GET /api/v1/...) goes to the network first and its JSON
//     answer is kept. Offline, the kept answer is returned MARKED with the time
//     it was fetched (x-cobblr-offline-as-of), so the app shows it as "what you
//     had as of 14:02" and never as live. A read never kept answers 503 with
//     x-cobblr-offline, so the app says it is offline rather than failing oddly.
//   - Never kept: writes (anything but GET, which the worker does not touch at
//     all), /healthz (it is how the app learns it is back), sign-in, streams,
//     and any read an operator makes while viewing as someone: that person's
//     data must not outlive the audited session on the operator's device.

/** Paths whose answers must always come from the network. */
const NEVER_KEEP = [/^\/api\/v1\/healthz/, /^\/api\/v1\/auth\//, /\/stream(\/|$|\?)/, /\/events(\/|$|\?)/];

/** How the worker treats a request: "navigate", "static", "file", "api" or "pass".
 *  `viewingAs`: the request carries an operator's view-as grant. */
export function routeOf(method, url, mode, origin, viewingAs = false) {
  if (method !== "GET" || viewingAs) return "pass";
  const u = new URL(url);
  if (u.origin !== origin) return "pass";
  if (mode === "navigate") return "navigate";
  if (u.pathname.startsWith("/static/")) return "static";
  if (u.pathname.startsWith("/api/")) return u.pathname.startsWith("/api/v1/") && !NEVER_KEEP.some((re) => re.test(u.pathname)) ? "api" : "pass";
  if (u.pathname === "/sw.js") return "pass";
  return "file";
}

/** Only a successful JSON answer is worth keeping for offline. */
export function keepable(status, contentType) {
  return status >= 200 && status < 300 && /application\/json/i.test(contentType ?? "");
}

/** The kept answer, as the app receives it offline: same body, marked. */
export function asOfflineCopy(body, headers, fetchedAt) {
  const h = new Headers(headers);
  h.set("x-cobblr-offline-as-of", fetchedAt);
  h.set("cache-control", "no-store");
  return { body, init: { status: 200, headers: h } };
}

/** The answer to a read nobody kept, offline. */
export function offlineAnswer() {
  return {
    body: JSON.stringify({ error: { code: "offline", message: "You're offline, and this was not opened on this device before." } }),
    init: { status: 503, headers: { "content-type": "application/json", "x-cobblr-offline": "1", "cache-control": "no-store" } },
  };
}
