// A pair code: a QR that signs one person's phone in as them, single use and
// short-lived. Two doors mint one and one redeems it (`/auth/pair/claim`):
// the person themselves from a desk (`/auth/pair/start`), and a workspace
// admin for one named member they brought in (#6692), so a worker who has
// never typed a password scans once and is in. Both mint here, so the code's
// strength, its hashing and its claim URLs cannot drift between them.
import type { Request } from "express";
import { createHash, randomBytes } from "node:crypto";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { meta } from "../db/meta.js";
import type { SessionUser } from "../auth/middleware.js";

/** A person's own code: long enough to find and unlock the phone beside them. */
export const PAIR_CODE_TTL_MS = 300 * 1000;
/** An admin's code for someone else: long enough to walk the phone over, and no longer. */
export const MEMBER_PAIR_CODE_TTL_MS = 600 * 1000;

/** Why this request may not mint a sign-in code, or null when it may. A code
 *  is a whole session for whoever scans it, so only a person signed in
 *  themselves mints one: never a token (an assistant, an MCP client, a script),
 *  an app's scoped token, or a borrowed View as. */
export function pairMintRefusal(session: SessionUser): string | null {
  if (session.auth_method !== "session" || session.app_scope || session.share_view) {
    return "Signing a phone in is a person's own step, from their own sign-in: not a token, an app or a shared view.";
  }
  return null;
}

export function hashPairCode(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export interface MintedPairCode {
  code: string;
  expires_at: string;
  claim_url: string;
  claim_options: Array<{ label: string; url: string }>;
}

/** Mint a code that signs `userId` in and lands them in `orgSlug`. The caller
 *  has already decided the minter may; `mintedBy` names an admin minting for
 *  someone else, whose earlier unclaimed codes for that person it voids. */
export async function mintPairCode(
  req: Request,
  opts: { userId: string; orgSlug: string; mintedBy?: string; ttlMs: number },
): Promise<MintedPairCode> {
  // DETACHED: housekeeping of expired codes; the next mint tries again
  void meta
    .deleteFrom("auth_pair_codes")
    .where("expires_at", "<", new Date(Date.now() - 3_600_000))
    .execute()
    .catch((err) => console.error("[pair-codes] reaper failed:", err));
  if (opts.mintedBy) await revokeMemberPairCodes(opts.userId, opts.orgSlug);
  // 128 bits, URL-safe: ample for a short-lived single-use code, and a
  // low-density QR. Stored hashed; the plaintext only goes out in this answer.
  const code = randomBytes(16).toString("base64url");
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  // check-then-insert: the key is a random pairing code minted here
  await meta
    .insertInto("auth_pair_codes")
    .values({
      user_id: opts.userId,
      org_slug: opts.orgSlug,
      code_hash: hashPairCode(code),
      expires_at: expiresAt,
      minted_by: opts.mintedBy ?? null,
      request_ip: (req.ip ?? null) as string | null,
      request_ua: (req.get("user-agent") ?? null) as string | null,
    })
    .execute();
  const claimOptions = pairClaimOptions(req, code);
  return { code, expires_at: expiresAt.toISOString(), claim_url: claimOptions[0]!.url, claim_options: claimOptions };
}

/** Void every unclaimed code an admin minted for this member in this
 *  workspace. Answers how many were still live. */
export async function revokeMemberPairCodes(userId: string, orgSlug: string): Promise<number> {
  const rows = await meta
    .updateTable("auth_pair_codes")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("org_slug", "=", orgSlug)
    .where("minted_by", "is not", null)
    .where("claimed_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .returning("id")
    .execute();
  return rows.length;
}

/** The phone visits /pair?code=… . Offer a claim URL for every base this
 *  server is reachable at: the request origin (on a tunnelled deploy that IS
 *  the phone-reachable public URL) plus an optional PUBLIC_BASE_URL for
 *  self-hosters who expose a separate LAN or VPN address. localhost bases are
 *  dropped when a real one exists (a phone can't resolve the desk's localhost). */
function pairClaimOptions(req: Request, code: string): Array<{ label: string; url: string }> {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  // HOST-OK: the claim URL is shown on this same caller's screen, and a self-hoster's LAN address is the one the phone can reach.
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host");
  const reqBase = host ? `${proto}://${host}`.replace(/\/+$/, "") : null;
  const pubBase = publicBaseUrl() || null;
  const bases: string[] = [];
  for (const b of [reqBase, pubBase]) {
    if (b && !bases.some((x) => x.toLowerCase() === b.toLowerCase())) bases.push(b);
  }
  const isLocal = (b: string) => /\/\/(localhost|127\.0\.0\.1)/i.test(b);
  const usable = bases.some((b) => !isLocal(b)) ? bases.filter((b) => !isLocal(b)) : bases;
  const options = usable.map((b) => {
    let label = b;
    try {
      label = new URL(b).host;
    } catch {
      /* non-URL base — keep verbatim */
    }
    return { label, url: `${b}/pair?code=${code}` };
  });
  if (options.length === 0) options.push({ label: "default", url: `/pair?code=${code}` });
  return options;
}
