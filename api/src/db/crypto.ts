// AES-256-GCM at-rest encryption for tenant DB credentials. The key
// derives from env.TENANT_CREDS_ENCRYPTION_KEY via scrypt with a
// fixed salt — that normalises whatever string the operator supplies
// (a long passphrase, a base64 blob, etc.) into 32 deterministic
// bytes.
//
// Payload format: <iv-hex>.<tag-hex>.<ciphertext-hex>. Three
// hex-encoded sections, dot-separated, so the value is easy to
// eyeball in a `psql` query.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { credentialKeyId } from "./credential-key-id.js";
import { env } from "../env.js";

const KEY = scryptSync(env.TENANT_CREDS_ENCRYPTION_KEY, "cobblr-tenant-creds-v1", 32);
export const tenantCredsKeyId = credentialKeyId(KEY);

export function encryptCreds(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${enc.toString("hex")}`;
}

export function decryptCreds(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credential payload");
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** The same key for bytes (a Vault document): iv (12) | tag (16) | ciphertext,
 *  so a file is not hex-doubled the way a credential string is. */
export function encryptBytes(plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBytes(sealed: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < 28) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]);
}
