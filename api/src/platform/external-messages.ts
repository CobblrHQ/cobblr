// An automation messaging someone outside the workspace (#6070, slice 3a).
//
// The owner: a wire may ask the person who buys the coffee to get more,
// though they are not a member, but "we might want to disallow cloud users
// from using our email for this. They might need to provide their own email
// key". So this is the one door, and it is narrow:
//
//   - only through the workspace's own outbound email (outbound-email.ts:
//     SMTP, Mailgun, Resend or Postmark the workspace brought). That door
//     never uses Cobblr's mail, so a hosted workspace with no sender of its
//     own emails nobody, by construction;
//   - only once an owner or admin has said yes for the workspace
//     ("Allow wires to message people outside this workspace", off);
//   - within the workspace's daily limit and each wire's (20 and 5 unless
//     the owner changes them); one over is held, logged, and the owners are
//     told once that day;
//   - never to someone who asked to stop that wire's messages, and every
//     message says who set it up and carries the link that stops it;
//   - every attempt is in external_message_log, and every send in the
//     outbound email log, naming the member who made the wire.

import { productName } from "./product-name.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { absoluteAppUrl } from "./public-url.js";
import { readReplyToken, replyToken, type ReplyClaim } from "./external-message-tokens.js";
import { outboundEmailStatus, sendFromWorkspace } from "./outbound-email.js";
import { outboundSmsStatus, sendTextFromWorkspace } from "./outbound-sms.js";

export const HELD_EVENT = "platform.external_messages.held";

export interface ExternalMessagesSettings {
  enabled: boolean;
  dailyLimit: number;
  perWireDailyLimit: number;
  updatedBy: string | null;
}

export const DEFAULT_SETTINGS: ExternalMessagesSettings = { enabled: false, dailyLimit: 20, perWireDailyLimit: 5, updatedBy: null };

export async function externalMessagesSettings(orgId: string): Promise<ExternalMessagesSettings> {
  const row = await meta.selectFrom("org_external_messages").selectAll().where("org_id", "=", orgId).executeTakeFirst();
  if (!row) return DEFAULT_SETTINGS;
  return { enabled: row.enabled, dailyLimit: row.daily_limit, perWireDailyLimit: row.per_wire_daily_limit, updatedBy: row.updated_by };
}

export async function saveExternalMessagesSettings(
  orgId: string,
  userId: string,
  input: { enabled?: boolean; dailyLimit?: number; perWireDailyLimit?: number },
): Promise<ExternalMessagesSettings> {
  const now = await externalMessagesSettings(orgId);
  const next = {
    enabled: input.enabled ?? now.enabled,
    daily_limit: Math.max(1, Math.min(500, Math.round(input.dailyLimit ?? now.dailyLimit))),
    per_wire_daily_limit: Math.max(1, Math.min(100, Math.round(input.perWireDailyLimit ?? now.perWireDailyLimit))),
    updated_by: userId,
    updated_at: new Date(),
  };
  await meta
    .insertInto("org_external_messages")
    .values({ org_id: orgId, ...next })
    .onConflict((oc) => oc.column("org_id").doUpdateSet(next))
    .execute();
  return externalMessagesSettings(orgId);
}

/** How a message reaches someone outside: their email, or a text to their phone. */
export type ExternalVia = "email" | "text";

/** Why the workspace cannot message someone outside it, or null when it can. */
export async function externalMessagingRefusal(orgId: string, via: ExternalVia = "email"): Promise<string | null> {
  const settings = await externalMessagesSettings(orgId);
  if (!settings.enabled) return "messages to people outside this workspace are off; an owner or admin turns them on under Configuration, Email";
  if (via === "text") {
    const texts = await outboundSmsStatus(orgId);
    if (!texts.configured) return `this workspace has no text message sender of its own; add its Twilio account under Configuration, Email (${productName()} never texts people outside a workspace itself)`;
    return null;
  }
  const sender = await outboundEmailStatus(orgId);
  if (!sender.configured) return `this workspace has no email sender of its own; add one under Configuration, Email (${productName()}'s own mail is never used for people outside a workspace)`;
  return null;
}

// ── the stop link ────────────────────────────────────────────────────────

interface StopClaim { o: string; w: string; p: string }

function sign(payload: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(`external-stop:${payload}`).digest("base64url");
}

