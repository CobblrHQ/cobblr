// Wait for a page to have what it asked for: the app booted (no boot scrim)
// and <html data-settled="true"> (web/src/components/SettledMarker.tsx: no
// query or mutation in flight) holding for a moment, capped.
//
// NOT waitForLoadState("networkidle"): a page that polls never goes quiet, so
// that wait always ran to its cap. The nightly walked every page at 20 s and
// three of ten areas went unwalked for lack of time (2026-10-03).
//
// An app without the marker (an older build) is waited for briefly, never to
// the cap: the marker's absence is not a reason to stall every page.
//
//   const { settled, ms } = await waitSettled(page, { capMs: 8000 });

/** The check, run in the page. Exported for the unit test. */
export function settledInPage(now = performance.now()) {
  if (document.querySelector('[data-testid="app-boot-scrim"], [aria-busy="true"]')) return false;
  // Nothing mounted yet: the app's code has not run. On a vite dev server at load ~40 that is many
  // seconds, and "no marker, so an older build: settled after 3 s" judged a blank page (#5756).
  // (Inline, not appMounted(): Playwright sends this function's source alone into the page.)
  const root = document.getElementById("root");
  if (!root && (!/^https?:$/.test(location.protocol) || /^\/w(?:\/|$)/.test(location.pathname))) return false;
  if (root && root.childElementCount === 0) return false;
  const v = document.documentElement.dataset.settled;
  if (v === undefined) return now > 3000;
  return v === "true";
}

/** The app has put something in its mount point (index.html's #root). Outside pages may have no root; workspace pages and browser error documents must not pass for mounted apps. */
export function appMounted() {
  // The boot guard's "Couldn't load this page" (web/public/boot-guard.js) is drawn outside #root: a
  // page that says it could not load is painted, and a walk of that message must be able to judge it.
  if (document.getElementById("cobblr-load-failed")) return true;
  const root = document.getElementById("root");
  return root ? root.childElementCount > 0 : /^https?:$/.test(location.protocol) && !/^\/w(?:\/|$)/.test(location.pathname);
}

/** Said of a page the app never drew into: what a blank page usually is, and what to do. */
export const NEVER_MOUNTED =
  "the app never mounted: a blank page. On a vite dev server under load the modules can outlast the wait; walk a built app instead (pnpm --filter web build, then pnpm --filter web preview, WEB=http://localhost:5173)";

/** A page that navigated away while it was being waited on (a redirect: a
 *  guest sent to the portal, a stale link sent home). Playwright says so by
 *  failing the wait; it is not the cap. */
export function isNavigationError(e) {
  return /Execution context was destroyed|navigat|Target page, context or browser has been closed|frame was detached/i.test(String(e?.message ?? e));
}

export async function waitSettled(page, { capMs = 8000, holdMs = 750 } = {}) {
  const t0 = Date.now();
  const left = () => Math.max(1, capMs - (Date.now() - t0));
  // Settled, then still settled a moment later: a page whose first answer
  // starts the next query is idle in between, for one frame on a quiet
  // machine and for hundreds of milliseconds on a loaded one (a walk on a
  // box at load 60 was judged 2.5 s before the page drew, at 250 ms).
  for (let i = 0; i < 6 && Date.now() - t0 < capMs; i++) {
    try {
      await page.waitForFunction(settledInPage, undefined, { timeout: left(), polling: 100 });
      await page.waitForTimeout(Math.min(holdMs, left()));
      if (await page.evaluate(settledInPage)) return { settled: true, ms: Date.now() - t0 };
    } catch (e) {
      // A redirect replaced the document under the wait: wait for the new
      // one and keep waiting, inside the cap. Judged here, the page was a
      // white frame with nothing painted (a guest's walk, 2026-10-07).
      if (!isNavigationError(e)) break;
      await page.waitForLoadState("domcontentloaded", { timeout: left() }).catch(() => {});
    }
  }
  return { settled: false, ms: Date.now() - t0 };
}

/** What a step's checks and its next step's press need of a toast still on
 *  screen: an Undo is judged, then pressed, before it goes. */
export const FEEDBACK_MARGIN_MS = 4000;

/** How long until the soonest toast shown since `since` (the page's clock)
 *  goes by itself, in ms, or null when none is on screen. Run in the page:
 *  each card says when it was shown and when it goes
 *  (packages/platform-web/src/ToastContext.tsx). */
export function feedbackLeftInPage(since) {
  let soonest = null;
  for (const el of document.querySelectorAll("[data-goes-at]")) {
    if (Number(el.getAttribute("data-shown-at")) < since) continue;
    const left = Number(el.getAttribute("data-goes-at")) - Date.now();
    if (soonest === null || left < soonest) soonest = left;
  }
  return soonest;
}

/**
 * The wait after a step's actions: settled, unless that would outlast the
 * feedback the actions brought. On a slow connection the page kept reading
 * for its whole eight seconds while an Undo shown for eight went by, and the
 * walk said the Undo was never offered (#8133). So the wait ends while a toast
 * shown since `since` still has FEEDBACK_MARGIN_MS left; the step's own
 * waitFor is what waits for the change it made.
 * @param {any} page
 * @param {number} since the page's Date.now() before the step acted
 */
export async function waitSettledWhileFeedbackLasts(page, since, { marginMs = FEEDBACK_MARGIN_MS, settle = waitSettled } = {}) {
  const t0 = Date.now();
  let done = false;
  const settled = settle(page).finally(() => { done = true; });
  const feedbackDue = (async () => {
    while (!done) {
      const left = await page.evaluate(feedbackLeftInPage, since).catch(() => null);
      if (left !== null && left <= marginMs) return { settled: false, ms: Date.now() - t0, feedback: true };
      await new Promise((r) => setTimeout(r, 100));
    }
    return settled;
  })();
  return Promise.race([settled, feedbackDue]);
}

/**
 * The page a walk's own steps act on: every goto and reload waits, once the
 * page loads, for it to settle, the way each page visit is judged. A step
 * that acted at load read the dashboard while it was still laid out under its
 * placeholders, and tapped the floor plan's Edit layout while the room's reads
 * were still landing, and the editor never opened (#7748, #7746).
 * @template {{ goto?: Function, reload?: Function }} P
 * @param {P} page
 * @param {(page: P) => Promise<unknown>} [settle]
 * @returns {P}
 */
export function actsWhenSettled(page, settle = waitSettled) {
  for (const name of ["goto", "reload"]) {
    if (typeof page[name] !== "function") continue;
    const go = page[name].bind(page);
    page[name] = async (...args) => {
      const answer = await go(...args);
      await settle(page);
      return answer;
    };
  }
  return page;
}

/** How long a step's checks wait, between them, for what they expect to see. */
export const SHOWS_WITHIN_MS = 10_000;

/**
 * A step's check of something it expects to see, judged the way a person
 * waits for a page still drawing: looked at again until it shows or the
 * step's time is up. Judged once, a page a loaded runner drew a moment after
 * its settle cap failed as missing though it drew whole (#6881, walk 60786:
 * a saved view's rows after a reload, a page coming back from an update
 * refresh). A check that something is absent is judged once: waiting would
 * let it pass on a page that had not drawn yet.
 * @param {() => Promise<string|null>} judgeOnce null when it holds, else what is wrong
 * @param {{ waits: boolean, until: number, everyMs?: number }} opts
 */
export async function judgeWaitingToShow(judgeOnce, { waits, until, everyMs = 250 }) {
  let bad = await judgeOnce();
  while (bad && waits && !bad.startsWith("could not check") && Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    bad = await judgeOnce();
  }
  return bad;
}
