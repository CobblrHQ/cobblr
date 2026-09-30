// Long-lived API tokens for CLI/AI/agent use. Distinct from session
// JWTs in /auth/jwt.ts — these are user-minted, persist in the DB,
// can be revoked, and may be non-expiring.
//
// Wire format: `cbt_<48 base64url chars>`. We store SHA-256 hash;
// auth lookup is by hash.

import { createHash, randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { isTokenAccess, type TokenAccess } from "./token-access.js";

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
): Promise<{
  userId: string;
  tokenId: string;
  scopes: string[] | null;
  /** 'look' | 'change' | 'full', or null for a token minted before access levels (full). */
  access: TokenAccess | null;
  /** The one workspace the token may reach (its slug read fresh, so a renamed
   *  workspace keeps its tokens), or null for every workspace. */
  orgId: string | null;
  orgSlug: string | null;
  /** The MCP resource an OAuth connector's access token was issued for (its
   *  audience); null for a personal token. */
  audience: string | null;
} | null> {
  if (!plaintext.startsWith(PREFIX)) return null;
  const hash = hashToken(plaintext);
  const row = await meta
    .selectFrom("api_tokens as t")
    .leftJoin("orgs as o", "o.id", "t.org_id")
    .select(["t.id as id", "t.user_id as user_id", "t.expires_at as expires_at", "t.revoked_at as revoked_at", "t.scopes as scopes", "t.access as access", "t.org_id as org_id", "o.slug as org_slug", "t.source as source", "t.meta as meta", "t.parent_token_id as parent_token_id"])
    .where("t.token_hash", "=", hash)
    .executeTakeFirst();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  // A token made with another token lives only while every token above it
  // does (auth/token-lineage.ts): the revoke cascades, and this is the
  // backstop for one that expired rather than being revoked.
  let parentId = row.parent_token_id;
  for (let depth = 0; parentId && depth < 8; depth++) {
    const p = await meta.selectFrom("api_tokens").select(["parent_token_id", "revoked_at", "expires_at"]).where("id", "=", parentId).executeTakeFirst();
    if (!p || p.revoked_at || (p.expires_at && new Date(p.expires_at) < new Date())) return null;
    parentId = p.parent_token_id;
  }

  // Touch last_used_at — best-effort, don't block auth on it.
  void meta
    .updateTable("api_tokens")
    .set({ last_used_at: new Date() })
    .where("id", "=", row.id)
    .execute()
    .catch((err) => console.error("[api-tokens] last_used update failed:", err));

  const scopes =
    Array.isArray(row.scopes) && row.scopes.length > 0 ? (row.scopes as string[]) : null;
  return {
    userId: row.user_id,
    tokenId: row.id,
    scopes,
    access: isTokenAccess(row.access) ? row.access : null,
    orgId: row.org_id ?? null,
    orgSlug: row.org_slug ?? null,
    audience:
      row.source === "oauth" && row.meta && typeof row.meta === "object" && typeof (row.meta as { resource?: unknown }).resource === "string"
        ? (row.meta as { resource: string }).resource
        : null,
  };
}
