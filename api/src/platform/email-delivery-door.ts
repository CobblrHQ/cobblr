// A way to deliver a recorded email to a workspace on a staging or harness
// stack, through the same ingest the Email Worker feeds.
//
// Order emails are the most-used way things enter Cobblr, and they could not
// be walked anywhere but production: the Worker is Cloudflare glue, and the
// receipts+ address that routes a message needs the operator's secret, which
// no staging stack has. This door takes a raw .eml from a signed-in member,
// parses it, builds the payload with the Worker's own mapping
// (packages/platform-contract/src/inbound-email-payload.ts), archives it and
// dispatches it through dispatchInbound, the function the real
// /inbound-email route calls. The only step it replaces is the address: the
// receipts+ token that names the person and workspace is the signed-in
// member, with the same membership check ingest makes for any message.
//
// COBBLR_EMAIL_DELIVERY_DOOR=true switches it on. The image runs
// NODE_ENV=production on staging too, so the refusal cannot be "production".
// A node that receives real mail has an inbound secret, and a public node
// keeps its request guard; either one refuses to boot with the door on.

import PostalMime from "postal-mime";
import { payloadFromParsedEmail, type InboundPayloadOut } from "@cobblr/platform-contract/inbound-email-payload";

export function emailDeliveryDoorOn(e: NodeJS.ProcessEnv): boolean {
  const flag = e.COBBLR_EMAIL_DELIVERY_DOOR;
  if (flag !== undefined && flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error(`COBBLR_EMAIL_DELIVERY_DOOR must be true or false, not ${JSON.stringify(flag)}`);
  }
  if (flag !== "true") return false;
  if (e.COBBLR_INBOUND_EMAIL_SECRET) {
    throw new Error("COBBLR_EMAIL_DELIVERY_DOOR must never be set on a node that receives real mail (COBBLR_INBOUND_EMAIL_SECRET is set): it files any email a member sends it");
  }
  if (e.NODE_ENV === "production" && e.COBBLR_RATELIMIT !== "off") {
    throw new Error("COBBLR_EMAIL_DELIVERY_DOOR must never be set on a public node (its request guard is on): only a tailnet-only staging stack or a harness stack may take it");
  }
  return true;
}

export const EMAIL_DELIVERY_DOOR = emailDeliveryDoorOn(process.env);

/** A raw .eml, read the way the Worker reads one. Null when it has nothing the
 *  Worker would pass on. `to` is the envelope recipient the payload carries;
 *  routing here is by the signed-in member. */
export async function payloadFromEml(eml: Uint8Array, to: string): Promise<InboundPayloadOut | null> {
  const parsed = await PostalMime.parse(eml);
  // The Worker's envelope sender is the From a store's own mail was sent with
  // (or the person who forwarded it); here, the message's own From.
  return payloadFromParsedEmail(parsed, { to, from: parsed.from?.address ?? "" });
}
