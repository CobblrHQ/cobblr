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

import { findOrderPageLink, withoutSignInLinks } from "@cobblr/platform-contract/order-page-link";
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
        // A store's "View order" link signs its buyer in (#5461): the archive
        // keeps the email without it, and the ingest hands it to Purchases sealed.
        text_body: p.text == null ? null : withoutSignInLinks(p.text, findOrderPageLink(p.html, p.from_email)),
        html_body: p.html == null ? null : withoutSignInLinks(p.html, findOrderPageLink(p.html, p.from_email)),
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

/** The ENVELOPE of a message read from a person's own mailbox: who sent it,
 *  what it was called, when, and its id at the source. No body, by the shape
 *  of the argument: a mailbox door keeps nothing Google would call restricted
 *  data on this side, and a replay re-fetches the message by `source_ref`
 *  from the mailbox where it still is. The forwarding door's raw archive
 *  above exists because a forwarded copy has nowhere else to be fetched
 *  from; a mailbox read has. */
export interface InboundEnvelope {
  source: string;
  source_ref: string;
  from_email?: string;
  subject?: string;
  message_id?: string;
  org_id?: string | null;
  user_id?: string | null;
}

export async function archiveInboundEnvelope(e: InboundEnvelope): Promise<string | null> {
  try {
    const row = await meta
      .insertInto("inbound_emails")
      .values({
        to_addr: null,
        from_email: e.from_email ?? null,
        text_body: null,
        html_body: null,
        subject: e.subject ?? null,
        message_id: e.message_id ?? null,
        attachments: sql`'[]'::jsonb`,
        source: e.source,
        source_ref: e.source_ref,
        org_id: e.org_id ?? null,
        user_id: e.user_id ?? null,
        handler: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  } catch {
    return null;
  }
}

/** Whether a message from this source was already read: the archive is the
 *  memory that makes a cursor overlap safe, and a replay of an old id a no-op. */
export async function inboundSourceSeen(source: string, sourceRef: string): Promise<boolean> {
  const row = await meta
    .selectFrom("inbound_emails")
    .select("id")
    .where("source", "=", source)
    .where("source_ref", "=", sourceRef)
    .executeTakeFirst();
  return Boolean(row);
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

/** Where an archived message came from, when it was READ rather than sent:
 *  the replay re-fetches it there instead of finding an empty body here. */
export async function getInboundSourceRef(id: string): Promise<{ source: string; source_ref: string; user_id: string | null; org_id: string | null } | null> {
  const row = await meta
    .selectFrom("inbound_emails")
    .select(["source", "source_ref", "user_id", "org_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row?.source || !row.source_ref) return null;
  return { source: row.source, source_ref: row.source_ref, user_id: row.user_id, org_id: row.org_id };
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

/** The reprocess work-list: messages a replay could still do something for.
 *
 *  It used to mean "a RECEIPT that produced zero items", which conflates three
 *  unrelated situations behind one number: a parse that failed for want of a
 *  capability (worth replaying once it exists), a message with no receipt in it
 *  (a replay does the same thing forever), and a duplicate that was right to
 *  import nothing. Two of those are finished work, so the list showed items
 *  needing no action — and a list that cries wolf is one nobody reads, which
 *  matters because this IS the recovery path for a dead-lettered receipt.
 *
 *  So it now reads the outcome's own `status` (see outcomeStatus). Rows written
 *  BEFORE that existed have no status and keep exactly today's behaviour, so
 *  nothing needs backfilling and no judgment is made about the past; they age
 *  out on their own.
 *
 *  Still excludes a *processed* feedback reply: replaying one would
 *  double-append it to the thread, and its "nothing" isn't an item_count. (A
 *  failed feedback reply is unprocessed → still listed.) Newest first, bounded. */
export async function listReprocessable(limit = 50): Promise<Array<{ id: string; received_at: Date; from_email: string | null; handler: string | null }>> {
  return meta
    .selectFrom("inbound_emails")
    .select(["id", "received_at", "from_email", "handler"])
    .where((eb) =>
      eb.or([
        eb("processed_at", "is", null),
        // Said explicitly by the dispatcher.
        eb(sql`outcome->>'status'`, "=", "degraded"),
        // Legacy rows: no status was recorded, so fall back to the old rule
        // rather than guess. Parenthesised deliberately — an unparenthesised OR
        // inside a chained builder escapes the ANDs around it, which is exactly
        // how the duplicate check broke (see scripts/lint-sql-or-precedence.ts).
        eb.and([
          eb(sql`outcome->>'status'`, "is", null),
          eb("handler", "=", "receipt"),
          eb(sql`coalesce(outcome->>'item_count', '0')`, "=", "0"),
        ]),
      ]),
    )
    .orderBy("received_at", "desc")
    .limit(limit)
    .execute();
}
