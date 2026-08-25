// The ONE "is this workspace font URL safe to fetch" predicate, shared by the
// render site (web appTheme → the live @font-face `src:url("…")`) and the write
// sites (the portal + core-apps theme routes that accept `font_url`). It lives
// in the contract because modules and the web bundle both need it and neither
// can import the other — same reasoning as private-ip.ts.
//
// Why it matters: a workspace `font_url` is interpolated into an @font-face rule
// that EVERY visitor's browser fetches on page load. An off-origin URL is
// therefore an external-resource beacon — a workspace admin could point it at an
// attacker host to fingerprint / deanonymise visitors (IP, timing, headers). So
// we only emit a font src that fetches from a self-contained data: URI, the same
// origin, or a well-known font CDN. Anything else is dropped rather than beaconed.
//
// Pure and dependency-free (the web bundle imports the contract), so it is safe
// everywhere and unit-testable in isolation.

/** Hosts we will fetch a hosted webfont from. Deliberately tiny — the well-known
 *  Google Fonts CDNs, which the platform already allows for @font-face. */
export const SAFE_FONT_HOSTS: ReadonlySet<string> = new Set([
  "fonts.gstatic.com",
  "fonts.googleapis.com",
]);

/** True only for a `font_url` we are willing to emit into an @font-face `src`:
 *  a `data:` URI (self-contained, no third-party fetch), a same-origin path
 *  (`/fonts/x.woff2` or a scheme-less relative path), or `https://` on an
 *  allowlisted font host. Everything else — `http://`, any other https host,
 *  `javascript:`, a protocol-relative `//host`, junk — is rejected. */
export function isSafeFontUrl(url: string): boolean {
  const u = url.trim();
  if (!u) return false;
  // Self-contained inline font — no network fetch to anyone.
  if (/^data:/i.test(u)) return true;
  // Protocol-relative ("//host/…") resolves off-origin — reject.
  if (u.startsWith("//")) return false;
  // No URL scheme ⇒ same-origin path ("/fonts/x.woff2" or "fonts/x.woff2").
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (scheme !== "https") return false;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  return SAFE_FONT_HOSTS.has(parsed.hostname.toLowerCase());
}