export function stopToken(c: StopClaim): string {
  const payload = Buffer.from(JSON.stringify(c)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readStopToken(token: string): StopClaim | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    // b64-lenient-ok: the signature was checked over the payload string as given, so only its one spelling reaches here.
    const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<StopClaim>;
    return typeof c.o === "string" && typeof c.w === "string" && typeof c.p === "string" ? { o: c.o, w: c.w, p: c.p } : null;
  } catch {
    return null;
  }
}

export async function stopMessages(claim: StopClaim): Promise<void> {
  await meta
    .insertInto("external_message_stops")
    .values({ org_id: claim.o, binding_id: claim.w, person_id: claim.p })
    .onConflict((oc) => oc.columns(["org_id", "binding_id", "person_id"]).doNothing())
    .execute();
}

// ── sending ──────────────────────────────────────────────────────────────

export interface ExternalMessage {
  orgId: string;
  /** The wire that fired. Required: only an automation comes through here. */
  bindingId: string;
  personId: string;
  text: string;
  record?: { kind: string; id: string; title: string | null } | null;
  /** Add a reply link: a page with "Got it" and "Bought it" (slice 3b). */
  replyLink?: boolean;
  /** Email (the default) or a text to their phone (slice 3c). */
  via?: ExternalVia;
}

export type ExternalResult =
  | { ok: true; status: "sent"; to: string; name: string }
  | { ok: false; status: "refused" | "held" | "stopped" | "failed"; reason: string };

async function record(m: ExternalMessage, to: string, status: string, reason: string | null, outboundLogId: string | null = null, body: string | null = null, id?: string): Promise<void> {
  await meta
    .insertInto("external_message_log")
    .values({
      ...(id ? { id } : {}),
      org_id: m.orgId,
      binding_id: m.bindingId,
      person_id: m.personId,
      to_address: to,
      body,
      record_kind: m.record?.kind ?? null,
      record_id: m.record?.id ?? null,
      status,
      reason,
      outbound_log_id: outboundLogId,
      channel: m.via ?? "email",
    })
    .execute();
}

async function sentToday(orgId: string, bindingId?: string): Promise<number> {
  let q = meta
    .selectFrom("external_message_log")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("status", "=", "sent")
    .where("created_at", ">=", sql<Date>`now() - interval '1 day'`);
  if (bindingId) q = q.where("binding_id", "=", bindingId);
  return Number((await q.executeTakeFirst())?.n ?? 0);
}

/** The owners and admins, told once a day that a message was held. */
async function tellOwnersHeld(orgId: string, why: string): Promise<void> {
  const already = await meta
    .selectFrom("external_message_log")
    .select("id")
    .where("org_id", "=", orgId)
    .where("status", "=", "held")
    .where("created_at", ">=", sql<Date>`now() - interval '1 day'`)
    .limit(2)
    .execute();
  if (already.length > 1) return;
  const members = await meta.selectFrom("org_memberships").select(["user_id", "role"]).where("org_id", "=", orgId).execute();
  const owners = members.filter((m) => roleSatisfies(m.role, ["admin"]));
  for (const o of owners) {
    // dispatch-per-row-ok: one notice to each owner and admin, at most once a day, not one per message held.
    await platform().notifications.dispatch({
        orgId,
        userId: o.user_id,
        eventType: HELD_EVENT,
        message: `An automation's message to someone outside the workspace was held: ${why}. Change the limit under Configuration, Email.`,
        // PAGE-LINK: the limits being held against live on this page; there is no one record to open.
        link_url: "/configuration/email",
      })
      .catch((err: unknown) => console.error(`[external-messages] could not tell ${o.user_id} a message was held:`, (err as Error).message));
  }
}

