// Turning Web Push on for this device (#5267), and saying plainly when it
// cannot be, yet.
//
// The platform facts that shape it: every modern browser takes Web Push, but
// an iPhone or iPad only from Cobblr added to the Home Screen (iOS 16.4 and
// later), and only when the person taps to allow it. So the readiness rule
// below is pure, and the page shows exactly one thing for each state.
import { api } from "./api";
import type { InstallRoute } from "./install-app";

export interface PushEnv {
  route: InstallRoute;
  /** A service worker, PushManager and Notification are all here. */
  canPush: boolean;
  permission: NotificationPermission | "unsupported";
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export type PushReadiness =
  /** An iPhone or iPad in the browser: push comes only to the Home Screen app. */
  | { kind: "install-first" }
  /** This browser has no Web Push at all (or the app is running without its service worker). */
  | { kind: "unsupported" }
  /** The person said no once; only their settings can undo it. */
  | { kind: "denied"; howToAllow: string }
  /** A tap away: the browser will ask. */
  | { kind: "ask" }
  /** Allowed: this device can be (or already is) subscribed. */
  | { kind: "allowed" };

const isApple = (env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints">) =>
  /iPhone|iPad|iPod/.test(env.userAgent) || (env.platform === "MacIntel" && env.maxTouchPoints > 1);

/** Where a person turns notifications back on after saying no, on their device. */
export function howToAllowAgain(env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints" | "route">): string {
  const ua = env.userAgent;
  if (isApple(env)) return "Open the Settings app, then Notifications, then Cobblr, and turn on Allow Notifications.";
  if (/Android/.test(ua)) return "Long-press the Cobblr icon and tap App info (or tap the icon left of the address bar), then Notifications, and allow them.";
  if (/Firefox\//.test(ua)) return "Click the icon left of the address bar, and clear the Blocked setting next to Send Notifications. Then reload the page.";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "In Safari, open Settings, then Websites, then Notifications, and set this site to Allow.";
  return "Click the icon left of the address bar, open Site settings, and set Notifications to Allow. Then reload the page.";
}

/** What this device can do about push, right now. */
export function pushReadiness(env: PushEnv): PushReadiness {
  if (isApple(env) && env.route.kind !== "installed") return { kind: "install-first" };
  if (!env.canPush || env.permission === "unsupported") return { kind: "unsupported" };
  if (env.permission === "denied") return { kind: "denied", howToAllow: howToAllowAgain(env) };
  if (env.permission === "default") return { kind: "ask" };
  return { kind: "allowed" };
}

/** The name a person will recognise this device by in their list. */
export function thisDeviceLabel(env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints" | "route">): string {
  const ua = env.userAgent;
  const apple = isApple(env);
  const device = /iPad/.test(ua) || (apple && !/iPhone|iPod/.test(ua)) ? "iPad" : /iPhone|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "This device";
  if (apple && env.route.kind === "installed") return `${device}, Home Screen app`;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${device}, ${browser}` : device;
}

/** Read the live browser into a PushEnv. */
export function readPushEnv(route: InstallRoute): PushEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const canPush = !!nav && "serviceWorker" in nav && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
  return {
    route,
    canPush,
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
  };
}

/** The id this device was saved under, so the list can say "this device". */
export const THIS_DEVICE_KEY = "cobblr.push.this-device";
export function thisDeviceId(): string | null {
  try {
    return localStorage.getItem(THIS_DEVICE_KEY);
  } catch {
    return null;
  }
}

const keyBytes = (b64url: string): Uint8Array => {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Why turning push on here did not finish. Every one is said in the row
 *  that offered it (pushTurnOnProblem): a refusal used to be a toast at most,
 *  and a person pressed Turn on, saw the same button come back, and could
 *  not tell a finished setup from a broken one (#5810). */
export type PushTurnOnFailure =
  /** The person said no at the browser's question. */
  | "denied"
  /** The question was closed without an answer. */
  | "dismissed"
  /** This browser has no Web Push. */
  | "unsupported"
  /** The server has not made its push key yet. */
  | "no-key"
  /** The page's service worker never started, so nothing can subscribe. */
  | "no-worker"
  /** The browser refused the subscription (Chrome: "Registration failed -
   *  permission denied" when the computer's own settings block it). */
  | "refused"
  /** Subscribed, but the server would not save it. */
  | "not-saved";

export type PushTurnOnResult = { ok: true; id: string } | { ok: false; why: PushTurnOnFailure; message?: string };

/** How long the page waits for its service worker before saying so. */
export const WORKER_WAIT_MS = 10_000;

const errorText = (err: unknown) => (err instanceof Error ? (err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message) : String(err));

/** Ask (this must run from a tap: iOS refuses otherwise), subscribe this
 *  browser, and save it for this person. Returns the device's id, or why not. */
export async function turnOnPushHere(publicKey: string | null | undefined, env: PushEnv, waitMs = WORKER_WAIT_MS): Promise<PushTurnOnResult> {
  if (!env.canPush) return { ok: false, why: "unsupported" };
  if (!publicKey) return { ok: false, why: "no-key" };
  const answer = await Notification.requestPermission();
  if (answer === "denied") return { ok: false, why: "denied" };
  if (answer !== "granted") return { ok: false, why: "dismissed" };
  // `ready` never settles on a page with no worker (a dev server, a worker
  // that failed to install), which left the button on "Turning on…" for good.
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]).catch(() => null);
  if (!reg) return { ok: false, why: "no-worker" };
  let sub: PushSubscription;
  try {
    const existing = await reg.pushManager.getSubscription();
    // A subscription made under another server key cannot take this one's pushes.
    if (existing) await existing.unsubscribe().catch(() => undefined);
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  } catch (err) {
    return { ok: false, why: "refused", message: errorText(err) };
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return { ok: false, why: "refused", message: "The browser gave no subscription to save." };
  try {
    const saved = await api.addMePushDevice({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      label: thisDeviceLabel(env),
      user_agent: env.userAgent.slice(0, 400),
    });
    try {
      localStorage.setItem(THIS_DEVICE_KEY, saved.id);
    } catch {
      /* the list just will not mark it */
    }
    return { ok: true, id: saved.id };
  } catch (err) {
    return { ok: false, why: "not-saved", message: errorText(err) };
  }
}

/** What a failed Turn on says where it was pressed: what went wrong, and the
 *  next thing to do. A Record over every failure, so a new one cannot be
 *  added without words. */
export function pushTurnOnProblem(failure: { why: PushTurnOnFailure; message?: string }, env: Pick<PushEnv, "userAgent" | "platform" | "maxTouchPoints" | "route">): { says: string; next: string } {
  // The browser's words end their own sentence, so the next step does not run on from them.
  const said = failure.message?.trim();
  const detail = said ? ` The browser said: ${/[.!?]$/.test(said) ? said : `${said}.`}` : "";
  const words: Record<PushTurnOnFailure, { says: string; next: string }> = {
    denied: { says: "Notifications were blocked when the browser asked.", next: howToAllowAgain(env) },
    dismissed: { says: "The browser's question was closed without an answer, so nothing was turned on.", next: "Press Try again and choose Allow." },
    unsupported: { says: "This browser can't show notifications from Cobblr.", next: "Open Cobblr in Chrome, Edge, Firefox or Safari, or from the Home Screen on an iPhone or iPad." },
    "no-key": { says: "This server has not made its notification key yet, so nothing was turned on.", next: "Try again in a minute." },
    "no-worker": { says: "This page's background worker did not start, and notifications need it.", next: "Reload the page and press Try again. If it keeps happening, open Cobblr in another browser." },
    refused: { says: `The browser allowed notifications but would not sign this device up for them.${detail}`, next: "Check that your computer or phone lets this browser show notifications (its system notification settings), then press Try again. A private window can't take them." },
    "not-saved": { says: `This device signed up, but Cobblr could not save it.${detail}`, next: "Press Try again." },
  };
  return words[failure.why];
}

/** Turn push off on this browser as well as removing it from the list. */
export async function turnOffPushHere(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* the server side is what matters; a browser that kept it gets a 410 later */
  }
  try {
    localStorage.removeItem(THIS_DEVICE_KEY);
  } catch {
    /* nothing to forget */
  }
}
