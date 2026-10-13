// A workspace's own outbound email: the one door through which Cobblr mails
// somebody who is not a member of the workspace (a shop's customer), from the
// workspace's own address, through the provider the workspace brought.
//
// Why a door of its own. Everything else Cobblr sends goes to a member: the
// notification channels deliver to the person who subscribed, and the
// platform's auth mailer carries sign-in and account mail. Neither may carry a
// shop's words to its customer: the first has no customer to send to, and the
// second would put the hosted service's domain on mail it did not write, for
// any workspace that asked (#4051). So the workspace brings its provider, the
// same four shapes as the notification email channel (email-send.ts), and with
// none configured nothing is sent.
//
// Every send is written to outbound_email_log HERE, by the function that
// sends, including a failure and a skip. A caller cannot send without a
// record, so "was this customer emailed, by whom, when" always has an answer.
// And a send names the member who pressed it: there is no automated path to a
// third party, and `sentBy` is required so one cannot be added by accident.

import { meta } from "../db/meta.js";
import { checkEmailConfig, sendEmailVia, type EmailConfig, type EmailProvider } from "./email-send.js";
import { decryptCredentials, encryptCredentials } from "./integrations.js";

/** Config keys that are secrets: accepted on write, never returned. */
const SECRET_KEYS = ["smtp_pass", "mailgun_api_key", "resend_api_key", "postmark_token", "gmail_refresh_token"] as const;

export interface OutboundEmailStatus {
  configured: boolean;
  provider: EmailProvider | null;
  from: string | null;
  /** The non-secret settings, for the form to show again. */
  settings: Record<string, unknown>;
  /** Which secrets are stored, by key, so the form can say "saved" without
   *  showing them. */
  secretsSet: string[];
  updatedAt: string | null;
}

async function readRow(orgId: string) {
  return meta.selectFrom("org_outbound_email").selectAll().where("org_id", "=", orgId).executeTakeFirst();
}

async function readConfig(orgId: string): Promise<EmailConfig | null> {
  const row = await readRow(orgId);
  if (!row) return null;
  return (await decryptCredentials(orgId, row.config_enc)) as EmailConfig;
}

export async function outboundEmailStatus(orgId: string): Promise<OutboundEmailStatus> {
  const row = await readRow(orgId);
  if (!row) return { configured: false, provider: null, from: null, settings: {}, secretsSet: [], updatedAt: null };
  const cfg = (await decryptCredentials(orgId, row.config_enc)) as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) {
      if (v) secretsSet.push(k);
    } else {
      settings[k] = v;
    }
  }
  return {
    configured: true,
    provider: row.provider,
    from: row.from_address,
    settings,
    secretsSet,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Save the workspace's provider. A secret left blank keeps the stored one, so
 *  editing the From address does not mean re-pasting a password. Refuses a
 *  config its provider could not send with, naming what is missing. */
export async function saveOutboundEmail(
  orgId: string,
  userId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; status: OutboundEmailStatus } | { ok: false; reason: string }> {
  // Gmail is connected through Google's consent screen (saveGmailSender),
  // never typed: its token is Google's to hand over.
  if (input.provider === "gmail") return { ok: false, reason: "connect Gmail with its own button, so Google asks the account's owner" };
  const previous = (await readConfig(orgId)) ?? {};
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === "" || v == null) continue;
    next[k] = v;
  }
  for (const k of SECRET_KEYS) {
    if (next[k] == null && (previous as Record<string, unknown>)[k] != null && (previous.provider ?? "smtp") === (next.provider ?? "smtp")) {
      next[k] = (previous as Record<string, unknown>)[k];
    }
  }
  delete next.to;
  const check = checkEmailConfig(next as EmailConfig, false);
  if (!check.ok) return { ok: false, reason: check.reason };
  const configEnc = await encryptCredentials(orgId, next);
  await meta
    .insertInto("org_outbound_email")
    .values({ org_id: orgId, provider: check.config.provider, from_address: check.config.from, config_enc: configEnc, updated_by: userId })
    .onConflict((oc) =>
      oc.column("org_id").doUpdateSet({
        provider: check.config.provider,
        from_address: check.config.from,
        config_enc: configEnc,
        updated_by: userId,
        updated_at: new Date(),
      }),
    )
    .execute();
  return { ok: true, status: await outboundEmailStatus(orgId) };
}

/** The Gmail account a workspace connected (#6070, slice 3d): it sends as
 *  that address, with a grant that can send and nothing else. Replaces any
 *  other provider, as saving one does. */
