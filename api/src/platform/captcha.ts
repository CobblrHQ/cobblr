// Server-side signup captcha. Provider-agnostic; Cloudflare Turnstile today.
//
// Enforced ONLY when a provider + secret are configured
// (COBBLR_CAPTCHA_PROVIDER + COBBLR_CAPTCHA_SECRET). Unconfigured =>
// captchaEnabled() is false and verify() is a no-op pass, so self-host and prod
// (which don't set it) are unaffected; the trial box turns it on. The public
// SITE key is a build-time web var (VITE_CAPTCHA_SITE_KEY), never needed here.

import { timingSafeEqual } from "node:crypto";

const SITEVERIFY: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

/** The PUBLIC site key, for a page the api renders itself.
 *
 *  The comment above is right that the web build normally carries this as
 *  VITE_CAPTCHA_SITE_KEY — but GET /try is a link a stranger opens directly, so
 *  the api has to be able to draw the widget without the SPA. Returns null when
 *  it is unset or not the plain token shape every provider uses, so it can never
 *  become an injection point in the markup that embeds it.
 */
export function captchaSiteKey(): string | null {
  const key = (process.env.COBBLR_CAPTCHA_SITE_KEY ?? "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
}

export function captchaEnabled(): boolean {
  const provider = (process.env.COBBLR_CAPTCHA_PROVIDER ?? "").trim();
  return !!provider && !!(process.env.COBBLR_CAPTCHA_SECRET ?? "").trim() && provider in SITEVERIFY;
}

/** The header a designated automated reviewer presents instead of solving the
 *  widget. Name only; the value lives in the env and with whoever the operator
 *  handed it to. */
export const CAPTCHA_REVIEW_HEADER = "x-cobblr-captcha-review";

/** Is this request a designated automated reviewer? True only when the operator
 *  has set COBBLR_CAPTCHA_REVIEW_TOKEN and the request presents exactly that.
 *
 *  WHY: a captcha's job is to refuse an automated browser, and it does that job
 *  on the browsers we ASK to be driven. An AI agent reviewing the new-user flow
 *  on the sandbox stopped at the Turnstile checkbox (2026-09-12). The two ways
 *  round it without this were both wrong: Turnstile's published test keys pass
 *  every bot on the internet, on a box with public signup on; and hand-minting a
 *  session means the review never touches the signup path it was meant to test.
 *
 *  So: one operator-issued secret, presented in a header, skipping siteverify for
 *  that request and nothing else. The rate limit and the disposable-email block
 *  still apply. Unset (the default everywhere) it does nothing. Every use is
 *  logged with the ip, so a leaked token shows in the log before it shows in the
 *  signup count, and rotating it is one env line.
 *
 *  Compared in constant time and refused under 32 characters: a short token is
 *  guessable, and a plain === leaks length and prefix through timing. */
export function isCaptchaReviewer(presented: string | undefined, ip?: string): boolean {
  const expected = (process.env.COBBLR_CAPTCHA_REVIEW_TOKEN ?? "").trim();
  if (expected.length < 32 || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  console.warn(`[captcha] review token used, siteverify skipped (ip=${ip ?? "?"})`);
  return true;
}

/** The slice of an Express request the captcha reads. Taking the request rather
 *  than loose strings is the point: with `(token, ip, header)` a second call
 *  site forgot the header, and the reviewer was let past signup but not past
 *  the sandbox start, which is the flow they were asked to review. */
export interface CaptchaRequest {
  ip?: string | undefined;
  get(name: string): string | undefined;
}

// Returns true if the request may proceed. Fail-CLOSED: a missing token, an
// unknown provider, or a verify error all return false when captcha is on.
export async function verifyCaptcha(
  token: string | undefined,
  req?: CaptchaRequest,
): Promise<boolean> {
  if (!captchaEnabled()) return true;
  const ip = req?.ip;
  if (isCaptchaReviewer(req?.get(CAPTCHA_REVIEW_HEADER), ip)) return true;
  if (!token) return false;
  const provider = (process.env.COBBLR_CAPTCHA_PROVIDER ?? "").trim();
  const url = SITEVERIFY[provider];
  if (!url) return false;
  try {
    const body = new URLSearchParams({ secret: process.env.COBBLR_CAPTCHA_SECRET!.trim(), response: token });
    if (ip) body.set("remoteip", ip);
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false; // network/timeout -> fail closed
  }
}