export async function sendExternalMessage(m: ExternalMessage): Promise<ExternalResult> {
  const person = await meta
    .selectFrom("workspace_people")
    .select(["id", "name", "email", "phone", "user_id"])
    .where("org_id", "=", m.orgId)
    .where("id", "=", m.personId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!person) return { ok: false, status: "refused", reason: "that person is not on this workspace's People list" };
  const byText = m.via === "text";
  const to = ((byText ? person.phone : person.email) ?? "").trim();
  if (!to) {
    const missing = byText ? "phone number" : "email address";
    await record(m, "", "refused", `no ${missing}`);
    return { ok: false, status: "refused", reason: `${person.name} has no ${missing} on the People list` };
  }
  const refusal = await externalMessagingRefusal(m.orgId, byText ? "text" : "email");
  if (refusal) {
    await record(m, to, "refused", refusal);
    return { ok: false, status: "refused", reason: refusal };
  }
  const stopped = await meta
    .selectFrom("external_message_stops")
    .select("person_id")
    .where("org_id", "=", m.orgId)
    .where("binding_id", "=", m.bindingId)
    .where("person_id", "=", m.personId)
    .executeTakeFirst();
  if (stopped) {
    await record(m, to, "stopped", "they asked to stop these messages");
    return { ok: false, status: "stopped", reason: `${person.name} asked to stop these messages` };
  }
  const settings = await externalMessagesSettings(m.orgId);
  const overWire = (await sentToday(m.orgId, m.bindingId)) >= settings.perWireDailyLimit;
  const overAll = (await sentToday(m.orgId)) >= settings.dailyLimit;
  if (overWire || overAll) {
    const why = overWire ? `this automation reached its limit of ${settings.perWireDailyLimit} a day` : `the workspace reached its limit of ${settings.dailyLimit} a day`;
    await record(m, to, "held", why);
    await tellOwnersHeld(m.orgId, why);
    return { ok: false, status: "held", reason: why };
  }

  const wire = await meta.selectFrom("entity_action_bindings").select(["created_by"]).where("id", "=", m.bindingId).where("org_id", "=", m.orgId).executeTakeFirst();
  const sentBy = wire?.created_by ?? settings.updatedBy;
  if (!sentBy) {
    await record(m, to, "refused", "nobody set it up");
    return { ok: false, status: "refused", reason: "nobody in the workspace is named as having set this automation up" };
  }
  const org = await meta.selectFrom("orgs").select("name").where("id", "=", m.orgId).executeTakeFirst();
  const who = await meta.selectFrom("users").select(["display_name", "email"]).where("id", "=", sentBy).executeTakeFirst();
  const setter = who?.display_name || who?.email || "Someone";
  const stop = absoluteAppUrl(`/m/stop/${stopToken({ o: m.orgId, w: m.bindingId, p: m.personId })}`);
  // The message's own id, known before it is sent, so its reply link can
  // name it (the answer is kept on the message it answers).
  const logId = randomUUID();
  const reply = m.replyLink ? `\n\nGot it, or bought it? Say so here: ${absoluteAppUrl(`/m/reply/${replyToken({ o: m.orgId, l: logId, e: Date.now() + REPLY_LIFETIME_MS }, env.JWT_SECRET)}`)}` : "";
  if (byText) {
    // A text is short, so its footer is: who, where, and the stop link.
    const body = `${m.text}${reply}\n\n-- ${setter}, ${org?.name ?? "their workspace"} (an automation). Stop: ${stop}`;
    const sent = await sendTextFromWorkspace(m.orgId, { to, text: body });
    if (!sent.ok) {
      await record(m, to, "failed", sent.message, null, body, logId);
      return { ok: false, status: "failed", reason: sent.message };
    }
    await record(m, to, "sent", null, null, body, logId);
    return { ok: true, status: "sent", to, name: person.name };
  }
  const text = `${m.text}${reply}\n\n--\nSent by an automation ${setter} set up in ${org?.name ?? "their workspace"}. To stop these messages: ${stop}`;
  const subject = m.record?.title ? `${m.record.title}: a message from ${org?.name ?? "a workspace"}` : `A message from ${org?.name ?? "a workspace"}`;
  const out = await sendFromWorkspace(m.orgId, {
    to,
    subject: subject.slice(0, 200),
    text,
    sentBy,
    ...(m.record ? { source: { kind: m.record.kind, id: m.record.id } } : {}),
  });
  if (!out.ok) {
    await record(m, to, "failed", out.message, out.logId, text, logId);
    return { ok: false, status: "failed", reason: out.message };
  }
  await record(m, to, "sent", null, out.logId, text, logId);
  return { ok: true, status: "sent", to, name: person.name };
}

// ── the reply link (#6070, slice 3b) ─────────────────────────────────────
// Off unless the wire turns it on. A signed, single-purpose, expiring page
// for one message: what it was about and two answers, "Got it" and "Bought
// it", and nothing else of the workspace. The answer is kept on the message,
// once; "Bought it" puts the thing on the workspace's shopping list; the
// member who made the wire is told either way.

export const REPLY_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const REPLIED_EVENT = "platform.external_messages.replied";
export type ReplyAnswer = "got" | "bought";

async function messageOf(claim: ReplyClaim) {
  return meta
    .selectFrom("external_message_log")
    .select(["id", "org_id", "binding_id", "person_id", "record_kind", "record_id", "reply", "status"])
    .where("id", "=", claim.l)
    .where("org_id", "=", claim.o)
    .where("status", "=", "sent")
    .executeTakeFirst();
}