export async function saveGmailSender(orgId: string, userId: string, grant: { email: string; refresh_token: string }): Promise<OutboundEmailStatus> {
  const previous = await readRow(orgId);
  const config = { provider: "gmail", from: grant.email, gmail_refresh_token: grant.refresh_token };
  const configEnc = await encryptCredentials(orgId, config);
  const values = { provider: "gmail" as const, from_address: grant.email, config_enc: configEnc, updated_by: userId, updated_at: new Date() };
  await meta
    .insertInto("org_outbound_email")
    .values({ org_id: orgId, ...values })
    .onConflict((oc) => oc.column("org_id").doUpdateSet(values))
    .execute();
  if (previous?.provider === "gmail") await revokeGmail(orgId, previous.config_enc, grant.refresh_token);
  return outboundEmailStatus(orgId);
}

/** End a replaced or removed Gmail grant at Google, best effort: the local
 *  secret is gone either way. */
async function revokeGmail(orgId: string, configEnc: string, keep?: string): Promise<void> {
  const cfg = (await decryptCredentials(orgId, configEnc).catch(() => ({}))) as Record<string, unknown>;
  const token = typeof cfg.gmail_refresh_token === "string" ? cfg.gmail_refresh_token : null;
  if (!token || token === keep) return;
  const { revokeGoogleToken } = await import("./mail-source/google-oauth.js");
  if (!(await revokeGoogleToken(token))) console.warn(`[outbound-email] could not revoke the Gmail grant of ${orgId} at Google; it is deleted here`);
}

export async function deleteOutboundEmail(orgId: string): Promise<void> {
  const row = await readRow(orgId);
  await meta.deleteFrom("org_outbound_email").where("org_id", "=", orgId).execute();
  if (row?.provider === "gmail") await revokeGmail(orgId, row.config_enc);
}

export interface OutboundSend {
  to: string;
  subject: string;
  text: string;
  /** The member who pressed send. Required: nothing mails a third party on
   *  its own. */
  sentBy: string;
  replyTo?: string;
  /** What the mail is about, for the log and for the record's own history. */
  source?: { kind: string; id: string };
}

export type OutboundSendResult =
  | { ok: true; logId: string; messageId: string | null; status: "sent" | "skipped" }
  | { ok: false; logId: string | null; reason: "not_configured" | "no_sender" | "bad_address" | "failed"; message: string };

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function log(orgId: string, m: OutboundSend, status: "sent" | "failed" | "skipped", messageId: string | null, error: string | null): Promise<string> {
  const row = await meta
    .insertInto("outbound_email_log")
    .values({
      org_id: orgId,
      to_address: m.to,
      subject: m.subject,
      sent_by: m.sentBy,
      source_kind: m.source?.kind ?? null,
      source_id: m.source?.id ?? null,
      status,
      message_id: messageId,
      error,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Send one email from the workspace, and record it. */
export async function sendFromWorkspace(orgId: string, m: OutboundSend): Promise<OutboundSendResult> {
  if (!m.sentBy) return { ok: false, logId: null, reason: "no_sender", message: "A person has to send this." };
  if (!ADDRESS.test(m.to.trim())) return { ok: false, logId: null, reason: "bad_address", message: `${m.to} is not an email address.` };
  const cfg = await readConfig(orgId);
  if (!cfg) return { ok: false, logId: null, reason: "not_configured", message: "This workspace has no outbound email set up." };
  const check = checkEmailConfig({ ...cfg, to: m.to.trim() }, true);
  if (!check.ok) return { ok: false, logId: null, reason: "not_configured", message: `Outbound email is set up incompletely (${check.reason}).` };
  try {
    const out = await sendEmailVia(check.config, m.subject, m.text, undefined, m.replyTo ? { replyTo: m.replyTo } : undefined);
    if (out.skipped) {
      const logId = await log(orgId, m, "skipped", null, "an address that cannot receive mail");
      return { ok: true, logId, messageId: null, status: "skipped" };
    }
    const logId = await log(orgId, m, "sent", out.messageId, null);
    return { ok: true, logId, messageId: out.messageId, status: "sent" };
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    const logId = await log(orgId, m, "failed", null, message);
    return { ok: false, logId, reason: "failed", message: `The email did not send: ${message}` };
  }
}

export async function outboundEmailLog(orgId: string, source?: { kind: string; id: string }, limit = 50) {
  let q = meta.selectFrom("outbound_email_log").selectAll().where("org_id", "=", orgId);
  if (source) q = q.where("source_kind", "=", source.kind).where("source_id", "=", source.id);
  return q.orderBy("created_at", "desc").limit(limit).execute();
}
