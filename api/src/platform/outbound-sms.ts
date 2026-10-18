// A workspace's own text messages (#6070, slice 3c): the Twilio account the
// workspace brought, the one way an automation texts someone outside it.
//
// The same shape as outbound-email.ts and for the same reason: a text to
// someone who is not a member carries the workspace's words from the
// workspace's own number, through its own account, never Cobblr's. With none
// set up nothing is sent. The SID and token are encrypted with the
// workspace's credentials key and never returned or backed up.
//
// A number in the range set aside for fiction (+1 NPA 555 0100 to 0199)
// cannot receive a text by definition, so a send to one is logged as sent
// and never leaves the box: what the tests and walks use.

// EGRESS-FILE: vendor-fixed - the SMS provider's API host, written in the code
import { meta } from "../db/meta.js";
import { normalisePhone } from "../lib/phone.js";
import { decryptCredentials, encryptCredentials } from "./integrations.js";

export interface SmsConfig {
  account_sid: string;
  auth_token: string;
  from_number: string;
}

export interface OutboundSmsStatus {
  configured: boolean;
  from: string | null;
  account_sid: string | null;
  tokenSet: boolean;
  updatedAt: string | null;
}

/** A North American number in the 555-0100 to 0199 range, set aside for
 *  fiction: nobody can receive a text there. */
export function isFictionalNumber(e164: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(e164);
}

async function readRow(orgId: string) {
  return meta.selectFrom("org_outbound_sms").selectAll().where("org_id", "=", orgId).executeTakeFirst();
}

async function readConfig(orgId: string): Promise<SmsConfig | null> {
  const row = await readRow(orgId);
  if (!row) return null;
  const c = await decryptCredentials(orgId, row.config_enc);
  return typeof c.account_sid === "string" && typeof c.auth_token === "string" && typeof c.from_number === "string"
    ? { account_sid: c.account_sid, auth_token: c.auth_token, from_number: c.from_number }
    : null;
}

export async function outboundSmsStatus(orgId: string): Promise<OutboundSmsStatus> {
  const row = await readRow(orgId);
  if (!row) return { configured: false, from: null, account_sid: null, tokenSet: false, updatedAt: null };
  const cfg = await decryptCredentials(orgId, row.config_enc);
  return {
    configured: true,
    from: row.from_number,
    account_sid: typeof cfg.account_sid === "string" ? cfg.account_sid : null,
    tokenSet: typeof cfg.auth_token === "string" && !!cfg.auth_token,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Save the workspace's Twilio account. A token left out keeps the saved one,
 *  so the form can change the number without asking for the secret again. */
export async function saveOutboundSms(
  orgId: string,
  userId: string,
  input: { account_sid?: unknown; auth_token?: unknown; from_number?: unknown },
): Promise<{ ok: true; status: OutboundSmsStatus } | { ok: false; reason: string }> {
  const now = await readConfig(orgId);
  const sid = typeof input.account_sid === "string" ? input.account_sid.trim() : (now?.account_sid ?? "");
  const token = typeof input.auth_token === "string" && input.auth_token.trim() ? input.auth_token.trim() : (now?.auth_token ?? "");
  const from = typeof input.from_number === "string" ? normalisePhone(input.from_number) : (now?.from_number ?? null);
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) return { ok: false, reason: "the Account SID starts with AC and has 32 letters and digits after it" };
  if (!token) return { ok: false, reason: "the Auth Token is missing" };
  if (!from) return { ok: false, reason: "the number to send from is in international form, starting with + and the country code" };
  const config: SmsConfig = { account_sid: sid, auth_token: token, from_number: from };
  const configEnc = await encryptCredentials(orgId, { ...config });
  const values = { from_number: from, config_enc: configEnc, updated_by: userId, updated_at: new Date() };
  await meta
    .insertInto("org_outbound_sms")
    .values({ org_id: orgId, ...values })
    .onConflict((oc) => oc.column("org_id").doUpdateSet(values))
    .execute();
  return { ok: true, status: await outboundSmsStatus(orgId) };
}

export async function deleteOutboundSms(orgId: string): Promise<void> {
  await meta.deleteFrom("org_outbound_sms").where("org_id", "=", orgId).execute();
}

export type SmsSendResult =
  | { ok: true; status: "sent" | "skipped"; sid: string | null }
  | { ok: false; reason: "not_configured" | "bad_number" | "failed"; message: string };

/** Text one number from the workspace's own account. */
export async function sendTextFromWorkspace(orgId: string, m: { to: string; text: string }): Promise<SmsSendResult> {
  const to = normalisePhone(m.to);
  if (!to) return { ok: false, reason: "bad_number", message: `${m.to} is not a phone number in international form.` };
  const cfg = await readConfig(orgId);
  if (!cfg) return { ok: false, reason: "not_configured", message: "This workspace has no text message sender set up." };
  if (isFictionalNumber(to)) {
    console.log(`[sms] skipping send to a number set aside for fiction ${to}`);
    return { ok: true, status: "skipped", sid: null };
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.account_sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: cfg.from_number, To: to, Body: m.text.slice(0, 1600) }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, reason: "failed", message: `Twilio said ${res.status}: ${(body.message ?? "no reason given").slice(0, 200)}` };
    return { ok: true, status: "sent", sid: body.sid ?? null };
  } catch (e) {
    return { ok: false, reason: "failed", message: `The text did not send: ${(e as Error).message.slice(0, 200)}` };
  }
}
