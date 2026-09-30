// Cobblr's service worker. vite.config.ts writes dist/sw.js from this file with
// two constants in front (BUILD, PRECACHE) and sw-logic.js inlined; see the
// rules there. Served from the root so its scope is the whole app, and never
// cached by the browser itself (nginx: /sw.js is no-cache).
/* global BUILD, PRECACHE, routeOf, keepable, asOfflineCopy, offlineAnswer */

const SHELL = `cobblr-shell-${BUILD}`;
const STATIC = "cobblr-static-v1";
const API = "cobblr-api-v1";

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
        return Promise.all(shells.slice(0, -1).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

// The page asks for its kept reads to be forgotten: sign-out, or another
// person signing in on this device.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "cobblr:forget-reads") event.waitUntil(caches.delete(API));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const route = routeOf(req.method, req.url, req.mode, self.location.origin, req.headers.has("x-impersonation"));
  if (route === "pass") return;
  if (route === "navigate") event.respondWith(navigate(req));
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
  try {
    const res = await fetch(req);
    if (keepable(res.status, res.headers.get("content-type"))) {
      const copy = res.clone();
      const body = await copy.arrayBuffer();
      const headers = new Headers(copy.headers);
      headers.set("x-cobblr-fetched-at", new Date().toISOString());
      void caches.open(API).then((c) => c.put(req, new Response(body, { status: 200, headers })));
    }
    return res;
  } catch {
    const kept = await caches.match(req, { cacheName: API });
    if (kept) {
      const { body, init } = asOfflineCopy(await kept.arrayBuffer(), kept.headers, kept.headers.get("x-cobblr-fetched-at") || "");
      return new Response(body, init);
    }
    const { body, init } = offlineAnswer();
    return new Response(body, init);
  }
}
