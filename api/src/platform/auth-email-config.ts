// Config-driven BYO auth-email sender — OPEN CORE.
//
// Lets a SELF-HOSTER deliver the pre-workspace auth emails (magic-link, signup
// invite, and — once those flows are wired — verify/reset) through their own
// SMTP server or a transactional API (Mailgun / Resend / Postmark), purely by
// setting env. Open core registers NO sender by default: magic-link falls back
// to the inline dev link, invites to copy-the-link. The cloud overlay's MANAGED
// sender takes precedence when present — it registers later (in its module
// onBoot, after this), and the seam is last-registration-wins.
//
// Env (all optional; the sender registers only if one provider is fully
// configured). docker-compose passes an unset optional var as "" (not
// undefined), so "" is treated as absent throughout — see core CLAUDE.md §14.6.
//
//   COBBLR_AUTH_EMAIL_PROVIDER   smtp | mailgun | resend | postmark  (default smtp)
//   COBBLR_AUTH_EMAIL_FROM       From header, e.g. "Cobblr <noreply@you.com>"
//                                (defaults to COBBLR_AUTH_SMTP_USER for smtp)
//   smtp:     COBBLR_AUTH_SMTP_HOST / _PORT / _USER / _PASS / _SECURE
//   mailgun:  COBBLR_AUTH_MAILGUN_API_KEY / _DOMAIN / _EU
//   resend:   COBBLR_AUTH_RESEND_API_KEY
//   postmark: COBBLR_AUTH_POSTMARK_TOKEN

import { platform, type AuthEmailMessage, type AuthEmailSender } from "@cobblr/platform-contract";
import {
  checkEmailConfig,
  sendEmailVia,
  type EmailConfig,
  type EmailProvider,
} from "./email-send.js";

/** Read an env var, treating unset OR empty/whitespace as absent (§14.6). */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}
function envBool(name: string): boolean | undefined {
  const v = env(name);
  return v === undefined ? undefined : v.toLowerCase() === "true";
}
function envNum(name: string): number | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Any of these set → the operator intends to configure auth email. */
const TRIGGER_VARS = [
  "COBBLR_AUTH_EMAIL_PROVIDER",
  "COBBLR_AUTH_EMAIL_FROM",
  "COBBLR_AUTH_SMTP_HOST",
  "COBBLR_AUTH_MAILGUN_API_KEY",
  "COBBLR_AUTH_RESEND_API_KEY",
  "COBBLR_AUTH_POSTMARK_TOKEN",
];

/** Build the base EmailConfig (no `to`) from env for the chosen provider. */
export function buildAuthEmailConfigFromEnv(): EmailConfig {
  const provider = (env("COBBLR_AUTH_EMAIL_PROVIDER") ?? "smtp") as EmailProvider;
  const base: EmailConfig = {
    provider,
    from: env("COBBLR_AUTH_EMAIL_FROM") ?? env("COBBLR_AUTH_SMTP_USER"),
  };
  switch (provider) {
    case "smtp":
      return {
        ...base,
        smtp_host: env("COBBLR_AUTH_SMTP_HOST"),
        smtp_port: envNum("COBBLR_AUTH_SMTP_PORT"),
        smtp_user: env("COBBLR_AUTH_SMTP_USER"),
        smtp_pass: env("COBBLR_AUTH_SMTP_PASS"),
        smtp_secure: envBool("COBBLR_AUTH_SMTP_SECURE"),
      };
    case "mailgun":
      return {
        ...base,
        mailgun_api_key: env("COBBLR_AUTH_MAILGUN_API_KEY"),
        mailgun_domain: env("COBBLR_AUTH_MAILGUN_DOMAIN"),
        mailgun_eu: envBool("COBBLR_AUTH_MAILGUN_EU"),
      };
    case "resend":
      return { ...base, resend_api_key: env("COBBLR_AUTH_RESEND_API_KEY") };
    case "postmark":
      return { ...base, postmark_token: env("COBBLR_AUTH_POSTMARK_TOKEN") };
    default:
      return base; // unknown provider — checkEmailConfig rejects below
  }
}

/** Build the BYO auth-email sender from env, or null if no provider is fully
 *  configured. Pure — does NOT touch `platform()` — so it's unit-testable
 *  without mocking the contract. The registration wrapper does the wiring. */
export function buildAuthEmailSender(): AuthEmailSender | null {
  if (!TRIGGER_VARS.some((n) => env(n) !== undefined)) return null; // open-core default: none

  const base = buildAuthEmailConfigFromEnv();
  const check = checkEmailConfig(base, false); // `to` filled per-send
  if (!check.ok) {
    console.warn(
      `[auth-email] BYO sender NOT registered — ${check.reason}. Auth emails fall back to the dev link.`,
    );
    return null;
  }
  const valid = check.config;
  console.log(
    `[auth-email] BYO sender registered (provider=${valid.provider}, from ${valid.from}).`,
  );
  return async (msg: AuthEmailMessage) => {
    const perSend = checkEmailConfig({ ...valid, to: msg.to }, true);
    if (!perSend.ok) throw new Error(perSend.reason);
    await sendEmailVia(perSend.config, msg.subject, msg.text, msg.html);
  };
}

/** Register the BYO auth-email sender iff a provider is fully configured via
 *  env. Call at boot BEFORE module load so the cloud overlay's managed sender
 *  (registered in its onBoot) wins when present. */
export function registerConfiguredAuthEmailSender(): void {
  const sender = buildAuthEmailSender();
  if (sender) platform().auth.registerEmailSender(sender);
}
