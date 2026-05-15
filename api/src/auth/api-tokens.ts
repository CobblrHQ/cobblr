// Long-lived API tokens for CLI/AI/agent use. Distinct from session
// JWTs in /auth/jwt.ts — these are user-minted, persist in the DB,
// can be revoked, and may be non-expiring.
//
// Wire format: `cbt_<48 base64url chars>`. We store SHA-256 hash;
// auth lookup is by hash.

import { createHash, randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";

const PREFIX = "cbt_";
const RANDOM_BYTES = 36; // 36 bytes → 48 base64url chars

export function mintTokenString(): { plaintext: string; hash: string; tokenPrefix: string } {
  const random = randomBytes(RANDOM_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const plaintext = PREFIX + random;
  const hash = createHash("sha256").update(plaintext).digest("hex");
  // First 12 chars (incl. "cbt_") for UI display.
  const tokenPrefix = plaintext.slice(0, 12);
  return { plaintext, hash, tokenPrefix };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Look up an active token by its plaintext value. Returns null if
 *  not found, revoked, or expired. Updates last_used_at on hit. */
export async function resolveApiToken(
  plaintext: string,
): Promise<{ userId: string; tokenId: string } | null> {
  if (!plaintext.startsWith(PREFIX)) return null;
  const hash = hashToken(plaintext);
  const row = await meta
    .selectFrom("api_tokens")
    .select(["id", "user_id", "expires_at", "revoked_at"])
    .where("token_hash", "=", hash)
    .executeTakeFirst();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

  // Touch last_used_at — best-effort, don't block auth on it.
  void meta
    .updateTable("api_tokens")
    .set({ last_used_at: new Date() })
    .where("id", "=", row.id)
    .execute()
    .catch((err) => console.error("[api-tokens] last_used update failed:", err));

  return { userId: row.user_id, tokenId: row.id };
}
