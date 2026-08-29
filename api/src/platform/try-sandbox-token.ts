// The sandbox link's token, on its own.
//
// Split out from try-sandbox.ts so it can be tested without pulling in the env
// schema, the meta pool and the auth modules — the same reason the request
// guard keeps its `decide()` pure and reap-trials exports its filters. The
// thing worth pinning here (a link that IS a credential, stored hashed) should
// not need a database to check.
import { createHash, randomBytes } from "node:crypto";

/** 18 random bytes → 24 URL-safe characters ≈ 143 bits of entropy.
 *
 *  There is no account and no second factor behind a sandbox link, so guessing
 *  it IS the attack; this is sized for that rather than for looking tidy in a
 *  URL bar. */
export function mintSandboxToken(): { plain: string; hash: string } {
  const plain = randomBytes(18).toString("base64url");
  return { plain, hash: hashToken(plain) };
}

/** Only the hash is ever stored, exactly as auth_magic_tokens does it, so a
 *  meta-database dump does not hand out live sandboxes. */
export function hashToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}
