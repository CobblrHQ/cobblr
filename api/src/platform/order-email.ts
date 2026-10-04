import { createHash } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { bestReceiptBody } from "./inbound-email-body.js";
import { verifyReceiptToken } from "./receipt-email.js";
import type { InboundPayload } from "./inbound-archive.js";

export function orderEmailToken(to: string | string[] | undefined): string | null {
  for (const address of Array.isArray(to) ? to : to ? [to] : []) {
    const token = address.match(/orders\+([^@>\s]+)@/i)?.[1];
    if (token) return token;
  }
  return null;
}
export async function ingestOrderEmail(payload: InboundPayload, token: string) {
  const who = verifyReceiptToken(token);
  if (!who) return { status: 200, body: { ignored: true, reason: "bad_token" } };
  const membership = await meta.selectFrom("org_memberships").select("org_id").where("org_id", "=", who.orgId).where("user_id", "=", who.userId).executeTakeFirst();
  if (!membership) return { status: 200, body: { ignored: true, reason: "not_a_member" } };
  const text = bestReceiptBody(payload.text, payload.html).slice(0, 20000);
  const args = { text, subject: payload.subject || "", ref: payload.message_id?.trim() || createHash("sha256").update(JSON.stringify([payload.subject, payload.from_email, text])).digest("hex"), ...(payload.from_email ? { from_email: payload.from_email } : {}) };
  const result = await platform().actions.invoke("sales:read-order-email", { orgId: who.orgId, userId: who.userId, args, event: { name: "sales.order-email", payload: {}, timestamp: new Date().toISOString(), trigger_type: "event", actor: { user_id: who.userId, display_name: null, auth_method: "system" } } });
  const answer = result as unknown as Record<string, unknown>;
  const body = { ...answer, status: !answer.ok ? "degraded" : answer.ignored ? "nothing_to_import" : answer.duplicate ? "duplicate" : "imported" };
  return { status: answer.ok ? 200 : 422, body, orgId: who.orgId, userId: who.userId };
}
