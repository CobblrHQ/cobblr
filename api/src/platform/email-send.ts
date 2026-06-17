// Shared email-sending primitives — provider config + per-provider transport.
//
// Cobblr hosts NO outbound mail; delivery is always brought by the operator/user
// via one of these providers. Used by BOTH:
//   - the notification email channel (per-subscription config, channels/email.ts)
//   - the platform BYO auth-email sender (env config, auth-email-config.ts)
//
//   provider: "smtp"      → any SMTP server (Gmail app password, Fastmail, SES
//                           SMTP, …). Fields: smtp_host, smtp_port, smtp_user,
//                           smtp_pass, smtp_secure?, from, to.
//   provider: "mailgun"   → Mailgun HTTP API. Fields: mailgun_api_key,
//                           mailgun_domain, mailgun_eu?, from, to.
//   provider: "resend"    → Resend HTTP API. Fields: resend_api_key, from, to.
//   provider: "postmark"  → Postmark HTTP API. Fields: postmark_token, from, to.
//
// Body is always plain text — no HTML — which keeps every provider's payload
// trivial and dodges email-client rendering quirks.

import nodemailer from "nodemailer";

export type EmailProvider = "smtp" | "mailgun" | "resend" | "postmark";

export interface EmailConfig {
  provider?: EmailProvider;
  from?: string;
  to?: string;
  // smtp
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_secure?: boolean;
  // mailgun
  mailgun_api_key?: string;
  mailgun_domain?: string;
  mailgun_eu?: boolean;
  // resend
  resend_api_key?: string;
  // postmark
  postmark_token?: string;
}

/** Required string fields per provider (beyond the always-required from [+ to]). */
export const REQUIRED: Record<EmailProvider, (keyof EmailConfig)[]> = {
  smtp: ["smtp_host", "smtp_user", "smtp_pass"],
  mailgun: ["mailgun_api_key", "mailgun_domain"],
  resend: ["resend_api_key"],
  postmark: ["postmark_token"],
};

export type ValidConfig = EmailConfig & { provider: EmailProvider; from: string; to: string };

export type CheckResult = { ok: true; config: ValidConfig } | { ok: false; reason: string };

/** Validate a config for its chosen provider. `provider` defaults to "smtp".
 *  Pass requireTo=false when the recipient is supplied per-send (the auth
 *  sender fills `to` from the message, not the static config). */
export function checkEmailConfig(cfg: EmailConfig, requireTo = true): CheckResult {
  const provider = (cfg.provider ?? "smtp") as EmailProvider;
  if (!REQUIRED[provider]) return { ok: false, reason: `unknown provider "${provider}"` };
  const need: (keyof EmailConfig)[] = [
    "from",
    ...(requireTo ? (["to"] as (keyof EmailConfig)[]) : []),
    ...REQUIRED[provider],
  ];
  const missing = need.filter((k) => typeof cfg[k] !== "string" || cfg[k] === "");
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(", ")}` };
  return { ok: true, config: { ...cfg, provider, from: cfg.from!, to: cfg.to ?? "" } };
}

const TIMEOUT_MS = 8000;

async function sendSmtp(cfg: ValidConfig, subject: string, text: string, html?: string): Promise<void> {
  const port = cfg.smtp_port ?? 465;
  // 465 = implicit TLS; 587/other = STARTTLS, unless explicitly overridden.
  const secure = cfg.smtp_secure ?? port === 465;
  const transport = nodemailer.createTransport({
    host: cfg.smtp_host,
    port,
    secure,
    auth: { user: cfg.smtp_user!, pass: cfg.smtp_pass! },
    connectionTimeout: 5000,
    socketTimeout: 5000,
  });
  try {
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject, text, ...(html ? { html } : {}) });
  } finally {
    transport.close();
  }
}

async function expectOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

async function sendMailgun(cfg: ValidConfig, subject: string, text: string, html?: string): Promise<void> {
  const base = cfg.mailgun_eu ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const form = new URLSearchParams({ from: cfg.from, to: cfg.to, subject, text });
  if (html) form.set("html", html);
  const res = await fetch(`${base}/v3/${encodeURIComponent(cfg.mailgun_domain!)}/messages`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`api:${cfg.mailgun_api_key}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await expectOk(res);
}

async function sendResend(cfg: ValidConfig, subject: string, text: string, html?: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.resend_api_key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.from, to: cfg.to, subject, text, ...(html ? { html } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await expectOk(res);
}

async function sendPostmark(cfg: ValidConfig, subject: string, text: string, html?: string): Promise<void> {
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "x-postmark-server-token": cfg.postmark_token!, "content-type": "application/json" },
    body: JSON.stringify({ From: cfg.from, To: cfg.to, Subject: subject, TextBody: text, ...(html ? { HtmlBody: html } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await expectOk(res);
}

const SENDERS: Record<EmailProvider, (cfg: ValidConfig, subject: string, text: string, html?: string) => Promise<void>> = {
  smtp: sendSmtp,
  mailgun: sendMailgun,
  resend: sendResend,
  postmark: sendPostmark,
};

/** Deliver one plain-text email through the config's provider. Throws on failure. */
/** Reserved/test TLDs can't receive mail by definition (RFC 2606/6761) —
 *  demo and e2e accounts sign up as `…@x.local` / `…@club.local`, and
 *  actually handing those to a real SMTP relay just burns the sender's
 *  reputation on guaranteed bounces. */
export function isUndeliverableTestAddress(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return true;
  if (/\.(local|test|invalid|example|localhost)$/.test(domain)) return true;
  if (domain === "localhost" || domain === "example.com" || domain === "example.org") return true;
  return false;
}

export async function sendEmailVia(cfg: ValidConfig, subject: string, text: string, html?: string): Promise<void> {
  if (cfg.to && isUndeliverableTestAddress(cfg.to)) {
    console.log(`[email] skipping send to reserved/test address ${cfg.to}`);
    return;
  }
  await SENDERS[cfg.provider](cfg, subject, text, html);
}
