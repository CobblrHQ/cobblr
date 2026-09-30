// Runs before first paint, from index.html's <head>, as a plain blocking
// script. It used to be two inline <script> blocks there; they moved here
// because the Content-Security-Policy is script-src 'self' and an inline
// script is exactly what that directive refuses (#3300). A same-origin file
// keeps the policy honest with no hash to drift and no nonce to mint, and a
// blocking <script src> in <head> runs at the same moment the inline one did.
// lint:csp-no-inline-scripts refuses a new inline block in index.html;
// lint:env-icons executes the first function below against every real host.

// Which Cobblr is this? The icon set is how you tell prod, staging and canary
// apart on a phone's home screen. The comment above the <script src> in
// web/index.html carries the history of the host list; the list itself is here.
(function () {
  try {
    var set = function (sel, attr, val) {
      var el = document.querySelector(sel);
      if (el) el.setAttribute(attr, val);
    };
    if (/^canary\./i.test(location.hostname)) {
      set('meta[name="theme-color"]', "content", "#FACC15");
      set('link[rel="icon"]', "href", "/favicon-canary.svg");
      set('link[rel="apple-touch-icon"]', "href", "/apple-touch-icon-canary.png");
      set('link[rel="manifest"]', "href", "/manifest-canary.webmanifest");
      set('meta[name="apple-mobile-web-app-title"]', "content", "Cobblr · canary");
      set('meta[name="application-name"]', "content", "Cobblr · canary");
      return;
    }
    var h = location.hostname;
    var internal =
      /(^|\.)ts\.net$/i.test(h) ||
      /(^|\.)local$/i.test(h) ||
      /^localhost$/i.test(h) ||
      /^127\./.test(h) ||
      h === "::1" ||
      /^\[?::1\]?$/.test(h) ||
      /^staging\./i.test(h);
    if (!internal) return;
    set('meta[name="theme-color"]', "content", "#6D28D9");
    set('link[rel="icon"]', "href", "/favicon-staging.svg");
    set('link[rel="apple-touch-icon"]', "href", "/apple-touch-icon-staging.png");
    set('link[rel="manifest"]', "href", "/manifest-staging.webmanifest");
    set('meta[name="apple-mobile-web-app-title"]', "content", "Cobblr · staging");
    set('meta[name="application-name"]', "content", "Cobblr · staging");
  } catch (e) {}
})();

// Running inside the Cobblr desktop app? The app extends its webview under the
// macOS title bar, so the window controls float over the top-left corner and
// only the sidebar has to get out of their way. Set before first paint so the
// layout is never briefly wrong; a normal browser never matches the UA.
(function () {
  try {
    if (/CobblrDesktop\//.test(navigator.userAgent)) {
      document.documentElement.classList.add("desktop-app");
    }
  } catch (e) {}
})();

// Light or dark, before the first paint. The class used to be set by React
// once the bundle had loaded, so a dark-mode user saw a white page on every
// load first. Same keys and the same precedence as resolveTheme
// (web/src/theme/resolve-theme.ts): this device's lock, else the account's
// default (the legacy combined key counts as that), else the OS. A test runs
// this file against every combination and compares.
(function () {
  try {
    var ls = window.localStorage;
    var device = ls.getItem("cobblr.theme.device");
    var account = ls.getItem("cobblr.theme.account") || ls.getItem("cobblr.theme");
    var os = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var theme =
      device === "light" || device === "dark"
        ? device
        : device === "os"
          ? os
          : account === "light" || account === "dark"
            ? account
            : os;
    if (theme === "dark") document.documentElement.classList.add("dark");
    // Until the stylesheet has arrived nothing paints the page's background,
    // so the browser's own canvas shows: this makes that canvas dark too.
    // ThemeContext removes it once the app is up and index.css governs.
    document.documentElement.style.colorScheme = theme;
  } catch (e) {}
})();
