// The one place that decides "is this scanned value a Cobblr label, and what is
// its token?"
//
// It lives in the contract package because BOTH sides ask: the browser (camera
// + hardware wedge) and the server (a scan arriving over an edge bridge). Three
// hand-rolled copies had already drifted apart, and two of them were wrong:
//
//   api/src/platform/scan-drive.ts   length >= 6, slash-tolerant   correct
//   web GlobalScanWedge.tsx          [A-Za-z0-9_-]{16,}            broken
//   web ScanCameraPage.tsx           [A-Za-z0-9_-]{16,}            broken
//
// Tokens were randomBytes(18) (24 chars) until #919 shortened them to
// randomBytes(9) (12 chars) on 2026-07-11. The two 16-char floors were written
// against the old length and silently stopped matching that same day: every
// label printed since fails to route on both local scan paths, staging a junk
// "no catalog match" inbox row instead of opening the thing. Labels printed
// before still work, so it reads as "this used to work."
//
// The `{16,}` character class also excludes `/`, so the descriptive
// `<shortcode>/<slug>` token form never matched either, at any length.

/** Charset of a minted token segment: base64url. */
const SEGMENT = "[A-Za-z0-9_-]+";

/** A printed Cobblr label encodes the full URL `<host>/qr/<token>`, where token
 *  is one opaque segment or a descriptive `<shortcode>/<slug>` pair.
 *
 *  Deliberately NO length floor. The `/qr/` path is already conclusive evidence,
 *  and every length assumption in this codebase has been wrong at least once.
 *  Returns the token, or null when the value is not a Cobblr label URL. */
export function qrTokenFromUrl(value: string): string | null {
  const m = new RegExp(`^https?://[^/]+/qr/(${SEGMENT}(?:/${SEGMENT})?)/?(?:[?#].*)?$`).exec(
    value.trim(),
  );
  return m ? (m[1] ?? null) : null;
}

/** Lenient form for intake paths that may receive a token WITHOUT its URL: some
 *  scanners are configured to strip a prefix, and an edge bridge forwards
 *  whatever the device emitted.
 *
 *  Callers must treat a hit as a CANDIDATE, not a verdict: a bare user serial
 *  like "WX-00042" is shape-identical to a bare token, so resolve it and fall
 *  through to the barcode/identifier path when it does not resolve. Prefer
 *  qrTokenFromUrl anywhere the full URL is expected (camera, hardware wedge). */
export function qrTokenFromScan(value: string): string | null {
  const t = value.trim();
  const fromUrl = qrTokenFromUrl(t);
  if (fromUrl) return fromUrl;
  // Any `/qr/` occurrence, even without a scheme (a relative or partial read).
  const m = /\/qr\/([^?#\s]+)/.exec(t);
  if (m) return m[1]!.replace(/\/+$/, "");
  // A bare url-safe slug. Numeric-only is a UPC/EAN, so it stays a barcode.
  if (new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`).test(t) && t.length >= 6 && /[A-Za-z_-]/.test(t)) {
    return t;
  }
  return null;
}
