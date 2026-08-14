// Say at boot which of the open-signup defences are actually on.
//
// THE FAILURE THIS EXISTS FOR (2026-08-13, on the trial box): captcha, required email
// verification, disposable-address blocking and the SMTP sender were all configured in
// that instance's .env, and NONE of them were in effect. The running containers had been
// recreated by an image-updater, which clones the previous container's environment
// rather than re-reading .env, so every edit since the last `compose up` had been
// silently dropped. Nothing was wrong with the config and nothing logged a problem — the
// signup page simply rendered with no captcha and handed out working sessions without a
// confirmed address. It was found by reading the container's environment by hand.
//
// A check cannot fix that, because a legitimate instance is allowed to run with all of
// these off: a personal box has no signup page for strangers. What it can do is make the
// state VISIBLE at the one moment somebody is looking, so "I set that" and "it is on"
// stop being the same sentence. Same shape and same reasoning as logAnnounceRouting().
//
// It shouts only when signup is open, because that is the only configuration in which a
// missing gate is a hole rather than a preference.

import { env } from "../env.js";
import { publicSignupEnabled } from "../auth/signup-gate.js";

const onOff = (on: boolean) => (on ? "ON" : "off");

/** True when a setting has a real value. Compose passes an unset variable as "", so a
 *  truthiness check is the only one that reads that as "not set" (CLAUDE.md 14.6). */
const isSet = (v: string | undefined) => !!v;

export function signupGateSummary(e: {
  captchaProvider?: string;
  captchaSecret?: string;
  requireEmailVerify?: string;
  blockDisposable?: string;
  perIpPerDay?: string;
  globalPerDay?: string;
  signupOpen: boolean;
}): { line: string; open: boolean; ungated: string[] } {
  // Captcha needs BOTH halves: a provider with no secret cannot verify anything, which
  // is a gate that looks configured and refuses nobody.
  const captcha = isSet(e.captchaProvider) && isSet(e.captchaSecret);
  const verify = e.requireEmailVerify === "true";
  const disposable = e.blockDisposable === "true";
  const perIp = isSet(e.perIpPerDay);
  const global = isSet(e.globalPerDay);

  const ungated: string[] = [];
  if (!captcha) ungated.push("captcha");
  if (!verify) ungated.push("email verification");
  if (!perIp && !global) ungated.push("signup rate limit");

  const line =
    `[signup] public signup ${onOff(e.signupOpen)} — ` +
    `captcha ${onOff(captcha)}, email verification ${onOff(verify)}, ` +
    `disposable-address blocking ${onOff(disposable)}, ` +
    `rate limit ${perIp || global ? `${e.perIpPerDay ?? "-"}/ip/day, ${e.globalPerDay ?? "-"}/day` : "off"}`;

  return { line, open: e.signupOpen, ungated };
}

export function logSignupGates(): void {
  const { line, open, ungated } = signupGateSummary({
    captchaProvider: env.COBBLR_CAPTCHA_PROVIDER,
    captchaSecret: env.COBBLR_CAPTCHA_SECRET,
    requireEmailVerify: env.COBBLR_REQUIRE_EMAIL_VERIFY,
    blockDisposable: env.COBBLR_BLOCK_DISPOSABLE_EMAILS,
    perIpPerDay: process.env.COBBLR_SIGNUP_MAX_PER_IP_PER_DAY,
    globalPerDay: process.env.COBBLR_SIGNUP_MAX_PER_DAY,
    signupOpen: publicSignupEnabled(),
  });

  if (open && ungated.length) {
    // Anyone on the internet can create an account here and these are not standing in
    // the way. Loud, because the usual way to reach this state is believing otherwise.
    console.warn(`${line}\n[signup] ⚠ signup is OPEN with no ${ungated.join(", no ")}`);
    return;
  }
  console.log(line);
}
