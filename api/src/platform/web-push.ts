// Web Push, the protocol (#5267): VAPID (RFC 8292) to say who is sending, and
// the aes128gcm content encoding (RFC 8291) so only the browser that
// subscribed can read what is sent. Node's own crypto does all of it, so a
// self-hosted Cobblr needs no package, no account and no relay: it talks to
// the browser vendors' push services (Apple, Google, Mozilla, Microsoft)
// directly.
//
// Pure apart from sendPush: the encryption and its inverse are here together,
// so a test (and the CI mock push service) reads what a phone would read.
// EGRESS-FILE: vendor-fixed - the endpoint is a browser vendor's push service, held to the known hosts when the subscription was saved (push-endpoints.ts)
import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export interface VapidKeys {
  /** base64url of the uncompressed P-256 point (65 bytes), the browser's applicationServerKey. */
  publicKey: string;
  /** base64url of the 32-byte private scalar. */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

/** RFC 8030 urgency: how hard the push service may try to wake the device. */
export type PushUrgency = "very-low" | "low" | "normal" | "high";

const b64url = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
// b64-lenient-ok: keys and secrets checked canonical when saved (me-push, decodeBase64urlExact) or made here
const unb64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** A fresh VAPID key pair. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Is this a usable pair: a 65-byte uncompressed point and the 32-byte scalar it came from? */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(unb64url(keys.privateKey));
    return b64url(ecdh.getPublicKey()) === keys.publicKey;
  } catch {
    return false;
  }
}

/** The Authorization header that names this instance to a push service:
 *  a short-lived ES256 JWT for the endpoint's origin, and the public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const pub = unb64url(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: keys.privateKey },
    format: "jwk",
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Twelve hours: the push services cap it at twenty-four.
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${body}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** The record size the body declares; one record holds the whole message. */
const RECORD_SIZE = 4096;
/** A payload this size or smaller always fits one record (RFC 8291: 4096 minus
 *  the header, the tag and the delimiter, with room to spare). */
export const MAX_PUSH_PAYLOAD_BYTES = 3800;

function derive(authSecret: Buffer, ecdhSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  return { cek, nonce };
}

/** Encrypt a payload to one browser's keys (RFC 8291, aes128gcm). `fixed`
 *  pins the sender's one-time key and the salt, for RFC 8291's own worked
 *  example; a real message always takes fresh ones. */
export function encryptPayload(
  payload: Buffer,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed?: { senderPrivateKey: string; salt: string },
): Buffer {
  if (payload.length > MAX_PUSH_PAYLOAD_BYTES) throw new Error(`a push payload is at most ${MAX_PUSH_PAYLOAD_BYTES} bytes, this one is ${payload.length}`);
  const uaPublic = unb64url(target.p256dh);
  const authSecret = unb64url(target.auth);
  const local = createECDH("prime256v1");
  if (fixed) local.setPrivateKey(unb64url(fixed.senderPrivateKey));
  else local.generateKeys();
  const asPublic = local.getPublicKey();
  const salt = fixed ? unb64url(fixed.salt) : randomBytes(16);
  const { cek, nonce } = derive(authSecret, local.computeSecret(uaPublic), uaPublic, asPublic, salt);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02: this is the last (and only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, sealed]);
}

/** The inverse, as the browser does it with its private key: a test's and the
 *  CI push service's way to read exactly what a device would show. */
export function decryptPayload(body: Buffer, browser: { privateKey: Buffer; publicKey: Buffer; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const sealed = body.subarray(21 + idLen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(browser.privateKey);
  const { cek, nonce } = derive(browser.auth, ecdh.computeSecret(asPublic), browser.publicKey, asPublic, salt);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // Strip the delimiter and any padding before it.
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  return plain.subarray(0, end);
}

/** A browser's side of a subscription, for a test or the CI push service. */
export function browserKeys(): { privateKey: Buffer; publicKey: Buffer; auth: Buffer; p256dh: string; authB64: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth, p256dh: b64url(ecdh.getPublicKey()), authB64: b64url(auth) };
}

export interface PushSendResult {
  status: number;
  /** Seconds the push service asked to wait, on a 429 or 503. */
  retryAfterSec: number | null;
  /** The push service's own words on a refusal, for the device list. */
  detail: string | null;
}

/** POST one encrypted message to a push service. Plain fetch: the endpoint is
 *  a browser vendor's push service, checked against the known hosts when the
 *  subscription was saved (push-endpoints.ts). */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  opts: { vapid: VapidKeys; subject: string; ttlSec: number; urgency: PushUrgency; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<PushSendResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), target);
  const res = await (opts.fetchImpl ?? fetch)(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(target.endpoint, opts.vapid, opts.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttlSec),
      Urgency: opts.urgency,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const retry = Number(res.headers.get("retry-after"));
  const detail = res.ok ? null : (await res.text().catch(() => "")).slice(0, 200) || null;
  return { status: res.status, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null, detail };
}
