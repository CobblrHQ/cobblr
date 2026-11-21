// A link is a web address: http or https, nothing else (#9709). No
// dependencies, so a page imports it without zod.
//
// z.string().url() takes any scheme the URL parser can read, so a part's
// supplier link was stored as "javascript:alert(document.cookie)" and kept.
// The parts list happened to link only http(s), but every other place that
// renders a stored link (a vendor's site, a public page's contact, an export,
// Cobb's answer, an MCP client) inherited a link that runs script when
// followed. One rule, on both sides: the server stores only a web address
// (webLink, in every schema a link is taken through; the code:web-link
// capabilities row refuses a bare .url()), and a page links a value read from a
// record only when following it cannot run script (safeHref, the code:safe-href
// row), so a value stored before the rule is shown as text, never followed.
/** What a person is told when a link is refused. */
export const WEB_LINK_REFUSED = "A link has to be a web address, starting with http:// or https://.";

export const WEB_LINK = /^https?:\/\//i;

/** Is this a web address a page may link (http or https, read the way a
 *  browser reads it: leading spaces and tabs inside the scheme do not hide a
 *  `javascript:`)? */
export function isWebLink(value: unknown): value is string {
  if (typeof value !== "string" || !WEB_LINK.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** What a person is told when a picture is refused (#4115). */
export const PICTURE_REFUSED = "A picture has to be a file in this workspace or a web address starting with https://.";

const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `//host/x` and `/\host/x` are another site's address to a browser. */
const ANOTHER_SITE = /^[\\/][\\/]/;

/** Can this be stored as a record's picture: empty, a file in this workspace
 *  (a path or a bare file name) or an https address? Read the way a browser
 *  reads it: leading spaces do not hide a scheme, and control characters (a
 *  tab inside `java\tscript:`) are refused outright. */
export function isPicturePath(value: unknown): boolean {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  if (!/[\p{L}\p{N}]/u.test(value) || /\p{Cc}/u.test(value)) return false;
  const t = value.trim();
  if (ANOTHER_SITE.test(t)) return false;
  if (!ANY_SCHEME.test(t)) return true;
  try {
    const u = new URL(t);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

/** The src a page may draw for a stored picture, or null for the record's
 *  initial: a file on this site, an https address, or a blob: the page made
 *  itself. Plain http only from this site (a dev server). Never `data:`,
 *  `javascript:`, another scheme, or another site's address without one. */
export function drawablePicture(value: unknown, origin?: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  const t = value.trim();
  if (/^blob:/i.test(t)) return t;
  if (!isPicturePath(t)) {
    if (!origin || !/^http:\/\//i.test(t) || /\p{Cc}/u.test(t)) return null;
    try {
      return new URL(t).origin === origin ? t : null;
    } catch {
      return null;
    }
  }
  return t;
}

/** The value, for an `href`, when following it cannot run script: a web
 *  address, a mailto: or tel: link, or a path on this site. Otherwise
 *  undefined, so the page shows the value as text instead of a link. */
export function safeHref(value: unknown): string | undefined {
  if (isWebLink(value)) return value;
  if (typeof value !== "string") return undefined;
  if (/^\/(?![\\/])/.test(value)) return value;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "mailto:" || protocol === "tel:" ? value : undefined;
  } catch {
    return undefined;
  }
}
