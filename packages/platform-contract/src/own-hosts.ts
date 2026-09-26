// Links to Cobblr itself, which a scanner reads and must never file.
//
// A booth's display carries QR codes for the platform's own site and sandbox,
// and they sit in view behind whatever a visitor holds up to the camera. Each
// one was read, filed as an inbox item or held as a product's web link, and
// crowded out the item being scanned. A link to Cobblr is never the thing in
// front of the lens. A printed Cobblr LABEL (`/qr/<token>`) is the exception and
// is decided before this (qr-token.ts): it opens its record on any host.
//
// One list, here, so the camera, the typed field and a server-side intake read
// the same hosts. A self-hosted instance's own address is "own" too; callers
// pass it (the page's origin) as `ownOrigins`.
//
// Own does not mean ignored. A link to a page of the instance the scanner runs
// on (a record, the open door, a pairing or invite link, anything its router
// serves) OPENS that page: `ownAppPath`. Only what is not a page of this app is
// ignored: another Cobblr host's link (the site, the sandbox), this origin's
// root, and its API. So a self-hoster's QR to one of their own records still
// works, and a route added later is honoured with no list to update.

/** The platform's public hosts: the site, its sandbox, the hosted app, the
 *  account door. A host equal to one of these, or under it, is own. */
export const COBBLR_OWN_HOSTS: readonly string[] = ["cobblr.xyz"];

function hostOf(value: string): string | null {
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Is this scanned value a link to Cobblr itself (the platform's hosts, or
 *  one of `ownOrigins`, the instance the scanner is running on)? Only http(s)
 *  links; a record label is not asked here. */
export function isOwnCobblrLink(value: string, ownOrigins: readonly string[] = []): boolean {
  if (!/^https?:\/\//i.test(value.trim())) return false;
  const host = hostOf(value);
  if (!host) return false;
  if (COBBLR_OWN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return ownOrigins.some((o) => {
    const own = hostOf(o);
    return !!own && own === host;
  });
}

/** Paths on an instance's own origin that are not a page of the app: its bare
 *  root (a site link, the display's "visit us") and its API (the sandbox door
 *  is /api/v1/try). Everything else the origin serves is a page. */
function notAPage(pathname: string): boolean {
  return pathname === "/" || pathname === "" || pathname === "/api" || pathname.startsWith("/api/");
}

/** The in-app path (path, query and hash) a scanned link opens, when it is a
 *  page of the instance at one of `ownOrigins`; null otherwise. */
export function ownAppPath(value: string, ownOrigins: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const onThisInstance = ownOrigins.some((o) => {
    try {
      return new URL(o).host.toLowerCase() === u.host.toLowerCase();
    } catch {
      return false;
    }
  });
  if (!onThisInstance || notAPage(u.pathname)) return null;
  return `${u.pathname}${u.search}${u.hash}`;
}
