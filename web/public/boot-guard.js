// A page whose code fails to load is never left blank.
//
// The app's own modules come over the network like anything else, and a
// network that blips while they load left an empty page: React never started,
// so nothing in the app could say so (found walking a guest's pages, #5966).
// A deploy that replaced the chunk files does the same to a tab opened on the
// old build (a stale-chunk 404). This file runs before the app, as a plain
// same-origin script (the CSP is script-src 'self'), and owns what happens
// when the app's code does not arrive, at the start or later for one page:
//
//   1. retry soon (300 ms), then once more after a short backoff (2.5 s), each
//      time dropping a stale installed copy of the app first, so a retry
//      after a deploy gets the new build;
//   2. still failing: "Couldn't load this page. Check your connection." with
//      a Retry button. Never a blank page.
//
// The count lives in sessionStorage for a minute, so a page that can never
// load stops after two tries instead of reloading forever. The app says it
// started (window.__cobblrStarted) and the error boundary asks this file what
// to do with a page chunk that failed (window.__cobblrLoadFailed).
(function () {
  var KEY = "cobblr:load-retries";
  var WINDOW_MS = 60000;
  var DELAYS = [300, 2500];
  var started = false;
  var CHUNK = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|dynamically imported module|ChunkLoadError/i;

  function read() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (v && Date.now() - v.at < WINDOW_MS) return v;
    } catch (e) {}
    return { n: 0, at: Date.now() };
  }
  function write(v) {
    try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
  }
  function clear() {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
  }

  // The installed app's worker and its cached shell, dropped before a reload
  // so a stale build is not served again (as lib/staleBuild.ts does).
  function dropStaleBuild() {
    var jobs = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister().catch(function () {}); }));
        }).catch(function () {}));
      }
    } catch (e) {}
    try {
      if (typeof caches !== "undefined") {
        jobs.push(caches.keys().then(function (names) {
          return Promise.all(names.filter(function (n) { return /^cobblr-(shell-|static-)/.test(n); }).map(function (n) { return caches.delete(n); }));
        }).catch(function () {}));
      }
    } catch (e) {}
    return Promise.all(jobs);
  }

  function reload() {
    dropStaleBuild().then(function () { location.reload(); }, function () { location.reload(); });
  }

  function showFailed() {
    if (document.getElementById("cobblr-load-failed")) return;
    var box = document.createElement("div");
    box.id = "cobblr-load-failed";
    box.setAttribute("role", "alert");
    box.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:#f5f1ea;color:#3d4451;font:16px/1.5 Inter,system-ui,sans-serif");
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) box.style.background = "#0f172a", box.style.color = "#e2e8f0";
    var inner = document.createElement("div");
    inner.setAttribute("style", "max-width:28rem;text-align:center");
    var h = document.createElement("p");
    h.setAttribute("style", "margin:0 0 8px;font-weight:600;font-size:18px");
    h.textContent = "Couldn't load this page.";
    var p = document.createElement("p");
    p.setAttribute("style", "margin:0 0 16px");
    p.textContent = "Check your connection, then try again.";
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Retry";
    b.setAttribute("style", "padding:10px 20px;border:0;border-radius:8px;background:#6b5a3e;color:#fff;font:600 16px Inter,system-ui,sans-serif;cursor:pointer");
    b.onclick = function () { clear(); b.disabled = true; b.textContent = "Loading…"; reload(); };
    inner.appendChild(h); inner.appendChild(p); inner.appendChild(b); box.appendChild(inner);
    (document.body || document.documentElement).appendChild(box);
  }

  /** The app's code did not arrive: retry, or say so. Returns "retrying" or
   *  "failed". At the start this file draws the message; the app (its error
   *  boundary, `{ app: true }`) draws its own, so there is one Retry. */
  function loadFailed(opts) {
    var v = read();
    if (v.n < DELAYS.length) {
      var wait = DELAYS[v.n];
      write({ n: v.n + 1, at: v.n === 0 ? Date.now() : v.at });
      setTimeout(reload, wait);
      return "retrying";
    }
    if (!(opts && opts.app)) showFailed();
    return "failed";
  }

  window.__cobblrLoadFailed = loadFailed;
  window.__cobblrIsChunkError = function (err) {
    return !!err && (err.name === "ChunkLoadError" || CHUNK.test(String(err.message || err)));
  };
  // A chunk that did not arrive, asked for once more under an address this
  // page has not used (#7676): WebKit keeps a network failure for the address
  // it failed at, even across a reload, so Retry never reached the server.
  // The build hands every import of the app's own chunks here on a failure
  // (web/src/lib/import-again.ts). A page imported from two places (its route's
  // prefetch and the page itself) shares one second try, so it is one module,
  // never two copies; one that failed may be tried afresh. `load` is for a test.
  var asking = {};
  window.__cobblrImportAgain = function (err, url, load) {
    if (!window.__cobblrIsChunkError(err)) return Promise.reject(err);
    if (asking[url]) return asking[url];
    var again = url + (url.indexOf("?") < 0 ? "?" : "&") + "again=" + Date.now();
    var p = (load ? load(again) : import(again));
    asking[url] = p;
    p.then(null, function () { if (asking[url] === p) delete asking[url]; });
    return p;
  };
  // The app started: a later page may still fail, so the count is kept (it
  // lapses after a minute) and only the start-up watch stops.
  window.__cobblrStarted = function () {
    started = true;
    var box = document.getElementById("cobblr-load-failed");
    if (box) box.parentNode.removeChild(box);
  };

  var bootFailed = false;
  function bootFailure() {
    if (started || bootFailed) return;
    bootFailed = true;
    loadFailed();
  }
  // A module or preload of the app's own code that failed to arrive.
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    if (!t || t === window) return;
    // A route's preload is a hint (vite.config.ts, data-route-hint): the page's
    // own import asks again at a new address, so a hint that failed is no
    // reason to reload, and counted as one it spent a retry (#7676).
    if (t.hasAttribute && t.hasAttribute("data-route-hint")) return;
    if (t.tagName === "SCRIPT" || (t.tagName === "LINK" && /modulepreload/.test(t.rel || ""))) {
      // The app's own code: a root-relative path or this origin, never a
      // third-party script (an analytics tag that failed is not the app).
      var attr = (t.getAttribute && (t.getAttribute("src") || t.getAttribute("href"))) || "";
      var abs = t.src || t.href || "";
      if ((attr.charAt(0) === "/" && attr.charAt(1) !== "/") || abs.indexOf(location.origin + "/") === 0) bootFailure();
    }
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    if (!started && window.__cobblrIsChunkError(e && e.reason)) bootFailure();
  });
  // Nothing failed loudly and the app still has not started: say so rather
  // than leave the page blank. The app removes the message if it starts later.
  setTimeout(function () { if (!started && !bootFailed) showFailed(); }, 30000);
})();
