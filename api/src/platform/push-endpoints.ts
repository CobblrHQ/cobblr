// Where a push may be sent (#5267). A subscription's endpoint comes from the
// browser, so it is a URL a person (or anyone holding their session) chose:
// saved unchecked, every notification would become a POST from this server
// to an address of their choosing. The endpoint is held to the browser
// vendors' own push services, over https, when it is saved and again before
// each send. This is the strict egress allowance for this one driver: fixed
// vendor hosts, sent to with plain fetch.

/** The push services browsers hand out endpoints at. */
const PUSH_SERVICE_HOSTS: ReadonlyArray<{ exact?: string; suffix?: string }> = [
  { exact: "fcm.googleapis.com" }, // Chrome, Edge on Android, Chromium browsers
  { exact: "android.googleapis.com" }, // older Chrome subscriptions
  { suffix: ".push.services.mozilla.com" }, // Firefox
  { exact: "web.push.apple.com" }, // Safari, and the iPhone and iPad Home Screen app
  { suffix: ".push.apple.com" },
  { suffix: ".notify.windows.com" }, // Edge on Windows
];

/** A push service a CI run stands up for itself (the api's own test-support
 *  door). Only ever set while those doors are mounted, never on a real box. */
let testOrigins: readonly string[] = [];
export function allowTestPushService(origins: readonly string[]): void {
  testOrigins = origins;
}

/** Is this an endpoint at a known push service? */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (testOrigins.includes(u.origin)) return true;
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => (h.exact ? host === h.exact : host.endsWith(h.suffix!)));
}

/** Is this endpoint the api's own CI push service? It is reached in-process,
 *  never over a loopback socket to its own port (refused under load, #4901). */
export function isTestPushService(endpoint: string): boolean {
  try {
    return testOrigins.includes(new URL(endpoint).origin);
  } catch {
    return false;
  }
}
