// Cobblr's service worker. vite.config.ts writes dist/sw.js from this file with
// two constants in front (BUILD, PRECACHE) and sw-logic.js inlined; see the
// rules there. Served from the root so its scope is the whole app, and never
// cached by the browser itself (nginx: /sw.js is no-cache).
/* global BUILD, PRECACHE, routeOf, keepable, asOfflineCopy, offlineAnswer, sharePayload, withLeftover, SHARE_CACHE, SHARE_PAYLOAD, notificationFor, tapTarget */

const SHELL = `cobblr-shell-${BUILD}`;
const STATIC = "cobblr-static-v1";
const API = "cobblr-api-v2";
let readsEpoch = 0;
let readsMutation = Promise.resolve();

// Deletion must follow any write already started, and an earlier fetch must
// never enqueue a write after that boundary.
function mutateReads(work) {
  const done = readsMutation.then(work);
  readsMutation = done.catch(() => {});
  return done;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  // The previous shell stays one generation, so a tab still on the old build
  // can load its own chunks; anything older goes.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const shells = keys.filter((k) => k.startsWith("cobblr-shell-") && k !== SHELL).sort();
        return Promise.all([...shells.slice(0, -1), "cobblr-api-v1"].map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

// The page asks for its kept reads to be forgotten: sign-out, or another
// person signing in on this device.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cobblr:forget-reads") {
    readsEpoch++;
    event.waitUntil(mutateReads(() => caches.delete(API)));
  }
  // A page that found itself on a stale build asks the waiting worker to take over.
  if (event.data && event.data.type === "cobblr:skip-waiting") self.skipWaiting();
});

// A push from Cobblr (#5267): show it, and put the unread count on the Home
// Screen icon where the device supports a badge.
self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const n = notificationFor(data);
  const badge =
    n.badge == null || !("setAppBadge" in self.navigator)
      ? Promise.resolve()
      : (n.badge > 0 ? self.navigator.setAppBadge(n.badge) : self.navigator.clearAppBadge()).catch(() => {});
  event.waitUntil(Promise.all([self.registration.showNotification(n.title, n.options), badge]));
});

// A tap opens Cobblr at what the notification is about: an open Cobblr window
// is brought forward and moved there, else a new one opens.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = tapTarget(event.notification.data && event.notification.data.url, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.location.origin));
      if (open) return open.focus().then((w) => (w && "navigate" in w ? w.navigate(target) : undefined)).catch(() => self.clients.openWindow(target));
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const route = routeOf(req.method, req.url, req.mode, self.location.origin, req.headers.has("x-impersonation"));
  if (route === "pass") return;
  if (route === "share") event.respondWith(takeShare(req));
  else if (route === "navigate") event.respondWith(navigate(req));
  else if (route === "static") event.respondWith(staticFile(req));
  else if (route === "file") event.respondWith(appFile(req));
  else event.respondWith(apiRead(req));
});

async function appFile(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      void caches.open(SHELL).then((c) => c.put(req, copy));
    }
    return res;
  } catch {
    const kept = await caches.match(req, { ignoreVary: true });
    if (kept) return kept;
    throw new Error("offline, and this file was never kept");
  }
}

async function navigate(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      void caches.open(SHELL).then((c) => c.put("/", copy));
    }
    return res;
  } catch {
    const shell = (await caches.match("/", { cacheName: SHELL, ignoreVary: true })) || (await caches.match("/", { ignoreVary: true }));
    return shell || new Response("<h1>You're offline</h1>", { status: 503, headers: { "content-type": "text/html" } });
  }
}

// ignoreVary: the precache fetched these with no Origin header, and a module
// script asks with one; a server that answers `Vary: Origin` would make every
// precached chunk a miss, and an app opened offline for the first time would
// load nothing (found by the offline walk). A content-hashed file is the same
// file whoever asks.
async function staticFile(req) {
  const hit = await caches.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    void caches.open(STATIC).then((c) => c.put(req, copy));
  }
  return res;
}

async function apiRead(req) {
  const epoch = readsEpoch;
  try {
    const res = await fetch(req);
    if (keepable(res.status, res.headers.get("content-type"))) {
      const copy = res.clone();
      const body = await copy.arrayBuffer();
      const headers = new Headers(copy.headers);
      headers.set("x-cobblr-fetched-at", new Date().toISOString());
      const vary = headers.get("vary");
      headers.set("vary", vary ? `${vary}, Authorization` : "Authorization");
      await mutateReads(async () => {
        if (epoch !== readsEpoch) return;
        const cache = await caches.open(API);
        if (epoch !== readsEpoch) return;
        await cache.put(req, new Response(body, { status: 200, headers }));
      }).catch(() => {});
    }
    return res;
  } catch {
    const kept = epoch === readsEpoch ? await caches.match(req, { cacheName: API }).catch(() => undefined) : undefined;
    if (kept) {
      const bytes = await kept.arrayBuffer();
      if (epoch === readsEpoch) {
        const { body, init } = asOfflineCopy(bytes, kept.headers, kept.headers.get("x-cobblr-fetched-at") || "");
        return new Response(body, init);
      }
    }
    const { body, init } = offlineAnswer();
    return new Response(body, init);
  }
}

// Another app shared to Cobblr: keep the form for the page (it alone holds the
// person's token), with whatever an earlier share left unsaved, and open the
// page that adds it. A redirect after the POST, so a reload never posts it twice.
async function takeShare(req) {
  const form = await req.formData();
  const entries = [...form.entries()];
  const before = await caches.open(SHARE_CACHE);
  const leftRes = await before.match(SHARE_PAYLOAD);
  const left = leftRes ? await leftRes.json().catch(() => null) : null;
  const { payload, moves } = withLeftover(sharePayload(entries), left);
  const carried = [];
  for (const m of moves) carried.push([m.to, await before.match(m.from)]);
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);
  for (const [key, res] of carried) if (res) await cache.put(key, res);
  let i = 0;
  for (const [name, value] of entries) {
    if (name !== "files" || typeof value === "string" || !String(value.type).startsWith("image/")) continue;
    await cache.put(`/__share/file/${i}`, new Response(value, { headers: { "content-type": value.type } }));
    i++;
  }
  await cache.put(SHARE_PAYLOAD, new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
  return Response.redirect(new URL("/scan/share?received=1", self.location.origin).href, 303);
}
