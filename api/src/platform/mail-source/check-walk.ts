// The mailbox check's walk (#5462), kept apart from the runner so a test
// can run it with no database: one page of the candidate query, each message
// read and decided. It has no door to the receipt pipeline and none to a
// model; an email nothing decides is reported "ask-ai" and left there.

import { classifyMail, type MailDecision } from "./classify.js";
import type { MailMessage } from "./types.js";

/** Gmail's own purchases category, or a subject that reads like an order or
 *  a parcel. Promotions are left out: a sale is not an order. */
export const CANDIDATE_QUERY = '(category:purchases OR subject:(order OR shipped OR shipment OR "on the way" OR delivered OR receipt OR invoice OR tracking)) -category:promotions';

/** The query for a range: Gmail's after:/before: take a date. */
export function candidateQuery(range: { after?: string | null; before?: string | null } = {}): string {
  const day = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, "/") : null);
  return [CANDIDATE_QUERY, day(range.after) ? `after:${day(range.after)}` : "", day(range.before) ? `before:${day(range.before)}` : ""].filter(Boolean).join(" ");
}

export function senderDomain(address: string | null | undefined): string | null {
  const a = (address ?? "").toLowerCase();
  const at = a.lastIndexOf("@");
  return at >= 0 ? a.slice(at + 1) || null : null;
}

export interface CheckedMessage {
  gmail_id: string;
  received_at: Date | null;
  sender: string | null;
  sender_domain: string | null;
  subject: string | null;
  purchases_label: boolean;
  decision: MailDecision;
}

export interface CheckSource {
  list(query: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  fetch(id: string): Promise<MailMessage | null>;
}

/** One page: list, read, decide. Pure apart from the source it is handed. */
export async function checkPage(deps: {
  source: CheckSource;
  query: string;
  pageToken?: string | null;
  remembered: (domain: string) => "order" | "not-order" | null;
  now?: Date;
}): Promise<{ messages: CheckedMessage[]; nextPageToken: string | null }> {
  const page = await deps.source.list(deps.query, deps.pageToken ?? undefined);
  const messages: CheckedMessage[] = [];
  for (const id of page.ids) {
    const m = await deps.source.fetch(id);
    if (!m) continue;
    const domain = senderDomain(m.from_email);
    const decision = classifyMail(
      { from_email: m.from_email ?? null, subject: m.subject ?? null, text: m.text ?? null, html: m.html ?? null, labels: m.labels ?? [] },
      domain ? deps.remembered(domain) : null,
      deps.now,
    );
    messages.push({
      gmail_id: id,
      received_at: m.received_at ?? null,
      sender: m.from_email ?? null,
      sender_domain: domain,
      subject: m.subject?.slice(0, 300) ?? null,
      purchases_label: (m.labels ?? []).includes("CATEGORY_PURCHASES"),
      decision,
    });
  }
  return { messages, nextPageToken: page.nextPageToken ?? null };
}

