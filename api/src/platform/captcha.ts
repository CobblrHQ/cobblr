// Server-side signup captcha. Provider-agnostic; Cloudflare Turnstile today.
//
// Enforced ONLY when a provider + secret are configured
// (COBBLR_CAPTCHA_PROVIDER + COBBLR_CAPTCHA_SECRET). Unconfigured =>
// captchaEnabled() is false and verify() is a no-op pass, so self-host and prod
// (which don't set it) are unaffected; the trial box turns it on. The public
// SITE key is a build-time web var (VITE_CAPTCHA_SITE_KEY), never needed here.

const SITEVERIFY: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

export function captchaEnabled(): boolean {
  const provider = (process.env.COBBLR_CAPTCHA_PROVIDER ?? "").trim();
  return !!provider && !!(process.env.COBBLR_CAPTCHA_SECRET ?? "").trim() && provider in SITEVERIFY;
}

// Returns true if the request may proceed. Fail-CLOSED: a missing token, an
// unknown provider, or a verify error all return false when captcha is on.
export async function verifyCaptcha(token: string | undefined, ip?: string): Promise<boolean> {
  if (!captchaEnabled()) return true;
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
