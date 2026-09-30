// The email provider fields: the one list the notification email channel and
// the workspace's own outbound email both show, so the two forms cannot drift.
// The providers themselves live in api/src/platform/email-send.ts.

export interface EmailProviderField {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "url" | "select" | "checkbox";
  placeholder?: string;
  helpText?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string;
  showIf?: { key: string; in: string[] };
}

/** Provider, From, then each provider's own settings. `to` is not here: who a
 *  mail goes to belongs to whoever sends it. */
export const EMAIL_PROVIDER_FIELDS: EmailProviderField[] = [
  {
    key: "provider",
    label: "Provider",
    type: "select",
    default: "smtp",
    options: [
      { value: "smtp", label: "SMTP (Gmail, Fastmail, SES SMTP, …)" },
      { value: "mailgun", label: "Mailgun (HTTP API)" },
      { value: "resend", label: "Resend (HTTP API)" },
      { value: "postmark", label: "Postmark (HTTP API)" },
    ],
  },
  { key: "from", label: "From", placeholder: "cobblr@example.com" },
  // SMTP
  { key: "smtp_host", label: "SMTP host", placeholder: "smtp.gmail.com", showIf: { key: "provider", in: ["smtp"] } },
  { key: "smtp_port", label: "Port", type: "number", placeholder: "465", helpText: "465 = TLS, 587 = STARTTLS", showIf: { key: "provider", in: ["smtp"] } },
  { key: "smtp_user", label: "Username", placeholder: "you@example.com", showIf: { key: "provider", in: ["smtp"] } },
  { key: "smtp_pass", label: "Password / app password", type: "password", helpText: "Gmail: an App Password (needs 2FA), not your account password. Free Gmail caps ~500/day.", showIf: { key: "provider", in: ["smtp"] } },
  // Mailgun
  { key: "mailgun_api_key", label: "Mailgun API key", type: "password", showIf: { key: "provider", in: ["mailgun"] } },
  { key: "mailgun_domain", label: "Mailgun domain", placeholder: "mg.example.com", showIf: { key: "provider", in: ["mailgun"] } },
  { key: "mailgun_eu", label: "EU region", type: "checkbox", helpText: "Tick if your Mailgun account is in the EU region.", showIf: { key: "provider", in: ["mailgun"] } },
  // Resend
  { key: "resend_api_key", label: "Resend API key", type: "password", placeholder: "re_…", showIf: { key: "provider", in: ["resend"] } },
  // Postmark
  { key: "postmark_token", label: "Postmark server token", type: "password", showIf: { key: "provider", in: ["postmark"] } },
];

/** The keys among them that are secrets: stored, never shown again. */
export const EMAIL_SECRET_KEYS = EMAIL_PROVIDER_FIELDS.filter((f) => f.type === "password").map((f) => f.key);