async function itemTitle(orgId: string, kind: string | null, id: string | null): Promise<{ title: string | null; detailUrl: string | null }> {
  if (!kind || !id) return { title: null, detailUrl: null };
  const { lookup } = await import("./entities.js");
  const r = await lookup(orgId, kind, id).catch(() => null);
  return { title: r?.title ?? null, detailUrl: r?.detailUrl ?? null };
}

/** What the reply page shows: the workspace's name, the item, and the answer
 *  already given. Nothing else of the workspace. */
export async function readReply(token: string): Promise<{ ok: true; workspace: string; item: string | null; answered: ReplyAnswer | null } | { ok: false; why: "bad" | "expired" }> {
  const claim = readReplyToken(token, env.JWT_SECRET);
  if (claim === "bad" || claim === "expired") return { ok: false, why: claim };
  const msg = await messageOf(claim);
  if (!msg) return { ok: false, why: "bad" };
  const org = await meta.selectFrom("orgs").select("name").where("id", "=", claim.o).executeTakeFirst();
  const item = await itemTitle(claim.o, msg.record_kind, msg.record_id);
  return { ok: true, workspace: org?.name ?? "A workspace", item: item.title, answered: msg.reply === "got" || msg.reply === "bought" ? msg.reply : null };
}

/** Keep the answer, once. "Bought it" puts the thing on the shopping list;
 *  the wire's maker is told. A second press changes nothing. */
export async function answerReply(token: string, answer: ReplyAnswer): Promise<{ ok: true; answered: ReplyAnswer; listed: boolean } | { ok: false; why: "bad" | "expired" }> {
  const claim = readReplyToken(token, env.JWT_SECRET);
  if (claim === "bad" || claim === "expired") return { ok: false, why: claim };
  const msg = await messageOf(claim);
  if (!msg) return { ok: false, why: "bad" };
  if (msg.reply === "got" || msg.reply === "bought") return { ok: true, answered: msg.reply, listed: false };
  const set = await meta
    .updateTable("external_message_log")
    .set({ reply: answer, replied_at: new Date() })
    .where("id", "=", msg.id)
    .where("reply", "is", null)
    .executeTakeFirst();
  if (Number(set.numUpdatedRows ?? 0n) === 0) {
    const now = await messageOf(claim);
    return { ok: true, answered: (now?.reply as ReplyAnswer) ?? answer, listed: false };
  }
  const person = msg.person_id ? await meta.selectFrom("workspace_people").select("name").where("id", "=", msg.person_id).executeTakeFirst() : null;
  const who = person?.name ?? "Someone";
  const item = await itemTitle(claim.o, msg.record_kind, msg.record_id);
  const wire = msg.binding_id ? await meta.selectFrom("entity_action_bindings").select("created_by").where("id", "=", msg.binding_id).executeTakeFirst() : null;
  const maker = wire?.created_by ?? (await externalMessagesSettings(claim.o)).updatedBy;
  let listed = false;
  if (answer === "bought" && msg.record_kind && msg.record_id && maker) {
    const { invoke } = await import("./actions.js");
    const r = (await invoke("lists:add-item", {
      orgId: claim.o,
      userId: maker,
      entity: { kind: msg.record_kind, id: msg.record_id },
      event: { name: null, payload: {}, actor: { user_id: maker, display_name: who } as never, timestamp: new Date().toISOString(), trigger_type: "event" },
      args: { listTitle: "Shopping list", note: `${who} bought it` },
    }).catch((err: unknown) => {
      console.error(`[external-messages] could not put ${msg.record_id} on the shopping list:`, (err as Error).message);
      return null;
    })) as { ok?: boolean } | null;
    listed = r?.ok === true;
  }
  if (maker) {
    const said = answer === "bought" ? `${who} bought ${item.title ?? "it"}${listed ? "; it is on the shopping list" : ""}.` : `${who} got your message about ${item.title ?? "it"}.`;
    await platform()
      .notifications.dispatch({
        orgId: claim.o,
        userId: maker,
        eventType: REPLIED_EVENT,
        message: said,
        ...(item.detailUrl ? { link_url: item.detailUrl } : { no_link_reason: "the message was about no record, or one that is gone" }),
      })
      .catch((err: unknown) => console.error(`[external-messages] could not tell ${maker} about a reply:`, (err as Error).message));
  }
  return { ok: true, answered: answer, listed };
}
