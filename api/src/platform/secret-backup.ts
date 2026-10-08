import { isStoredSecret, type StoredSecretField } from "@cobblr/platform-contract/secret-field";
import { decryptCreds, encryptCreds, tenantCredsKeyId } from "../db/crypto.js";

function mapSecrets<T>(row: T, transform: (secret: StoredSecretField) => StoredSecretField): T {
  function visit(value: unknown): unknown {
    if (isStoredSecret(value)) return transform(value);
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  }
  return visit(row) as T;
}

export function captureBackupSecrets<T>(row: T): T {
  return mapSecrets(row, secret => ({ ...secret, key_id: secret.key_id ?? tenantCredsKeyId }));
}

export function rebindBackupSecrets<T>(orgId: string, row: T): T {
  return mapSecrets(row, secret => {
    if (secret.key_id && secret.key_id !== tenantCredsKeyId) throw new Error("This backup's encryption key is not available.");
    let payload: { orgId: string; field: string; value: string };
    try {
      payload = JSON.parse(decryptCreds(secret.ciphertext));
      if (typeof payload.orgId !== "string" || typeof payload.field !== "string" || typeof payload.value !== "string") throw new Error();
    } catch { throw new Error("An encrypted secret in this backup could not be restored."); }
    return { ...secret, key_id: tenantCredsKeyId, ciphertext: encryptCreds(JSON.stringify({ ...payload, orgId })) };
  });
}
