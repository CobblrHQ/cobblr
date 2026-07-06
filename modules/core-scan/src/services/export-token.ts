// Stateless, signed, short-lived token that authorises a no-auth reader to fetch
// an ORG's scan photos for a cross-instance import. The scan EXPORT mints one
// and bakes it into each photo URL; the api-level route
// `GET /api/v1/public/scan-export/:token/files/:id/raw` VERIFIES it (an
// independent copy of `verify` below — api/src can't import this module — kept
// byte-compatible: same payload shape, same HMAC over the same secret).
//
// Shape:  base64url(JSON{o:orgId, e:expiryMs}) + "." + base64url(hmacSHA256).slice(0,43)
// Scope:  org-wide IMAGE read (the serving route is images-only, like the public
//         surface file route) for `e` ms. Not a session; can't write; expires.

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET unset — cannot sign scan-export photo tokens");
  return s;
}

function sig(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Default 14-day validity — long enough to hand an export file to another
 *  instance and run the import unhurried, short enough to age out. */
export function signExportToken(orgId: string, ttlMs = 14 * 24 * 60 * 60 * 1000): string {
  const payload = Buffer.from(JSON.stringify({ o: orgId, e: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${sig(payload)}`;
}

/** Verify → orgId, or null if malformed / bad signature / expired. Mirrored in
 *  api/src/routes/public.ts (keep the two in lockstep). */
export function verifyExportToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sig(payload);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { o, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o?: unknown; e?: unknown };
    if (typeof o !== "string" || typeof e !== "number" || Date.now() > e) return null;
    return o;
  } catch {
    return null;
  }
}
