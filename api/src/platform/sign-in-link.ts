// Minting and sending a sign-in link, in one place.
//
// Two doors need this: /auth/magic/request, where somebody asks for a link, and
// the sandbox's "keep this workspace", where somebody hands over an address and
// that link becomes the ONLY way back into what they just built. The second one
// was written against a comment describing this behaviour and never actually
// sent anything, so a visitor kept their workspace, had their anonymous link
// revoked, and was locked out of it the moment they closed the tab.
//
// Two copies of this would drift, and the half that drifts is the half nobody
// watches. So it lives here and both import it.
import { createHash, randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { sendAuthEmail } from "./hosted-seams.js";

export const MAGIC_TTL_MS = 15 * 60 * 1000;

export function hashMagicToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export function mintMagicToken(): { plain: string; hash: string } {
  // 32 bytes → 43-char URL-safe base64.
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashMagicToken(plain) };
}

export interface SignInLinkRequest {
  email: string;
  /** Scheme + host the link should point at, e.g. https://try.cobblr.xyz */
  absBase: string;
  subject?: string;
  /** First line of the mail, above the link. */
  intro?: string;
  requestIp?: string | null;
  requestUa?: string | null;
}

export interface SignInLinkResult {
  /** Whether an email actually left the building. False when no sender is
   *  configured, or the send threw. Callers MUST branch on this rather than
   *  assume: the sandbox revokes someone's only way in on the strength of it. */
  sent: boolean;
  /** The plaintext token, for dev flows that show the link inline. */
  plain: string;
  path: string;
  expiresAt: Date;
}

export async function issueSignInLink(req: SignInLinkRequest): Promise<SignInLinkResult> {
  const { plain, hash } = mintMagicToken();
  await meta
    .insertInto("auth_magic_tokens")
    .values({
      email: req.email,
      token_hash: hash,
      request_ip: (req.requestIp ?? null) as string | null,
      request_ua: (req.requestUa ?? null) as string | null,
    })
    .execute();

  const path = `/auth/magic?token=${encodeURIComponent(plain)}`;
  const absLink = `${req.absBase}${path}`;
  const sent = await sendAuthEmail({
    to: req.email,
    subject: req.subject ?? "Your Cobblr sign-in link",
    text:
      `${req.intro ?? "Sign in to Cobblr:"}\n\n${absLink}\n\n` +
      `The link expires shortly. If you didn't request it, you can ignore this email.`,
    kind: "magic_link",
  });

  return { sent, plain, path, expiresAt: new Date(Date.now() + MAGIC_TTL_MS) };
}
