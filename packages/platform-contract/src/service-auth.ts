// cobblr-hmac-v1: how Cobblr proves itself to a service (services.md §5).
//
// Every request but the manifest is signed with the per-connection secret the
// service minted. The secret never travels: not in the relayed request a
// bridge carries, not in a log. What travels is the key id, a timestamp, a
// nonce and a signature over the method, the raw path and query, and the
// body's hash.
//
// Server-only (node:crypto). The Connections Test and the Services transport
// both sign through signServiceRequest, so there is one signer; the verifier
// is the reference a service (and Cobblr's own tests) checks against.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SERVICE_AUTH_SCHEME = "cobblr-hmac-v1";
export const SERVICE_AUTH_HEADERS = {
  keyId: "X-Cobblr-Key-Id",
  timestamp: "X-Cobblr-Timestamp",
  nonce: "X-Cobblr-Nonce",
  signature: "X-Cobblr-Signature",
} as const;
/** A service refuses a timestamp further off than this, and a nonce it has
 *  seen within it. */
export const SERVICE_AUTH_SKEW_S = 300;

export interface ServiceKey {
  keyId: string;
  secret: string;
}

/** The string a service's `mint-key` shows once: `<key_id>.<secret>`. The
 *  key id holds no dot; everything after the first dot is the secret. */
export function parseServiceKey(s: string): ServiceKey | null {
  const t = s.trim();
  const dot = t.indexOf(".");
  if (dot <= 0 || dot === t.length - 1) return null;
  const keyId = t.slice(0, dot);
  const secret = t.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId) || secret.length < 16) return null;
  return { keyId, secret };
}

const sha256Hex = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");

function stringToSign(p: { timestamp: number; nonce: string; method: string; pathAndQuery: string; bodySha256: string }): string {
  return `${p.timestamp}\n${p.nonce}\n${p.method.toUpperCase()}\n${p.pathAndQuery}\n${p.bodySha256}`;
}

/** The four headers for one request. `pathAndQuery` is the raw path and raw
 *  query string exactly as sent; `body` the exact bytes (none: the empty
 *  body). Pass `bodySha256` instead of `body` for a streamed upload. */
export function signServiceRequest(p: {
  keyId: string;
  secret: string;
  method: string;
  pathAndQuery: string;
  body?: string | Uint8Array;
  bodySha256?: string;
  /** Unix seconds; defaults to now. */
  now?: number;
  /** 32 lowercase hex; defaults to 16 random bytes. */
  nonce?: string;
}): Record<string, string> {
  const timestamp = Math.floor(p.now ?? Date.now() / 1000);
  const nonce = p.nonce ?? randomBytes(16).toString("hex");
  const bodySha256 = p.bodySha256 ?? sha256Hex(p.body ?? "");
  const sig = createHmac("sha256", p.secret).update(stringToSign({ timestamp, nonce, method: p.method, pathAndQuery: p.pathAndQuery, bodySha256 })).digest("hex");
  return {
    [SERVICE_AUTH_HEADERS.keyId]: p.keyId,
    [SERVICE_AUTH_HEADERS.timestamp]: String(timestamp),
    [SERVICE_AUTH_HEADERS.nonce]: nonce,
    [SERVICE_AUTH_HEADERS.signature]: `v1=${sig}`,
  };
}

/** The reference check a service runs. `seen` answers whether a nonce was
 *  already used within the skew window (and records it); a replay is refused
 *  even with a valid signature. */
export function verifyServiceRequest(p: {
  headers: Record<string, string | undefined>;
  secretFor: (keyId: string) => string | null;
  method: string;
  pathAndQuery: string;
  body?: string | Uint8Array;
  bodySha256?: string;
  now?: number;
  seen?: (keyId: string, nonce: string) => boolean;
}): { ok: true; keyId: string } | { ok: false; reason: "missing" | "unknown_key" | "skew" | "bad_nonce" | "replayed" | "bad_signature" } {
  const h = (name: string) => p.headers[name] ?? p.headers[name.toLowerCase()];
  const keyId = h(SERVICE_AUTH_HEADERS.keyId);
  const ts = h(SERVICE_AUTH_HEADERS.timestamp);
  const nonce = h(SERVICE_AUTH_HEADERS.nonce);
  const sig = h(SERVICE_AUTH_HEADERS.signature);
  if (!keyId || !ts || !nonce || !sig) return { ok: false, reason: "missing" };
  const secret = p.secretFor(keyId);
  if (!secret) return { ok: false, reason: "unknown_key" };
  const now = Math.floor(p.now ?? Date.now() / 1000);
  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > SERVICE_AUTH_SKEW_S) return { ok: false, reason: "skew" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "bad_nonce" };
  const bodySha256 = p.bodySha256 ?? sha256Hex(p.body ?? "");
  const want = `v1=${createHmac("sha256", secret).update(stringToSign({ timestamp, nonce, method: p.method, pathAndQuery: p.pathAndQuery, bodySha256 })).digest("hex")}`;
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  if (p.seen?.(keyId, nonce)) return { ok: false, reason: "replayed" };
  return { ok: true, keyId };
}
