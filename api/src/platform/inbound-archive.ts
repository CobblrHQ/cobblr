// Durable archive for the inbound-email seam. Every message is persisted RAW
// before it is processed, so a message we couldn't handle (a body-only receipt,
// a transient parser failure, a bug we later fix) is replayable from the backend
// — never lost with the only copy in the sender's mailbox. A user sends an email
// once; reprocessing it is our job, not theirs.
//
// Written at cobblr_meta level because the dispatcher is platform-level: the To
// token resolves the tenant, so org_id/user_id are recorded once known and stay
// null for a message we couldn't attribute (which is exactly the kind worth
// keeping — we can still inspect and replay it).

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { trimForArchive, type InboundAttachment, type InboundPayload } from "./inbound-archive-shape.js";

export type { InboundAttachment, InboundPayload } from "./inbound-archive-shape.js";

export interface InboundOutcome {
  handler?: string | null;
  org_id?: string | null;
  user_id?: string | null;
  outcome?: Record<string, unknown> | null;
}

/** Persist an inbound message and return its archive id. Best-effort: a failure
 *  here must NOT block delivery — the caller logs and proceeds unarchived. */
export async function archiveInboundEmail(p: InboundPayload): Promise<string | null> {
  try {
    const attachments = trimForArchive(p.attachments ?? []);
    const row = await meta
      .insertInto("inbound_emails")
      .values({
        to_addr: Array.isArray(p.to) ? p.to.join(", ") : (p.to ?? null),
        from_email: p.from_email ?? null,
        text_body: p.text ?? null,
        html_body: p.html ?? null,
        subject: p.subject ?? null,
        message_id: p.message_id ?? null,
        attachments: sql`${JSON.stringify(attachments)}::jsonb`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  } catch {
    return null;
  }
}

/** Record how a dispatch attempt resolved, on the archived row. */
export async function recordInboundOutcome(id: string, o: InboundOutcome): Promise<void> {
  try {
    await meta
      .updateTable("inbound_emails")
      .set({
        handler: o.handler ?? null,
        org_id: o.org_id ?? null,
        user_id: o.user_id ?? null,
        outcome: o.outcome ? sql`${JSON.stringify(o.outcome)}::jsonb` : null,
        processed_at: new Date(),
        attempts: sql`attempts + 1`,
      })
      .where("id", "=", id)
      .execute();
  } catch {
    // A bookkeeping failure must never surface to the sender.
  }
}

/** Load an archived message's raw payload for replay. */
export async function getInboundPayload(id: string): Promise<InboundPayload | null> {
  const row = await meta
    .selectFrom("inbound_emails")
    .select(["to_addr", "from_email", "text_body", "html_body", "subject", "message_id", "attachments"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    to: row.to_addr ?? undefined,
    from_email: row.from_email ?? undefined,
    text: row.text_body ?? undefined,
    html: row.html_body ?? undefined,
    subject: row.subject ?? undefined,
    message_id: row.message_id ?? undefined,
    attachments: (row.attachments as InboundAttachment[]).filter((a) => a.content_base64),
  };
}

/** The reprocess work-list: archived messages that landed nothing yet — never
 *  processed at all, or a RECEIPT that produced zero items. Deliberately excludes
 *  a *processed* feedback reply: replaying one would double-append it to the
 *  thread, and its "nothing" isn't an item_count. (A failed feedback reply is
 *  unprocessed → still listed; a genuinely-stuck one can be replayed by id.)
 *  Newest first, bounded. */
export async function listReprocessable(limit = 50): Promise<Array<{ id: string; received_at: Date; from_email: string | null; handler: string | null }>> {
  return meta
    .selectFrom("inbound_emails")
    .select(["id", "received_at", "from_email", "handler"])
    .where((eb) =>
      eb.or([
        eb("processed_at", "is", null),
        eb.and([eb("handler", "=", "receipt"), eb(sql`coalesce(outcome->>'item_count', '0')`, "=", "0")]),
      ]),
    )
    .orderBy("received_at", "desc")
    .limit(limit)
    .execute();
}
