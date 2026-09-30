// cobblr-hmac-v1 — request signing for Cobblr Services (services.md §5).
//
// Cobblr signs every request except the manifest:
//   X-Cobblr-Key-Id, X-Cobblr-Timestamp, X-Cobblr-Nonce,
//   X-Cobblr-Signature: v1=hex(hmac_sha256(secret,
//       timestamp \n nonce \n METHOD \n path_and_query \n hex(sha256(body))))
// The service rejects a timestamp more than 300 s off and a nonce it has seen
// inside that window. Self-contained on purpose (node:crypto only) so it can
// be vendored as a single file.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SCHEME = "cobblr-hmac-v1";
export const WINDOW_S = 300;
export const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");

export const HEADER = {
  keyId: "x-cobblr-key-id",
  timestamp: "x-cobblr-timestamp",
  nonce: "x-cobblr-nonce",
  signature: "x-cobblr-signature",
} as const;

/** A key as the service shows it once: `<key_id>.<secret>`. */
export interface ServiceKey {
  keyId: string;
  secret: string;
}

export function parseKeyString(s: string): ServiceKey {
  const t = s.trim();
  const dot = t.indexOf(".");
  if (dot <= 0 || dot === t.length - 1) throw new Error("key must look like <key_id>.<secret>");
  return { keyId: t.slice(0, dot), secret: t.slice(dot + 1) };
}

/** Mint a new key pair (what a service's `mint-key` does). */
export function mintKey(): ServiceKey & { keyString: string } {
  const keyId = "k_" + randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, secret, keyString: `${keyId}.${secret}` };
}

export function sha256Hex(body: string | Uint8Array | undefined | null): string {
  if (body === undefined || body === null) return EMPTY_BODY_SHA256;
  return createHash("sha256").update(body).digest("hex");
}

export function stringToSign(timestamp: string, nonce: string, method: string, pathAndQuery: string, bodySha256: string): string {
  return `${timestamp}\n${nonce}\n${method.toUpperCase()}\n${pathAndQuery}\n${bodySha256}`;
}

export function computeSignature(secret: string, timestamp: string, nonce: string, method: string, pathAndQuery: string, bodySha256: string): string {
  const mac = createHmac("sha256", secret).update(stringToSign(timestamp, nonce, method, pathAndQuery, bodySha256)).digest("hex");
  return `v1=${mac}`;
}

export interface SignInput {
  key: ServiceKey;
  method: string;
  /** Raw path plus raw query string, e.g. `/v1/jobs?x=1`. */
  pathAndQuery: string;
  /** sha256 hex of the body; defaults to sha256(""). */
  bodySha256?: string;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  /** 32 hex chars; defaults to 16 random bytes. */
  nonce?: string;
}

/** Headers to add to a request. */
export function signRequest(i: SignInput): Record<string, string> {
  const ts = String(i.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = i.nonce ?? randomBytes(16).toString("hex");
  const body = i.bodySha256 ?? EMPTY_BODY_SHA256;
  return {
    "X-Cobblr-Key-Id": i.key.keyId,
    "X-Cobblr-Timestamp": ts,
    "X-Cobblr-Nonce": nonce,
    "X-Cobblr-Signature": computeSignature(i.key.secret, ts, nonce, i.method, i.pathAndQuery, body),
  };
}

/** Remembers nonces for the window so a replay is refused. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private windowS = WINDOW_S) {}
  /** true if fresh (and records it), false if already seen inside the window. */
  checkAndRemember(keyId: string, nonce: string, nowS: number): boolean {
    if (this.seen.size > 10_000) this.prune(nowS);
    const k = `${keyId}:${nonce}`;
    const t = this.seen.get(k);
    if (t !== undefined && nowS - t <= this.windowS * 2) return false;
    this.seen.set(k, nowS);
    return true;
  }
  prune(nowS: number): void {
    for (const [k, t] of this.seen) if (nowS - t > this.windowS * 2) this.seen.delete(k);
  }
}

export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: string };

export interface VerifyInput {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  pathAndQuery: string;
  bodySha256: string;
  lookupSecret: (keyId: string) => string | undefined;
  nonces: NonceCache;
  nowS?: number;
}

function h(headers: VerifyInput["headers"], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (v !== undefined) return Array.isArray(v) ? v[0] : v;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) {
    const x = headers[k];
    return Array.isArray(x) ? x[0] : x;
  }
  return undefined;
}

/** Service side. Any failure maps to `401 bad_signature`; `reason` is for logs only. */
export function verifyRequest(i: VerifyInput): VerifyResult {
  const keyId = h(i.headers, HEADER.keyId);
  const ts = h(i.headers, HEADER.timestamp);
  const nonce = h(i.headers, HEADER.nonce);
  const sig = h(i.headers, HEADER.signature);
  if (!keyId || !ts || !nonce || !sig) return { ok: false, reason: "missing header" };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: "bad timestamp" };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "bad nonce" };
  const now = i.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > WINDOW_S) return { ok: false, reason: "timestamp outside window" };
  const secret = i.lookupSecret(keyId);
  if (!secret) return { ok: false, reason: "unknown key" };
  const want = Buffer.from(computeSignature(secret, ts, nonce, i.method, i.pathAndQuery, i.bodySha256));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature mismatch" };
  // Only a correctly signed nonce is remembered, so garbage can't fill the cache.
  if (!i.nonces.checkAndRemember(keyId, nonce, now)) return { ok: false, reason: "replayed nonce" };
  return { ok: true, keyId };
}
