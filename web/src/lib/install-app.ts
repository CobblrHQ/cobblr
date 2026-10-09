// Putting Cobblr on a phone's home screen: which door this browser has, the
// browser's own install prompt when it offers one, and a "not now" that is
// remembered.
//
// Three doors, because the browsers disagree:
// - Chromium (Android) fires `beforeinstallprompt` for an installable page. The
//   event is caught once, at startup, and kept, so a tour step minutes later
//   can raise the real prompt from a button.
// - Safari on iOS has no prompt at all. The only way in is Share, then Add to
//   Home Screen, and where Share sits depends on the Safari: Safari 26's
//   compact bar hides it in the ⋯ menu at the bottom right, older Safari shows
//   it in the middle of the bottom bar.
// - Anything else on a phone: the browser's own menu.
// An app already running from the home screen is never asked again.

/** The prompt Chromium hands over; not in the DOM typings. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallRoute =
  | { kind: "installed" }
  | { kind: "desktop" }
  /** Chromium kept a prompt: an Install button raises it. */
  | { kind: "prompt" }
  /** Safari on iOS: Share, then Add to Home Screen. `compact` is Safari 26's
   *  bar, Share inside ⋯ at the bottom right; `classic` has Share mid-bar. */
  | { kind: "ios"; layout: "compact" | "classic" }
  /** Another browser on iOS: Share is in its own toolbar, wherever that is. */
  | { kind: "ios-other" }
  /** A phone browser with no prompt: its menu has the install entry. */
  | { kind: "menu" };

export interface InstallEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** display-mode: standalone, or iOS's navigator.standalone. */
  standalone: boolean;
  hasPrompt: boolean;
  viewportWidth: number;
}

/** Below this the device is a phone (the tour's own line). */
const PHONE_MAX_WIDTH = 768;

export function installRoute(env: InstallEnv): InstallRoute {
  if (env.standalone) return { kind: "installed" };
  const ua = env.userAgent;
  // iPadOS asks for the desktop site and says "Macintosh"; a Mac has no touch.
  const ios = /iPhone|iPad|iPod/.test(ua) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);
  if (ios) {
    if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return { kind: "ios-other" };
    const safari = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
    return { kind: "ios", layout: safari >= 26 ? "compact" : "classic" };
  }
  if (env.viewportWidth >= PHONE_MAX_WIDTH) return { kind: "desktop" };
  return env.hasPrompt ? { kind: "prompt" } : { kind: "menu" };
}

let kept: BeforeInstallPromptEvent | null = null;
let listening = false;

/** Keep Chromium's install prompt for later. Call once, at startup: the
 *  event fires early and only once per page. */
export function listenForInstallPrompt(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    kept = e as BeforeInstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    kept = null;
  });
}

export function resetInstallPrompt(): void { kept = null; }

/** Raise the kept prompt. The event is spent either way (Chromium allows one
 *  prompt per event). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = kept;
  if (!e) return "unavailable";
  kept = null;
  await e.prompt();
  return (await e.userChoice).outcome;
}

export function readInstallEnv(): InstallEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone,
    hasPrompt: kept !== null,
    viewportWidth: window.innerWidth,
  };
}

/** "Not now", remembered on this device: the question is not asked again. */
export const INSTALL_DISMISSED_KEY = "cobblr.install-app.dismissed";

export function installDismissed(): boolean {
  try {
    return Boolean(localStorage.getItem(INSTALL_DISMISSED_KEY));
  } catch {
    return false;
  }
}

export function dismissInstall(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, new Date().toISOString());
  } catch {
    // Private mode: the tour asks once per person anyway.
  }
}

/** Whether to ask at all: never an installed app, never a desktop, never
 *  after "not now". */
export function shouldOfferInstall(route: InstallRoute): boolean {
  return route.kind !== "installed" && route.kind !== "desktop" && !installDismissed();
}

// ── The walk ───────────────────────────────────────────────────────────────
//
// Adding a web app to the home screen is several taps inside the browser's own
// sheets, where a page cannot point. So the walk numbers the taps, draws each
// sheet (a drawing, never a copy of the browser's UI), and points a real arrow
// only at the first tap, the one on the browser's own bar.

/** Where the first tap is, per Safari layout. ONE line per layout, so a
 *  correction after checking a real device is one line (Safari 26 compact:
 *  back, address pill, ⋯ at the right, Share inside ⋯; Bottom and Top, and
 *  every Safari before 26: Share in the middle of the bottom toolbar). */
export const SAFARI_FIRST_TAP: Record<"compact" | "classic", { at: "bottom-right" | "bottom-center"; label: string }> = {
  compact: { at: "bottom-right", label: "⋯" },
  classic: { at: "bottom-center", label: "Share" },
};

