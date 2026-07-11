// Stateless, signed, short-lived token that authorises a no-auth reader to fetch
// a SINGLE scan photo for a cross-instance import. The scan EXPORT mints one
// PER FILE and bakes it into that photo's URL; the api-level route
// `GET /api/v1/public/scan-export/:token/files/:id/raw` VERIFIES it (an
// independent copy of `verify` below — api/src can't import this module — kept
// byte-compatible: same payload shape, same HMAC over the same secret).
//
// Shape:  base64url(JSON{o:orgId, f:fileId, e:expiryMs}) + "." + base64url(hmacSHA256)
// Scope:  ONE image (o+f) for `e` ms. Per-file — a token can't be repurposed to
//         read any other file in the org. TTL is caller-chosen (export modal).
//         A token WITHOUT `f` (legacy, pre-per-file exports) still verifies as an
//         org-wide image read so in-flight 14-day exports keep working.

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET unset — cannot sign scan-export photo tokens");
  return s;
}

function sig(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mint a token scoped to ONE file. Default 24h — long enough for a same-day
 *  hand-off, short enough to age out. The export modal picks the TTL. */
export function signExportToken(orgId: string, fileId: string, ttlMs = 24 * 60 * 60 * 1000): string {
  const payload = Buffer.from(JSON.stringify({ o: orgId, f: fileId, e: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${sig(payload)}`;
}

/** Verify → { orgId, fileId }, or null if malformed / bad signature / expired.
 *  `fileId` is null for a legacy org-wide token (no `f`). Mirrored in
 *  api/src/routes/public.ts (keep the two in lockstep). */
export function verifyExportToken(token: string): { orgId: string; fileId: string | null } | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sig(payload);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { o, f, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o?: unknown; f?: unknown; e?: unknown };
    if (typeof o !== "string" || typeof e !== "number" || Date.now() > e) return null;
    return { orgId: o, fileId: typeof f === "string" ? f : null };
  } catch {
    return null;
  }
}
