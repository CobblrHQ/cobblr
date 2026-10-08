import { createHmac } from "node:crypto";

export function credentialKeyId(key: Uint8Array): string {
  return createHmac("sha256", key).update("cobblr-tenant-creds-key-id-v1").digest("hex");
}