/** The drawing a step shows. */
export type InstallArt =
  | "safari-compact-bar"
  | "safari-toolbar"
  | "safari-more-menu"
  | "share-sheet-view-more"
  | "share-sheet-more-list"
  | "share-sheet"
  | "add-sheet"
  | "add-sheet-web-app"
  | "browser-menu"
  | "install-dialog"
  | "home-screen";

export interface InstallWalkStep {
  /** What to tap, short: it is the step's heading. */
  title: string;
  /** One sentence more, when the heading needs it. */
  body?: string;
  art: InstallArt;
}

export interface InstallWalk {
  steps: InstallWalkStep[];
  /** The arrow on the browser's own bar, shown with the first step. */
  pointer: { at: "bottom-right" | "bottom-center" | "top-right"; label: string } | null;
  /** The other layout's first tap, for a browser set up differently. */
  aside?: string;
}

const HOME: InstallWalkStep = { title: "Open Cobblr from your home screen", body: "It opens full screen, like any app, and signs you straight in.", art: "home-screen" };

/** The taps for this browser, or null where there is nothing to walk (an
 *  installed app, a desktop, a browser that raises its own prompt). */
export function installWalk(route: InstallRoute): InstallWalk | null {
  switch (route.kind) {
    case "ios":
      return route.layout === "compact"
        ? {
            pointer: SAFARI_FIRST_TAP.compact,
            aside: "If your Safari shows a Share button in the middle of the bottom bar, tap that and skip to step 3.",
            // As an iPhone on Safari 26 shows it (checked on a device,
            // 2026-09-27): Share heads the ⋯ menu, and the share sheet keeps
            // Add to Home Screen behind View More, the last of its round
            // buttons, at the foot of the list that opens.
            steps: [
              { title: "Tap ⋯ at the bottom right", body: "It is to the right of the bar with the address in it.", art: "safari-compact-bar" },
              { title: "Tap Share", body: "At the top of the menu that opens.", art: "safari-more-menu" },
              { title: "Tap View More", body: "The last of the round buttons, under the row of apps.", art: "share-sheet-view-more" },
              { title: "Tap Add to Home Screen", body: "At the end of the list that opens.", art: "share-sheet-more-list" },
              { title: "Keep Open as Web App on, tap Add", body: "Add is the blue button at the top right.", art: "add-sheet-web-app" },
              HOME,
            ],
          }
        : {
            pointer: SAFARI_FIRST_TAP.classic,
            aside: "If your address bar is at the bottom with ⋯ at its right, tap ⋯ first, then Share.",
            steps: [
              { title: "Tap Share in the middle of the bottom bar", body: "The square with an arrow coming out of it.", art: "safari-toolbar" },
              { title: "Scroll down, tap Add to Home Screen", art: "share-sheet" },
              { title: "Tap Add", art: "add-sheet" },
              HOME,
            ],
          };
    case "ios-other":
      return {
        pointer: null,
        steps: [
          { title: "Tap your browser's Share button", art: "safari-toolbar" },
          { title: "Scroll down, tap Add to Home Screen", art: "share-sheet" },
          { title: "Tap Add", art: "add-sheet" },
          HOME,
        ],
      };
    case "menu":
      return {
        pointer: { at: "top-right", label: "⋮" },
        steps: [
          { title: "Tap ⋮ at the top right", body: "Your browser's menu.", art: "browser-menu" },
          { title: "Tap Install app", body: "Some browsers call it Add to Home screen.", art: "browser-menu" },
          { title: "Tap Install", art: "install-dialog" },
          HOME,
        ],
      };
    default:
      return null;
  }
}

/** Asked once after the first scan that lands on this device, whatever the
 *  answer: a second scan is not a second reason to ask. */
export const INSTALL_OFFERED_AFTER_SCAN_KEY = "cobblr.install-app.offered-after-scan";

export function shouldOfferInstallAfterScan(route: InstallRoute): boolean {
  if (!shouldOfferInstall(route)) return false;
  try {
    return !localStorage.getItem(INSTALL_OFFERED_AFTER_SCAN_KEY);
  } catch {
    return false;
  }
}

export function noteInstallOfferedAfterScan(): void {
  try {
    localStorage.setItem(INSTALL_OFFERED_AFTER_SCAN_KEY, new Date().toISOString());
  } catch {
    // Private mode: the offer may come back, which costs a tap.
  }
}

/** For tests: forget a kept prompt. */
export function resetInstallPromptForTests(prompt: BeforeInstallPromptEvent | null = null): void {
  kept = prompt;
}
