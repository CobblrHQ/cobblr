import { isStoredSecret } from "@cobblr/platform-contract/secret-field";

export function rotateSecretPayloads(value: unknown, rotate: (ciphertext: string) => string, keyId?: string): unknown {
  if (isStoredSecret(value)) return { ...value, ciphertext: rotate(value.ciphertext), ...(keyId ? { key_id: keyId } : {}) };
  if (Array.isArray(value)) return value.map((child) => rotateSecretPayloads(child, rotate, keyId));
  if (!value || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rotateSecretPayloads(child, rotate, keyId)]));
}
