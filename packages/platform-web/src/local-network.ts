// The one door from the browser to somebody's own machine.
//
// A web page reaching 127.0.0.1 is a real intrusion, and browsers now treat it
// as one: the first attempt raises "this site wants to access other apps and
// services on this device". Getting that before you have clicked anything is
// alarming in a way no feature is worth, and it happened - the Live box polls
// the local print bridge, its poll was disabled while the box was closed, and
// the hook did one read before checking. One request, every visitor, first
// screen.
//
// Fixing that one call site fixes that one call site. This is the rule instead:
// nothing in the browser reaches a local address except through here, and here
// refuses until somebody has asked for something that needs it.
//
// What counts as asking is deliberately ordinary - pressing "Connect a
// printer", opening the Live box, or already having a bridge printer configured
// in this workspace, which is consent given at the time it was connected. There
// is no extra dialog of our own: the browser has one, and the point is not to
// trigger it before the person has expressed intent, not to ask them twice.
//
// Non-local URLs pass straight through. A bridge on a LAN host somebody typed
// in is still their machine's business, so it is gated the same way; a public
// URL is not gated at all.

/** Loopback, RFC1918, link-local, CGNAT and .local - the addresses that belong
 *  to the person sitting there rather than to the internet. */
export function isLocalAddress(raw: string | URL): boolean {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(String(raw), window.location.href);
  } catch {
    return false; // not parseable: nothing we can gate
  }
  // OUR OWN ORIGIN IS NEVER "the local network", whatever its hostname.
  //
  // This is load-bearing for self-hosting. A self-hosted Cobblr is routinely
  // opened at http://localhost:4000, and every ordinary API call is a relative
  // URL that resolves against it - so a naive hostname test classifies the app
  // talking to itself as reaching into somebody's machine, and the gate breaks
  // the entire product for exactly the people running it on their own hardware.
  // Reaching a DIFFERENT service on that machine is the thing worth asking
  // about; reaching ourselves is just us.
  try {
    if (url.origin === window.location.origin) return false;
  } catch {
    /* no window (SSR/tests): fall through to the host rules */
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true; // CGNAT / tailnet
  return false;
}

const KEY = "cobblr.localAccessAllowed";
let allowed = false;

/** Has somebody done something that needs this machine's own services? */
export function localAccessAllowed(): boolean {
  if (allowed) return true;
  try {
    allowed = localStorage.getItem(KEY) === "1";
  } catch {
    /* private mode: in-memory only, which is the safe direction */
  }
  return allowed;
}

/** Record that they have. Called from a user action, or from a workspace that
 *  already has a local device configured - connecting it was the consent.
 *
 *  Persisted per browser so somebody who set up a printer last week is not
 *  asked to re-express intent on every page load. */
export function allowLocalAccess(reason: string): void {
  if (allowed) return;
  allowed = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* in-memory is enough for this tab */
  }
  console.info(`[local-network] allowed: ${reason}`);
}

/** For tests and for a "stop talking to my machine" control. */
export function revokeLocalAccess(): void {
  allowed = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export class LocalAccessDenied extends Error {
  constructor(url: string) {
    super(`refused to contact ${url}: nobody has asked for anything on this machine yet`);
    this.name = "LocalAccessDenied";
  }
}

/** The ONLY way browser code may fetch a local address.
 *
 *  Throws rather than returning an empty result on purpose: every caller
 *  already treats a failed bridge as "no bridge", so a refusal lands in the
 *  path they have, while a silent empty would look like a bridge that answered
 *  and had nothing. */
export async function localFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (isLocalAddress(input) && !localAccessAllowed()) throw new LocalAccessDenied(url);
  return fetch(input, init);
}
